# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""HTTP surface of the analysis worker.

Plain FastAPI on port 8080. The container is not addressable from the
internet: a Durable Object holds the only route to it, and the DO holds the
R2 binding. So THE CONTAINER NEVER HOLDS A CREDENTIAL — no presigned URL, no
bearer token, no S3 key. Bytes arrive over ``PUT /file/{id}``; derived
artifacts leave over ``GET /artifact/{id}/{name}``; the DO does every R2
read and write itself.

Four routes, and one rule: ``/analyze`` NEVER raises to the caller. It
returns ``ok=False`` with a reason, because only the queue consumer knows the
retry budget.
"""
import asyncio
import contextlib
import json
import logging
import os
import shutil

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse

from app import (decode, fingerprint, forensics, hashing, key, lametag,
                 loudness, peaks, tags)
from app.beats import analyze_beats
from app.models import AnalyzeRequest, AnalyzeResponse, Forensics

log = logging.getLogger("analysis")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

MAX_DURATION_MS = 15 * 60 * 1000
WORK = os.environ.get("ANALYSIS_WORK_DIR", "/tmp/work")

# One analysis at a time per instance. `--workers 1` already serialises
# uvicorn, but this makes the RSS guarantee explicit: peak is max(stage), about
# 1 GB, and it stays that way only if two files are never in flight together.
# A second caller waits rather than doubling memory on a 3 GiB box.
_lock = asyncio.Lock()


def _cpu_now() -> float:
    """Total CPU seconds burned by this process AND its children.

    ``time.process_time()`` — which the brief used — counts only this
    process. It would have excluded ffmpeg, ffprobe, fpcalc and
    streaming_extractor_music, i.e. every subprocess, which on this workload
    is most of the non-Beat-This cost. Cloudflare bills the whole container,
    so the reported number has to as well. ``os.times()`` returns
    (user, system, children_user, children_system, elapsed); the first four
    summed are the process-tree total.
    """
    t = os.times()
    return t[0] + t[1] + t[2] + t[3]


def _paths(file_id: str) -> tuple[str, str]:
    # basename() on the way in: file_id reaches here from a queue message and
    # is pasted straight into a filesystem path. A '../' would otherwise walk
    # out of the working directory.
    d = os.path.join(WORK, os.path.basename(file_id))
    return d, os.path.join(d, "in.audio")


# streaming_extractor_music picks its metadata reader from the FILE
# EXTENSION, not from the content. Measured on the deployed container: the
# same FLAC exits 0 as `in.flac` and exits 1 as `in.audio`, with
#   MetadataReader: File does not exist or does not seem to be of a supported
#   filetype. metadatautils: pcmMetadata cannot read files which are neither
#   "wav" nor "aiff"
# TagLib refuses the unknown extension, the pcm fallback only knows wav/aiff,
# and the run dies before any audio is read. Bytes arrive over PUT with no
# name, so the extension has to be reattached here — from ffprobe's verdict,
# never from the uploaded filename, which is exactly the sort of claim this
# milestone does not trust.
_EXT_OVERRIDE = {"mov": "m4a", "matroska": "mkv", "asf": "wma"}


def _extension_for(format_name: str) -> str:
    """ffprobe format_name -> a file extension Essentia recognises.

    format_name is a comma-separated list of the demuxers that matched
    ('mov,mp4,m4a,3gp,3g2,mj2'); the first entry is the canonical one, and the
    few whose first entry is not a usable extension are mapped by hand.
    """
    first = format_name.split(",")[0].strip().lower()
    return _EXT_OVERRIDE.get(first, first) or "bin"


def _link_with_extension(src: str, ext: str) -> str:
    """A second name for the same bytes, ending in `.ext`.

    A hard link, not a copy: a 15-minute FLAC is ~150 MB and the container has
    6 GB of disk it must not spend twice. The original name is left in place so
    a retried analysis still finds what PUT wrote.
    """
    link = f"{src}.{ext}"
    if not os.path.exists(link):
        try:
            os.link(src, link)
        except OSError:
            shutil.copyfile(src, link)
    return link


def _declared_kbps(info: dict, stream: dict, duration_ms: int) -> int:
    """The file's own bitrate, in kbps. Zero when it cannot be established.

    Three sources, best first. The AUDIO STREAM's bit_rate is the honest
    number; the FORMAT's includes container overhead and reads a few percent
    high (measured on a real iTunes m4a: 283 kbps format against 256 kbps
    stream), which matters because quality_tier compares it to a 240 kbps
    threshold. Size over decoded duration is the last resort, for the
    containers that declare neither — and it is only ever a floor-setter, so
    a small over-read cannot demote anything.

    This is a fact ABOUT the file, unlike everything else in the forensics
    block, which is measured FROM it. It is used only where the measurement
    has nothing to say — see quality_tier.
    """
    for src in (stream, info.get("format", {})):
        try:
            br = int(src.get("bit_rate") or 0)
        except (TypeError, ValueError):
            br = 0
        if br > 0:
            return br // 1000
    try:
        size = int(info.get("format", {}).get("size") or 0)
    except (TypeError, ValueError):
        size = 0
    if size > 0 and duration_ms > 0:
        return int(size * 8 / (duration_ms / 1000) / 1000)
    return 0


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    """Load the model before the port accepts traffic.

    Deliberate: loading torch plus 77 MB of weights costs about a second of
    CPU. Paying it lazily inside the first ``/analyze`` would fold it into
    that track's ``cpu_seconds`` and make the very number this milestone's
    cost model turns on unreliable.
    """
    os.makedirs(WORK, exist_ok=True)
    try:
        from app import beat_runtime

        t0 = _cpu_now()
        beat_runtime.load()
        log.info("model warm: %s (%.2fs cpu)",
                 beat_runtime.checkpoint_path(), _cpu_now() - t0)
    except Exception as e:  # noqa: BLE001
        # A failed warm-up must not stop the container from serving /healthz —
        # a container that never starts is much harder to diagnose than one
        # that starts and reports the failure on the first analysis.
        log.exception("model warm-up FAILED: %s", e)
    yield


app = FastAPI(title="localchune-analysis", lifespan=lifespan)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "version": os.environ.get("ANALYSIS_VERSION", "dev")}


@app.put("/file/{file_id}")
async def put_file(file_id: str, request: Request) -> dict:
    """Raw audio bytes, streamed in by the Durable Object from its R2 binding.

    Streamed, not read into memory: a 15-minute FLAC is ~150 MB and buffering
    it would eat a sixth of the instance before analysis even starts.
    """
    d, src = _paths(file_id)
    os.makedirs(d, exist_ok=True)
    n = 0
    with open(src, "wb") as fh:
        async for chunk in request.stream():
            fh.write(chunk)
            n += len(chunk)
    return {"ok": True, "bytes": n}


@app.delete("/file/{file_id}")
def delete_file(file_id: str) -> dict:
    shutil.rmtree(_paths(file_id)[0], ignore_errors=True)
    return {"ok": True}


@app.get("/artifact/{file_id}/{name}")
def get_artifact(file_id: str, name: str) -> FileResponse:
    """Derived artifacts — peaks, opus preview, artwork.

    The DO pulls these and writes them to R2 through its binding. There is no
    presigned PUT and no upload credential inside the container.
    """
    d, _ = _paths(file_id)
    p = os.path.join(d, os.path.basename(name))
    if not os.path.isfile(p):
        raise HTTPException(404, "no such artifact")
    return FileResponse(p)


def _analyze_sync(req: AnalyzeRequest) -> AnalyzeResponse:
    """The whole pipeline, blocking. Runs in a worker thread — see /analyze."""
    t0 = _cpu_now()
    d, src = _paths(req.file_id)

    def fail(msg: str, **kw) -> AnalyzeResponse:
        return AnalyzeResponse(
            file_id=req.file_id, analysis_version=req.analysis_version,
            ok=False, error=msg, cpu_seconds=round(_cpu_now() - t0, 2), **kw)

    if not os.path.isfile(src):
        return fail("no_file: PUT /file/{id} first")

    try:
        info = decode.probe(src)
        stream = next(
            (s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
        if stream is None:
            return fail("no_audio_stream")

        pcm, sr = decode.decode_mono(src)
        duration_ms = int(len(pcm) / sr * 1000)   # DECODED. authoritative.
        if duration_ms > MAX_DURATION_MS:
            return fail("too_long", duration_ms=duration_ms)
        if duration_ms == 0:
            return fail("empty_decode")

        container = info["format"]["format_name"].split(",")[0]
        codec = stream.get("codec_name", "")
        # The digest is taken from the name PUT wrote, before `src` is
        # rebound below. Same inode as the hard link, so the bytes and the
        # digest are identical either way — but a reader should not have to
        # prove that to themselves to trust a dedup key.
        raw_src = src
        # Everything downstream runs against the extension-bearing name — not
        # only Essentia, since any other tool that sniffs a suffix gets the
        # right answer for free.
        src = _link_with_extension(src, _extension_for(info["format"]["format_name"]))

        # FORENSICS, WIRED. M3 shipped this block computing cutoff and cliff
        # and then throwing the verdict away, because classify_ancestor()
        # needed an hf_ref_delta_db and Forensics needed a MEASURED effective
        # bit depth, and nothing produced either. Both exist now.
        #
        # measure_spectrum() runs the FFT pass ONCE and cutoff, cliff and the
        # abstain gate are all read off the same spectrum, so the measured
        # cost is unchanged from M3's ~0.5 s.
        wins = decode.windows(src, duration_s=duration_ms / 1000)
        spec = forensics.measure_spectrum(wins, sr)
        cutoff_hz, cliff_db = forensics.cutoff_from_spectrum(spec)
        hf_delta = forensics.hf_ref_delta_db(spec)
        lame = lametag.read_lame_tag(src)
        # effective_bit_depth() reads the DECODER's output precision, and a
        # lossy decoder emits full-precision samples: MEASURED, every MP3
        # here reads 32, at 128 kbps as readily as at 320. There is no 32-bit
        # master behind that number — it is an artifact of the decode — and
        # feeding it to quality_score() hands every lossy file the full
        # 6-point "better than 16-bit" bonus, which is three quarters of the
        # 8-point margin is_upgrade() needs before it will prefer a real
        # FLAC. The measurement only means something where there is a CLAIM
        # to test, i.e. a lossless container. Elsewhere 0 is the honest
        # answer — "no evidence", the same answer digital silence gets — and
        # it scores identically to 16 because quality_score clamps that term
        # at zero.
        lossless = forensics.is_lossless(container, codec)
        eff_bits = forensics.effective_bit_depth(src) if lossless else 0
        declared_sr = int(stream.get("sample_rate", 0) or 0)
        eff_sr = forensics.effective_sample_rate(declared_sr, cutoff_hz)

        ancestor = forensics.classify_ancestor(
            cutoff_hz, cliff_db,
            lame.lowpass_hz if lame else None,
            len(wins), hf_delta)
        declared_kbps = _declared_kbps(info, stream, duration_ms)
        tier = forensics.quality_tier(container, ancestor, cutoff_hz, eff_bits,
                                      codec, cliff_db, declared_kbps)
        # Moved ABOVE the score so its clipped_pct and true_peak can feed it.
        # The same single call, relocated — the loudness pass costs 3.4
        # vCPU-s and running it twice would be visible in the budget.
        loud = loudness.analyze_loudness(src)
        inferred = forensics.CUTOFF_TABLE.get(
            min(forensics.CUTOFF_TABLE, key=lambda t: abs(t - cutoff_hz))) \
            if ancestor in ('confirmed', 'suspected') else None
        lame_disagrees = bool(
            lame and abs(lame.lowpass_hz - cutoff_hz) > 1500)
        score = forensics.quality_score(
            tier=tier, cutoff_hz=cutoff_hz, eff_bits=eff_bits, eff_sr=eff_sr,
            inferred_kbps=inferred or 0, lame_disagrees=lame_disagrees,
            # clipped_pct is a peak-RECURRENCE proxy, not a clip count
            # (M3 Task 6). quality_score() already treats it as a threshold.
            clipped_pct=loud.clipped_pct / 100.0,
            true_peak=loud.true_peak_dbtp,
            mono_vs_stereo=int(stream.get("channels", 2) or 2) < 2,
            decode_errors=False)

        forensics_out = Forensics(
            meas_cutoff_hz=cutoff_hz, meas_cliff_db_500=cliff_db,
            meas_eff_bit_depth=eff_bits, meas_eff_sample_rate=eff_sr,
            lame_tag_present=lame is not None,
            lame_lowpass_hz=lame.lowpass_hz if lame else None,
            lame_vbr_method=lame.vbr_method if lame else None,
            encoder_string=lame.encoder_string if lame else None,
            lossy_ancestor=ancestor, inferred_source_kbps=inferred,
            tier=tier, quality_score=score)
        log.info(
            "forensics file=%s cutoff_hz=%s cliff_db_500=%s hf_ref_delta_db=%s "
            "eff_bits=%s eff_sr=%s lame=%s ancestor=%s tier=%s score=%s windows=%d",
            req.file_id, cutoff_hz, cliff_db, hf_delta, eff_bits, eff_sr,
            lame.lowpass_hz if lame else None, ancestor, tier, score, len(wins))

        with open(os.path.join(d, "peaks.json"), "w") as fh:
            json.dump(peaks.compute_peaks(pcm), fh)
        peaks_key = "peaks.json"

        # Lossless sources only. Re-encoding an MP3 to Opus spends CPU to make
        # a strictly worse copy of an already-lossy file; the original streams
        # as-is instead.
        preview_key = None
        if lossless:
            try:
                loudness.make_preview(src, os.path.join(d, "preview.opus"))
                preview_key = "preview.opus"
            except Exception as e:  # noqa: BLE001
                log.warning("preview failed for %s: %s", req.file_id, e)

        artwork_key = None
        thumb_key = None
        if tags.extract_artwork(src, os.path.join(d, "artwork.jpg")):
            artwork_key = "artwork.jpg"
            # 64px cover-cropped JPEG so the pool table never loads
            # full-size art. Spec: 2026-07-29-ui-brutalist-design.md §4.
            if tags.make_thumb(os.path.join(d, "artwork.jpg"),
                               os.path.join(d, "thumb.jpg")):
                thumb_key = "thumb.jpg"

        return AnalyzeResponse(
            file_id=req.file_id, analysis_version=req.analysis_version, ok=True,
            duration_ms=duration_ms,
            container=container,
            codec=codec,
            sample_rate=int(stream.get("sample_rate", 0) or 0),
            bit_depth=int(stream.get("bits_per_raw_sample")
                          or stream.get("bits_per_sample") or 0),
            channels=int(stream.get("channels", 0) or 0),
            fingerprint=fingerprint.fingerprint(src),
            beats=analyze_beats(pcm, sr),
            key=key.analyze_key(src),
            loudness=loud,
            forensics=forensics_out,
            tags=tags.read_tags(src),
            peaks_key=peaks_key,
            preview_key=preview_key,
            artwork_key=artwork_key,
            thumb_key=thumb_key,
            content_sha256=hashing.content_sha256(raw_src),
            cpu_seconds=round(_cpu_now() - t0, 2),
        )
    except Exception as e:  # noqa: BLE001
        log.exception("analyze failed for %s", req.file_id)
        # subprocess.CalledProcessError stringifies to the exit code and argv
        # and throws the actual diagnosis away. The first real failure on the
        # deployed container reported only "returned non-zero exit status 1",
        # which named the symptom and hid the cause; the binary had written
        # the reason to stderr all along.
        detail = getattr(e, "stderr", None)
        if isinstance(detail, (bytes, bytearray)):
            detail = detail.decode("utf-8", "replace")
        msg = f"{type(e).__name__}: {e}"
        if detail:
            msg += f" | stderr: {detail.strip()[-500:]}"
        return fail(msg)


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    # to_thread, not a straight call: the pipeline blocks for tens of seconds
    # and would otherwise freeze the event loop, so /healthz would time out
    # mid-analysis and the platform would read a busy container as a dead one.
    # The lock still guarantees one analysis at a time, which is what bounds
    # peak RSS.
    async with _lock:
        return await asyncio.to_thread(_analyze_sync, req)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
