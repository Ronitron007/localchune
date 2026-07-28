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

from app import decode, fingerprint, forensics, key, loudness, peaks, tags
from app.beats import analyze_beats
from app.models import AnalyzeRequest, AnalyzeResponse

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

        # Forensic measurement runs and is LOGGED, but no verdict is
        # synthesised: `forensics` stays None in the response. Reason —
        # classify_ancestor() needs `hf_ref_delta_db`, and Forensics needs a
        # MEASURED effective bit depth and sample rate. Nothing in app/
        # produces any of the three. Task 7 recorded that gap and asked
        # Task 8/9 to re-verify once a real caller existed; this is that
        # check, and the answer is that the producers are still missing.
        # Emitting a `tier` and `quality_score` derived from ffprobe's
        # DECLARED bit depth plus a hardcoded 'abstain' would put a
        # fabricated grade in the database wearing the clothes of a
        # measurement. The two genuinely measured numbers are computed and
        # logged, so the CPU figure below stays representative of the real
        # pipeline and the values are observable in `wrangler tail`.
        wins = decode.windows(src, duration_s=duration_ms / 1000)
        cutoff_hz, cliff_db = forensics.measure_cutoff(wins, sr)
        log.info("forensics(unwired) file=%s cutoff_hz=%s cliff_db_500=%s windows=%d",
                 req.file_id, cutoff_hz, cliff_db, len(wins))

        with open(os.path.join(d, "peaks.json"), "w") as fh:
            json.dump(peaks.compute_peaks(pcm), fh)
        peaks_key = "peaks.json"

        # Lossless sources only. Re-encoding an MP3 to Opus spends CPU to make
        # a strictly worse copy of an already-lossy file; the original streams
        # as-is instead.
        preview_key = None
        if container.lower() in forensics.LOSSLESS or codec.lower() in forensics.LOSSLESS:
            try:
                loudness.make_preview(src, os.path.join(d, "preview.opus"))
                preview_key = "preview.opus"
            except Exception as e:  # noqa: BLE001
                log.warning("preview failed for %s: %s", req.file_id, e)

        artwork_key = None
        if tags.extract_artwork(src, os.path.join(d, "artwork.jpg")):
            artwork_key = "artwork.jpg"

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
            loudness=loudness.analyze_loudness(src),
            tags=tags.read_tags(src),
            peaks_key=peaks_key,
            preview_key=preview_key,
            artwork_key=artwork_key,
            cpu_seconds=round(_cpu_now() - t0, 2),
        )
    except Exception as e:  # noqa: BLE001
        log.exception("analyze failed for %s", req.file_id)
        return fail(f"{type(e).__name__}: {e}")


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
