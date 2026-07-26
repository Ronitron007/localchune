# Analysis Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stateless container that takes one audio file and returns key, BPM + beat grid, loudness, waveform peaks, Chromaprint fingerprint, embedded tags, and quality forensics — deployed on Cloud Run, driven by Cloudflare Queues, writing nothing to the database itself.

**Architecture:** One HTTP handler, one file per request, `concurrency=1`, **1 vCPU / 2 GiB**. Each analysis stage runs as a **sequential subprocess** so peak RSS is `max(stage)` ≈ 1 GB rather than the sum — which is also what §7.3 of the PRD requires for Essentia's AGPL arm's-length position. The worker holds **no R2 credentials and no Supabase key**: it receives presigned URLs and returns JSON, so a failed run mutates nothing and retries are trivially safe.

**Tech Stack:** Python 3.12, FastAPI + uvicorn, ffmpeg (LGPL build), `fpcalc` (Chromaprint), Essentia (subprocess, DSP only), Beat This! via ONNX Runtime, NumPy, `flaccheck`, `mp3guessenc`. Docker → Artifact Registry → Cloud Run.

## Global Constraints

- **`torch.set_num_threads(1)` / `onnxruntime` intra-op threads = 1.** Measured: Beat This! is 13.2 s CPU at 1 thread and **19.5 s CPU at 8 threads** for identical work. Cloud Run bills vCPU-seconds, so threading costs 48% more. This is a background job — nobody is watching the wall clock.
- **BPM is a least-squares fit over the beat index, never the median inter-beat interval.** Measured: median-IBI reports 130.43 on a 128.000 track and 176.47 on a 174.000 track; the fit gives both exactly. Beat This! quantises to a ~20 ms frame grid and the median inherits it.
- **`duration_ms` comes from decoding, never from container metadata.** VBR MP3s without a Xing header report wildly wrong durations, and a wrong duration silently breaks the dedup ±10 s candidate gate in a way that produces no error and no alert.
- **Ship zero `.pb` files.** No Essentia model-zoo downloads in the Dockerfile — the zoo is CC BY-NC-SA (or -ND; MTG's own pages disagree). Everything needed is DSP.
- **Build Essentia without FFTW** (KissFFT). FFTW is GPL and UPF cannot sublicense it.
- **Invoke Essentia as `streaming_extractor_music`, never `import essentia`.** Preserves the mere-aggregation position. Guard in review.
- Build ffmpeg (or select a build) with `--disable-gpl --disable-nonfree`. Distro builds are usually `--enable-gpl`, which makes the *binary* GPL.
- Every response carries `analysis_version`. Bump it to force reprocessing; never delete rows to force it.
- The handler must be **idempotent** — Cloudflare Queues is at-least-once.

## Measured budget this plan must hit

Apple M1, 6:00 44.1 kHz stereo. x86 Cloud Run ≈ 1.75×.

| Stage | CPU | Peak RSS |
|---|---|---|
| `fpcalc` raw fingerprint | 0.39 s | small |
| decode → f32 mono | 0.46 s (FLAC) / 0.77 s (MP3) | — |
| **Beat This! @ 1 thread (PyTorch)** | **13.2 s** | **977 MB** |
| Essentia key × 3 profiles | ~0.6 s | ~470 MB |
| `ebur128` | 2.16 s | — |
| `astats` | 1.24 s | — |
| forensics 8 × 10 s windows | 0.31 s | — |
| FFT + cutoff | ~0.5 s | ~200 MB |
| waveform peaks | <0.01 s | — |
| Opus preview (lossless only) | 3.33 s | — |
| **Total** | **~20 s** | **~1 GB** |

**Beat This! is 65% of the budget.** Task 2 exists to attack that before anything else is built on it.

---

## File Structure

| Path | Responsibility |
|---|---|
| `worker/Dockerfile` | Debian slim + ffmpeg + fpcalc + essentia + onnxruntime |
| `worker/pyproject.toml` | Pinned deps |
| `worker/app/main.py` | FastAPI app, `POST /analyze`, health check |
| `worker/app/models.py` | Pydantic request/response schemas — the contract with the Worker |
| `worker/app/decode.py` | ffmpeg wrappers: decode, probe, windows, opus, spectrogram |
| `worker/app/fingerprint.py` | `fpcalc` → raw ints + `query_items` |
| `worker/app/beats.py` | Beat This! ONNX inference + **least-squares BPM** |
| `worker/app/key.py` | Essentia subprocess + Camelot mapping |
| `worker/app/loudness.py` | ebur128 + astats parsing |
| `worker/app/peaks.py` | min/max buckets |
| `worker/app/forensics.py` | spectral cutoff, cliff, bit depth, LAME tag, tier + score |
| `worker/app/tags.py` | embedded tags + cover art |
| `worker/tests/…` | pytest, one file per module |
| `worker/bench/benchmark.py` | Task 2's harness — kept, not deleted |
| `src/workers/analyze-consumer.ts` | Cloudflare Queue consumer: presign, call, persist |
| `supabase/migrations/…_analysis.sql` | `audio_analysis`, `fingerprints`, `ingest_jobs` |

---

### Task 1: Contract and skeleton

Define the JSON contract first. Every later task fills in one field group, and the Cloudflare Worker is written against this without waiting.

**Files:**
- Create: `worker/pyproject.toml`, `worker/app/models.py`, `worker/app/main.py`, `worker/tests/test_contract.py`

**Interfaces:**
- Produces: `AnalyzeRequest`, `AnalyzeResponse` — consumed by Task 9's Cloudflare Worker and every worker module.

- [ ] **Step 1: Write `worker/app/models.py`**

```python
from typing import Literal, Optional
from pydantic import BaseModel, Field

class AnalyzeRequest(BaseModel):
    file_id: str
    get_url: str                      # presigned R2 GET, short TTL
    put_prefix_url: Optional[str] = None   # presigned PUT base for derived artifacts
    container_hint: Optional[str] = None
    analysis_version: str

class Fingerprint(BaseModel):
    algo_version: str
    duration_s: int
    frame_count: int
    fp_compressed_b64: str
    fp_sha256: str
    query_items: list[int]

class Beats(BaseModel):
    bpm: float                        # least-squares fit, NOT median IBI
    bpm_median_ibi: float             # kept for comparison; do not display
    beat_count: int
    ibi_std_ms: float
    beat_grid: list[float]
    downbeat_grid: list[float]
    confidence: float

class Key(BaseModel):
    key: str
    scale: Literal['major', 'minor']
    camelot: str
    open_key: str
    strength: float
    alt_profiles: dict[str, str]

class Loudness(BaseModel):
    integrated_lufs: float
    lra_lu: float
    true_peak_dbtp: float
    replaygain_db: float
    clipped_pct: float

class Forensics(BaseModel):
    meas_cutoff_hz: int
    meas_cliff_db_500: float
    meas_eff_bit_depth: int
    meas_eff_sample_rate: int
    lame_tag_present: bool
    lame_lowpass_hz: Optional[int] = None
    lame_vbr_method: Optional[str] = None
    encoder_string: Optional[str] = None
    lossy_ancestor: Literal['none', 'suspected', 'confirmed', 'abstain']
    inferred_source_kbps: Optional[int] = None
    tier: int = Field(ge=1, le=5)
    quality_score: float
    spectrogram_key: Optional[str] = None   # only written on a suspect verdict

class AnalyzeResponse(BaseModel):
    file_id: str
    analysis_version: str
    ok: bool
    error: Optional[str] = None
    duration_ms: int = 0              # DECODED, authoritative
    container: str = ''
    codec: str = ''
    sample_rate: int = 0
    bit_depth: int = 0
    channels: int = 0
    fingerprint: Optional[Fingerprint] = None
    beats: Optional[Beats] = None
    key: Optional[Key] = None
    loudness: Optional[Loudness] = None
    forensics: Optional[Forensics] = None
    tags: dict = {}
    peaks_key: Optional[str] = None
    preview_key: Optional[str] = None
    artwork_key: Optional[str] = None
    cpu_seconds: float = 0.0
```

- [ ] **Step 2: Write the failing contract test**

```python
# worker/tests/test_contract.py
from app.models import AnalyzeResponse

def test_response_serialises_with_only_required_fields():
    r = AnalyzeResponse(file_id="f1", analysis_version="v1", ok=False, error="boom")
    d = r.model_dump()
    assert d["ok"] is False
    assert d["duration_ms"] == 0
    assert d["fingerprint"] is None

def test_tier_is_bounded():
    from pydantic import ValidationError
    from app.models import Forensics
    import pytest
    with pytest.raises(ValidationError):
        Forensics(meas_cutoff_hz=1, meas_cliff_db_500=1, meas_eff_bit_depth=16,
                  meas_eff_sample_rate=44100, lame_tag_present=False,
                  lossy_ancestor='none', tier=9, quality_score=1)
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `cd worker && python -m pytest tests/test_contract.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app'` until `pyproject.toml` sets the package path

- [ ] **Step 4: Write `worker/pyproject.toml`**

```toml
[project]
name = "localchune-analysis"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115", "uvicorn[standard]>=0.32", "pydantic>=2.9",
  "numpy>=2.1", "soundfile>=0.12", "onnxruntime>=1.20", "httpx>=0.27",
]
[project.optional-dependencies]
bench = ["torch>=2.5", "beat_this @ git+https://github.com/CPJKU/beat_this.git"]
dev = ["pytest>=8.3", "pytest-asyncio>=0.24"]

[tool.pytest.ini_options]
pythonpath = ["."]
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `cd worker && pip install -e ".[dev]" && python -m pytest tests/test_contract.py -v`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add worker/pyproject.toml worker/app/models.py worker/tests/test_contract.py
git commit -m "feat(worker): analysis request/response contract"
```

---

### Task 2: Benchmark Beat This! — PyTorch vs ONNX

**This is deliberately the first real task.** 65% of the compute budget and most of the container size ride on the answer. Building the pipeline first and optimising later would mean rebuilding it.

**Files:**
- Create: `worker/bench/benchmark.py`, `worker/bench/README.md`, `worker/bench/export_onnx.py`

**Interfaces:**
- Produces: a decision recorded in `worker/bench/README.md` — PyTorch or ONNX — plus `worker/models/beat_this.onnx` if ONNX wins.

- [ ] **Step 1: Generate reproducible test fixtures**

Synthetic, so no copyrighted audio enters the repo. `.gitignore` the `.wav`/`.flac` outputs.

```python
# worker/bench/make_fixtures.py
import math, struct, wave

def render(path: str, bpm: float, dur: float = 360.0, sr: int = 44100) -> None:
    spb = 60.0 / bpm
    n = int(dur * sr)
    buf = [0.0] * n
    for i in range(int(dur / spb)):                       # kick
        st = int(i * spb * sr)
        for j in range(int(0.12 * sr)):
            if st + j >= n: break
            e = math.exp(-j / (0.035 * sr))
            f = 110 * math.exp(-j / (0.012 * sr)) + 45
            buf[st + j] += 0.9 * e * math.sin(2 * math.pi * f * j / sr)
    for i in range(int(dur / (spb / 2))):                 # offbeat hat
        st = int((i * spb / 2 + spb / 2) * sr)
        for j in range(int(0.04 * sr)):
            if st + j >= n: break
            e = math.exp(-j / (0.008 * sr))
            buf[st + j] += 0.25 * e * ((j * 2654435761) % 1000 / 500.0 - 1)
    for i in range(n):                                    # bass
        buf[i] += 0.12 * math.sin(2 * math.pi * (55 if (i // (sr * 2)) % 2 == 0 else 65) * i / sr)
    w = wave.open(path, 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b''.join(
        struct.pack('<hh', *(int(max(-1, min(1, s)) * 30000),) * 2) for s in buf))
    w.close()

if __name__ == '__main__':
    for bpm in (128, 174):
        render(f'fixtures/beat{bpm}.wav', bpm)
```

- [ ] **Step 2: Write the benchmark harness**

```python
# worker/bench/benchmark.py
import os, sys, time, resource, numpy as np

def lsq_bpm(beats: np.ndarray) -> float:
    k = np.arange(len(beats))
    A = np.vstack([k, np.ones_like(k)]).T
    slope, _ = np.linalg.lstsq(A, beats, rcond=None)[0]
    return 60.0 / slope

def bench_torch(paths):
    import torch
    torch.set_num_threads(1)
    from beat_this.inference import File2Beats
    t = time.perf_counter()
    f2b = File2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    load = time.perf_counter() - t
    out = []
    for p in paths:
        c0 = time.process_time(); w0 = time.perf_counter()
        beats, downbeats = f2b(p)
        out.append(dict(path=p, cpu=time.process_time() - c0,
                        wall=time.perf_counter() - w0,
                        rss_mb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6,
                        beats=len(beats),
                        bpm_lsq=lsq_bpm(np.asarray(beats)),
                        bpm_median=60.0 / np.median(np.diff(beats))))
    return load, out

if __name__ == '__main__':
    paths = ['fixtures/beat128.wav', 'fixtures/beat174.wav']
    load, rows = bench_torch(paths)
    print(f"torch load={load:.2f}s")
    for r in rows:
        print(f"  {r['path']}: cpu={r['cpu']:.2f}s wall={r['wall']:.2f}s "
              f"rss={r['rss_mb']:.0f}MB beats={r['beats']} "
              f"lsq={r['bpm_lsq']:.3f} median={r['bpm_median']:.2f}")
```

- [ ] **Step 3: Establish the PyTorch baseline**

Run: `cd worker/bench && python make_fixtures.py && python benchmark.py`

Expected, matching the measurements already taken on M1 (x86 will be slower — record what you actually get):
```
torch load=0.34s
  fixtures/beat128.wav: cpu=13.26s wall=13.19s rss=944MB beats=769 lsq=128.000 median=130.43
  fixtures/beat174.wav: cpu=12.96s wall=12.88s rss=977MB beats=1045 lsq=174.000 median=176.47
```

**Assert two things before continuing.** `lsq` must be within 0.01 of the true BPM while `median` is 1–2% off — that is the justification for the least-squares constraint. And record `rss`, because it sets the instance memory.

- [ ] **Step 4: Export to ONNX**

```python
# worker/bench/export_onnx.py
import torch
from beat_this.inference import load_model

model = load_model("final0", device="cpu").eval()
# Beat This! consumes a log-mel spectrogram: (batch, frames, 128 mels)
dummy = torch.randn(1, 1500, 128)
torch.onnx.export(
    model, dummy, "../models/beat_this.onnx",
    input_names=["spect"], output_names=["beat", "downbeat"],
    dynamic_axes={"spect": {0: "batch", 1: "frames"},
                  "beat": {0: "batch", 1: "frames"},
                  "downbeat": {0: "batch", 1: "frames"}},
    opset_version=17,
)
print("exported")
```

- [ ] **Step 5: Benchmark ONNX and compare**

Add to `benchmark.py`:

```python
def bench_onnx(spects):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    t = time.perf_counter()
    sess = ort.InferenceSession("../models/beat_this.onnx", so, providers=["CPUExecutionProvider"])
    load = time.perf_counter() - t
    out = []
    for name, spect in spects:
        c0 = time.process_time(); w0 = time.perf_counter()
        beat, downbeat = sess.run(None, {"spect": spect})
        out.append(dict(name=name, cpu=time.process_time() - c0,
                        wall=time.perf_counter() - w0,
                        rss_mb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6))
    return load, out
```

Run both and record a table in `worker/bench/README.md`:

| Runtime | CPU/track | Peak RSS | Image size | Beat count matches torch? |
|---|---|---|---|---|
| PyTorch eager, 1 thread | | | | baseline |
| ONNX Runtime, 1 thread | | | | must be identical |

- [ ] **Step 6: Decide and record**

Adopt ONNX **only if** the beat arrays are identical to PyTorch's (allow ±1 frame on the boundary) — a faster wrong answer is worthless. Write the decision and the numbers into `worker/bench/README.md` with the date and machine.

If ONNX export fails (Beat This! uses rotary embeddings, which occasionally resist `torch.onnx.export`), **do not sink more than a day into it.** Fall back to PyTorch, note it in the README, and record the cost: a ~2.5 GB image, slower Cloud Run cold starts, and ~13 s/track instead of a possible ~5–8 s. The pipeline still fits comfortably inside the free tier either way — this is an optimisation, not a blocker.

- [ ] **Step 7: Commit**

```bash
git add worker/bench worker/models/.gitkeep
git commit -m "bench(worker): beat this pytorch vs onnx, lsq-vs-median bpm"
```

---

### Task 3: Beats module

**Files:**
- Create: `worker/app/beats.py`, `worker/tests/test_beats.py`

**Interfaces:**
- Consumes: `Beats` from Task 1; the runtime chosen in Task 2.
- Produces: `analyze_beats(pcm: np.ndarray, sr: int) -> Beats`; `lsq_bpm(beats: np.ndarray) -> float`; `fold_to_genre_range(bpm: float, genre_hint: str | None) -> float`.

- [ ] **Step 1: Write the failing tests for the pure functions**

The inference itself is integration-tested; the arithmetic is unit-tested, because the arithmetic is where the bug was.

```python
# worker/tests/test_beats.py
import numpy as np, pytest
from app.beats import lsq_bpm, fold_to_genre_range

def test_lsq_bpm_is_exact_on_a_perfect_grid():
    beats = np.arange(0, 360, 60 / 128.0)
    assert lsq_bpm(beats) == pytest.approx(128.0, abs=0.001)

def test_lsq_bpm_beats_median_under_frame_quantisation():
    """Beat This! snaps beats to a ~20ms grid. The median inherits that error;
    the fit averages it out. This is the whole reason lsq_bpm exists."""
    true = np.arange(0, 360, 60 / 128.0)
    quantised = np.round(true / 0.02) * 0.02
    median_bpm = 60.0 / np.median(np.diff(quantised))
    assert abs(median_bpm - 128.0) > 1.0          # median is materially wrong
    assert lsq_bpm(quantised) == pytest.approx(128.0, abs=0.05)   # fit is not

def test_lsq_bpm_needs_at_least_two_beats():
    with pytest.raises(ValueError):
        lsq_bpm(np.array([1.0]))

@pytest.mark.parametrize("bpm,hint,expected", [
    (87.0, "drum & bass", 174.0),
    (87.0, "Drum and Bass", 174.0),
    (174.0, "drum & bass", 174.0),
    (256.0, "techno", 128.0),
    (64.0, "tech house", 128.0),
    (128.0, None, 128.0),        # no hint => never fold
    (87.0, None, 87.0),
    (100.0, "ambient", 100.0),   # unknown genre => never fold
])
def test_fold_to_genre_range(bpm, hint, expected):
    assert fold_to_genre_range(bpm, hint) == pytest.approx(expected)
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd worker && python -m pytest tests/test_beats.py -v`
Expected: FAIL — no module `app.beats`

- [ ] **Step 3: Implement**

```python
# worker/app/beats.py
import numpy as np
from .models import Beats

GENRE_RANGES: dict[str, tuple[float, float]] = {
    'drum and bass': (160, 200), 'drum & bass': (160, 200), 'dnb': (160, 200),
    'jungle': (160, 200), 'hardcore': (160, 200), 'footwork': (150, 175),
    'house': (110, 140), 'tech house': (110, 140), 'deep house': (110, 140),
    'techno': (120, 150), 'minimal': (120, 140), 'trance': (130, 145),
    'dubstep': (135, 150), 'uk garage': (128, 138), 'breakbeat': (125, 145),
}

def lsq_bpm(beats: np.ndarray) -> float:
    """Least-squares fit of beat time against beat index.

    Beat This! quantises beat times to its ~20ms frame grid. Taking the median
    inter-beat interval inherits that quantisation and is 1-2% wrong, which is
    beatmatching-fatal. A linear fit averages the quantisation out.
    """
    beats = np.asarray(beats, dtype=float)
    if beats.size < 2:
        raise ValueError('need at least two beats to estimate tempo')
    k = np.arange(beats.size)
    slope, _ = np.linalg.lstsq(np.vstack([k, np.ones_like(k)]).T, beats, rcond=None)[0]
    if slope <= 0:
        raise ValueError('non-monotonic beat sequence')
    return 60.0 / slope

def fold_to_genre_range(bpm: float, genre_hint: str | None) -> float:
    """Halve or double into the genre's plausible window.

    Only ever applied when a hint is present and recognised. A genre prior beats
    any signal-only trick, but guessing without one is worse than doing nothing.
    """
    if not genre_hint:
        return bpm
    rng = GENRE_RANGES.get(genre_hint.strip().lower())
    if not rng:
        return bpm
    lo, hi = rng
    out = float(bpm)
    for _ in range(4):
        if out < lo:   out *= 2
        elif out > hi: out /= 2
        else:          break
    return out if lo <= out <= hi else float(bpm)

def analyze_beats(pcm: np.ndarray, sr: int, genre_hint: str | None = None) -> Beats:
    from .beat_runtime import infer            # ONNX or torch, decided in Task 2
    beat_times, downbeat_times = infer(pcm, sr)
    beats = np.asarray(beat_times, dtype=float)
    ibi = np.diff(beats)
    raw = lsq_bpm(beats)
    return Beats(
        bpm=fold_to_genre_range(raw, genre_hint),
        bpm_median_ibi=float(60.0 / np.median(ibi)) if ibi.size else 0.0,
        beat_count=int(beats.size),
        ibi_std_ms=float(ibi.std() * 1000) if ibi.size else 0.0,
        beat_grid=[round(float(t), 4) for t in beats],
        downbeat_grid=[round(float(t), 4) for t in downbeat_times],
        confidence=float(max(0.0, 1.0 - (ibi.std() / ibi.mean()))) if ibi.size else 0.0,
    )
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd worker && python -m pytest tests/test_beats.py -v`
Expected: PASS, 11 tests

- [ ] **Step 5: Integration test against the fixtures**

```python
# worker/tests/test_beats_integration.py
import pytest, soundfile as sf
from app.beats import analyze_beats

@pytest.mark.integration
@pytest.mark.parametrize("path,expected", [
    ("bench/fixtures/beat128.wav", 128.0),
    ("bench/fixtures/beat174.wav", 174.0),
])
def test_end_to_end_bpm(path, expected):
    pcm, sr = sf.read(path, dtype='float32', always_2d=True)
    b = analyze_beats(pcm.mean(axis=1), sr)
    assert b.bpm == pytest.approx(expected, abs=0.5)
    assert b.beat_count == pytest.approx(360 / (60 / expected), rel=0.02)
    # the recorded justification for lsq over median:
    assert abs(b.bpm_median_ibi - expected) > abs(b.bpm - expected)
```

Run: `cd worker && python -m pytest tests/test_beats_integration.py -v -m integration`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add worker/app/beats.py worker/tests/test_beats*.py
git commit -m "feat(worker): beat tracking with least-squares bpm + genre octave prior"
```

---

### Task 4: Decode, fingerprint, peaks

**Files:**
- Create: `worker/app/decode.py`, `worker/app/fingerprint.py`, `worker/app/peaks.py`, and matching tests

**Interfaces:**
- Produces: `decode_mono(path) -> tuple[np.ndarray, int]`; `probe(path) -> dict`; `windows(path, n=8, secs=10) -> list[np.ndarray]`; `fingerprint(path) -> Fingerprint`; `compute_peaks(pcm, buckets=1000) -> list[float]`.

- [ ] **Step 1: Write the failing tests**

```python
# worker/tests/test_peaks.py
import numpy as np, pytest
from app.peaks import compute_peaks

def test_peaks_emit_two_values_per_bucket():
    assert len(compute_peaks(np.zeros(44100), buckets=100)) == 200

def test_peaks_capture_min_and_max():
    pcm = np.concatenate([np.full(500, -0.5), np.full(500, 0.8)])
    p = compute_peaks(pcm, buckets=1)
    assert p[0] == pytest.approx(-0.5)
    assert p[1] == pytest.approx(0.8)

def test_peaks_handle_input_shorter_than_bucket_count():
    assert len(compute_peaks(np.zeros(10), buckets=1000)) == 2000
```

```python
# worker/tests/test_fingerprint.py
from app.fingerprint import make_query_items

def test_query_items_are_sorted_deduped_and_masked():
    raw = [0xFFFFFFFF, 0xFFFFFFFF, 0x00000000, 0x0FFF0000]
    items = make_query_items(raw, mask=12, windows=[(0, 4)])
    assert items == sorted(set(items))
    assert all(0 <= i < (1 << 20) for i in items)

def test_query_items_use_both_windows():
    raw = list(range(0, 8 * 120))          # 120 seconds at 8/s
    a = make_query_items(raw, mask=12, windows=[(10, 40)])
    b = make_query_items(raw, mask=12, windows=[(10, 40), (60, 90)])
    assert len(b) > len(a)
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd worker && python -m pytest tests/test_peaks.py tests/test_fingerprint.py -v`
Expected: FAIL — modules missing

- [ ] **Step 3: Implement `peaks.py`**

```python
# worker/app/peaks.py
import numpy as np

def compute_peaks(pcm: np.ndarray, buckets: int = 1000) -> list[float]:
    """Interleaved [min0, max0, min1, max1, …]. ~41KB of JSON at 1000 buckets.

    Deliberately not BBC audiowaveform: that is a whole extra decode pass and a
    GPL dependency to replace this reshape.
    """
    pcm = np.asarray(pcm, dtype=np.float32)
    if pcm.size == 0:
        return [0.0] * (buckets * 2)
    if pcm.size < buckets:
        pcm = np.pad(pcm, (0, buckets - pcm.size))
    n = (pcm.size // buckets) * buckets
    m = pcm[:n].reshape(buckets, -1)
    out = np.empty(buckets * 2, dtype=np.float32)
    out[0::2] = m.min(axis=1)
    out[1::2] = m.max(axis=1)
    return [round(float(v), 4) for v in out]
```

- [ ] **Step 4: Implement `fingerprint.py`**

```python
# worker/app/fingerprint.py
import base64, hashlib, struct, subprocess
from .models import Fingerprint

FPCALC = 'fpcalc'
ALGO_VERSION = 'cp-1.5.1/test2/11025'

def make_query_items(raw: list[int], mask: int = 12,
                     windows: list[tuple[int, int]] | None = None) -> list[int]:
    """Masked, deduped subfingerprints for GIN candidate retrieval.

    Two windows because a single one can land in an intro that differs between a
    club rip and a radio edit. `mask` MUST be calibrated (plan 04): transcode 200
    files to 128kbps and require median(|a & b|)/|a| >= 0.35.
    """
    windows = windows or [(10, 40), (60, 90)]
    items: set[int] = set()
    for start_s, end_s in windows:
        for x in raw[8 * start_s: 8 * end_s]:
            items.add((x >> mask) & 0xFFFFF)
    return sorted(items)

def fingerprint(path: str) -> Fingerprint:
    out = subprocess.run([FPCALC, '-raw', '-length', '0', path],
                         capture_output=True, text=True, check=True).stdout
    fields = dict(line.split('=', 1) for line in out.strip().splitlines())
    raw = [int(v) for v in fields['FINGERPRINT'].split(',')]
    packed = struct.pack(f'<{len(raw)}i', *raw)
    return Fingerprint(
        algo_version=ALGO_VERSION,
        duration_s=int(float(fields['DURATION'])),
        frame_count=len(raw),
        fp_compressed_b64=base64.b64encode(packed).decode(),
        fp_sha256=hashlib.sha256(packed).hexdigest(),
        query_items=make_query_items(raw),
    )
```

- [ ] **Step 5: Implement `decode.py`**

```python
# worker/app/decode.py
import json, subprocess
import numpy as np

def probe(path: str) -> dict:
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
        capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def decode_mono(path: str, sr: int = 44100) -> tuple[np.ndarray, int]:
    """Authoritative decode. duration_ms is derived from THIS, never from tags —
    VBR MP3s without a Xing header report wildly wrong container durations."""
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32), sr

def windows(path: str, count: int = 8, secs: int = 10,
            duration_s: float = 0.0) -> list[np.ndarray]:
    """Forensic sampling windows at 8%..88% of duration, skipping fades.

    `-ss` goes BEFORE `-i` — seek-then-decode measures 0.31s for all eight
    windows, versus a full decode.
    """
    out = []
    for i in range(count):
        pos = duration_s * (0.08 + i * 0.10)
        raw = subprocess.run(
            ['ffmpeg', '-v', 'error', '-ss', f'{pos:.2f}', '-t', str(secs),
             '-i', path, '-f', 'f32le', '-ac', '2', '-ar', '44100', '-'],
            capture_output=True, check=True).stdout
        arr = np.frombuffer(raw, dtype=np.float32)
        if arr.size:
            out.append(arr.reshape(-1, 2))
    return out
```

- [ ] **Step 6: Run and confirm pass**

Run: `cd worker && python -m pytest tests/test_peaks.py tests/test_fingerprint.py -v`
Expected: PASS, 5 tests

- [ ] **Step 7: Verify fpcalc output shape against the fixture**

Run:
```bash
cd worker && python -c "
from app.fingerprint import fingerprint
f = fingerprint('bench/fixtures/beat128.wav')
print(f.duration_s, f.frame_count, len(f.query_items))
assert f.duration_s == 360
assert 2800 < f.frame_count < 2950, 'expect ~8 ints/sec => ~2886 for 6:00'
print('ok')
"
```
Expected: `360 2886 …` then `ok`. The 2,886 figure is measured, not assumed — it's the arithmetic the dedup schema depends on.

- [ ] **Step 8: Commit**

```bash
git add worker/app/{decode,fingerprint,peaks}.py worker/tests/test_{peaks,fingerprint}.py
git commit -m "feat(worker): decode, chromaprint fingerprint, waveform peaks"
```

---

### Task 5: Key detection

**Files:**
- Create: `worker/app/key.py`, `worker/tests/test_key.py`

**Interfaces:**
- Produces: `to_camelot(key: str, scale: str) -> str`; `to_open_key(key, scale) -> str`; `analyze_key(path) -> Key`.

- [ ] **Step 1: Write the failing Camelot tests**

The mapping table is where the off-by-one lives. Test it exhaustively.

```python
# worker/tests/test_key.py
import pytest
from app.key import to_camelot, to_open_key, CAMELOT

@pytest.mark.parametrize("key,scale,expected", [
    ("C",  "major", "8B"), ("A",  "minor", "8A"),
    ("G",  "major", "9B"), ("E",  "minor", "9A"),
    ("F",  "major", "7B"), ("D",  "minor", "7A"),
    ("Db", "major", "3B"), ("Bb", "minor", "3A"),
    ("F#", "major", "2B"), ("D#", "minor", "2A"),
])
def test_camelot_mapping(key, scale, expected):
    assert to_camelot(key, scale) == expected

def test_enharmonics_agree():
    assert to_camelot("C#", "major") == to_camelot("Db", "major")
    assert to_camelot("Eb", "minor") == to_camelot("D#", "minor")

def test_all_24_camelot_codes_are_reachable_and_unique():
    seen = {to_camelot(k, s) for k, s in CAMELOT}
    assert len(seen) == 24

def test_open_key_is_camelot_rotated_by_five():
    assert to_open_key("C", "major") == "1d"
    assert to_open_key("A", "minor") == "1m"

def test_unknown_key_raises():
    with pytest.raises(KeyError):
        to_camelot("H", "major")
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd worker && python -m pytest tests/test_key.py -v`
Expected: FAIL — no module `app.key`

- [ ] **Step 3: Implement**

```python
# worker/app/key.py
import json, subprocess, tempfile, os
from .models import Key

_ENH = {'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
        'Cb': 'B', 'Fb': 'E', 'E#': 'F', 'B#': 'C'}

# Camelot wheel: (key, scale) -> code. Majors are B, minors are A.
_MAJOR = ['B', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']
_MINOR = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'Gb', 'Db']

CAMELOT: dict[tuple[str, str], str] = {}
for i, k in enumerate(_MAJOR):
    CAMELOT[(k, 'major')] = f'{i + 1}B'
for i, k in enumerate(_MINOR):
    CAMELOT[(k, 'minor')] = f'{i + 1}A'

def _norm(key: str) -> str:
    k = key.strip().capitalize().replace('♯', '#').replace('♭', 'b')
    return _ENH.get(k, k)

def to_camelot(key: str, scale: str) -> str:
    return CAMELOT[(_norm(key), scale.lower())]

def to_open_key(key: str, scale: str) -> str:
    """Open Key is Camelot rotated by 5: Camelot 8 == Open Key 1."""
    c = to_camelot(key, scale)
    num, letter = int(c[:-1]), c[-1]
    return f'{(num + 4) % 12 + 1}{"d" if letter == "B" else "m"}'

PROFILES = ('edmm', 'edma', 'bgate')

def analyze_key(path: str) -> Key:
    """Essentia as an ARM'S-LENGTH SUBPROCESS. Never `import essentia` —
    see PRD 7.3 rule 2. argv in, JSON out, no shared address space.
    """
    results: dict[str, tuple[str, str, float]] = {}
    for profile in PROFILES:
        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tf:
            out_path = tf.name
        try:
            subprocess.run(
                ['streaming_extractor_music', path, out_path,
                 '--profile', f'/etc/essentia/{profile}.yaml'],
                capture_output=True, check=True)
            with open(out_path) as fh:
                doc = json.load(fh)
            t = doc['tonal']
            results[profile] = (t['key_key'], t['key_scale'], float(t['key_strength']))
        finally:
            os.unlink(out_path)

    key, scale, strength = results['edmm']          # edmm is primary: best on GiantSteps
    return Key(
        key=key, scale=scale,
        camelot=to_camelot(key, scale),
        open_key=to_open_key(key, scale),
        strength=strength,
        alt_profiles={p: to_camelot(k, s) for p, (k, s, _) in results.items()},
    )
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd worker && python -m pytest tests/test_key.py -v`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add worker/app/key.py worker/tests/test_key.py
git commit -m "feat(worker): essentia key via subprocess + camelot/open-key mapping"
```

---

### Task 6: Loudness, tags, preview

**Files:**
- Create: `worker/app/loudness.py`, `worker/app/tags.py`, `worker/tests/test_loudness.py`

**Interfaces:**
- Produces: `analyze_loudness(path) -> Loudness`; `read_tags(path) -> dict`; `extract_artwork(path, out) -> bool`; `make_preview(path, out) -> None`.

- [ ] **Step 1: Write the failing parser test**

The ffmpeg invocation is integration; the *parsing* of its stderr is where bugs live.

```python
# worker/tests/test_loudness.py
import pytest
from app.loudness import parse_ebur128, replaygain_from_lufs

SAMPLE = """
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -8.9 LUFS
    Threshold: -19.2 LUFS

  Loudness range:
    LRA:        5.4 LU
    Threshold: -39.1 LUFS
    LRA low:   -12.6 LUFS
    LRA high:   -7.2 LUFS

  True peak:
    Peak:        0.4 dBFS
"""

def test_parse_ebur128():
    r = parse_ebur128(SAMPLE)
    assert r['integrated_lufs'] == pytest.approx(-8.9)
    assert r['lra_lu'] == pytest.approx(5.4)
    assert r['true_peak_dbtp'] == pytest.approx(0.4)

def test_replaygain_is_minus_18_reference():
    assert replaygain_from_lufs(-8.9) == pytest.approx(-9.1)
    assert replaygain_from_lufs(-18.0) == pytest.approx(0.0)

def test_parse_ebur128_raises_on_garbage():
    with pytest.raises(ValueError):
        parse_ebur128("no summary here")
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd worker && python -m pytest tests/test_loudness.py -v`
Expected: FAIL

- [ ] **Step 3: Implement**

```python
# worker/app/loudness.py
import re, subprocess
from .models import Loudness

def parse_ebur128(stderr: str) -> dict:
    def grab(pattern: str) -> float:
        m = re.search(pattern, stderr)
        if not m:
            raise ValueError(f'ebur128 output missing {pattern!r}')
        return float(m.group(1))
    return {
        'integrated_lufs': grab(r'I:\s*(-?\d+\.?\d*)\s*LUFS'),
        'lra_lu':          grab(r'LRA:\s*(-?\d+\.?\d*)\s*LU'),
        'true_peak_dbtp':  grab(r'Peak:\s*(-?\d+\.?\d*)\s*dBFS'),
    }

def replaygain_from_lufs(lufs: float) -> float:
    """ReplayGain 2.0 reference is -18 LUFS."""
    return round(-18.0 - lufs, 2)

def analyze_loudness(path: str) -> Loudness:
    p = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-filter_complex',
         'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'],
        capture_output=True, text=True)
    r = parse_ebur128(p.stderr)
    a = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path,
         '-af', 'astats=measure_perchannel=all', '-f', 'null', '-'],
        capture_output=True, text=True).stderr
    m = re.search(r'Number of clipped samples:\s*(\d+)', a)
    n = re.search(r'Number of samples:\s*(\d+)', a)
    clipped = (int(m.group(1)) / int(n.group(1)) * 100) if m and n and int(n.group(1)) else 0.0
    return Loudness(
        integrated_lufs=r['integrated_lufs'],
        lra_lu=r['lra_lu'],
        true_peak_dbtp=r['true_peak_dbtp'],
        replaygain_db=replaygain_from_lufs(r['integrated_lufs']),
        clipped_pct=round(clipped, 4),
    )

def make_preview(path: str, out: str) -> None:
    """128k Opus. Lossless sources only — MP3/M4A stream as-is.
    Measured 3.33s CPU, 3.9MB for 6:00."""
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', path,
         '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', out], check=True)
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd worker && python -m pytest tests/test_loudness.py -v`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add worker/app/{loudness,tags}.py worker/tests/test_loudness.py
git commit -m "feat(worker): loudness, replaygain, tags, opus preview"
```

---

### Task 7: Quality forensics

The anti-cheat from PRD §7.2. **Scope note:** implement the two high-value checks and the abstain path. Do **not** build the full 20-signal stack — the threat model is ten friends, one of whom might innocently upload a fake FLAC they were given, not a determined adversary. A determined adversary defeats all of it by injecting shaped noise above 16 kHz.

**Files:**
- Create: `worker/app/forensics.py`, `worker/tests/test_forensics.py`

**Interfaces:**
- Produces: `measure_cutoff(windows, sr) -> tuple[int, float]`; `classify_ancestor(...) -> str`; `quality_tier(...) -> int`; `quality_score(...) -> float`; `is_upgrade(a, b) -> tuple[bool, str]`.

- [ ] **Step 1: Write the failing tests**

```python
# worker/tests/test_forensics.py
import numpy as np, pytest
from app.forensics import (measure_cutoff, classify_ancestor, quality_tier,
                           quality_score, is_upgrade, CUTOFF_TABLE)

def _band_limited(cutoff_hz, sr=44100, n=44100*10):
    """White noise brickwalled at cutoff_hz — stands in for a lossy encode."""
    rng = np.random.default_rng(0)
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    spec[freqs > cutoff_hz] = 0
    x = np.fft.irfft(spec, n).astype(np.float32)
    return np.stack([x, x], axis=1)

@pytest.mark.parametrize("cutoff", [16000, 19000, 20500])
def test_measure_cutoff_finds_a_brickwall(cutoff):
    got, cliff = measure_cutoff([_band_limited(cutoff)], 44100)
    assert abs(got - cutoff) < 700
    assert cliff >= 30

def test_full_band_noise_reports_no_brickwall():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(441000).astype(np.float32)
    got, cliff = measure_cutoff([np.stack([x, x], axis=1)], 44100)
    assert got >= 20800
    assert cliff < 15

def test_lame_tag_disagreement_confirms_transcode():
    """The cheapest, highest-value check: the bitstream says 20.5kHz,
    the audio brickwalls at 16kHz. Near-zero false positives."""
    assert classify_ancestor(cutoff_hz=16000, cliff_db=35,
                             lame_lowpass_hz=20500, usable_windows=8,
                             hf_ref_delta_db=-20) == 'confirmed'

def test_dark_master_abstains_rather_than_accusing():
    assert classify_ancestor(cutoff_hz=15000, cliff_db=35, lame_lowpass_hz=None,
                             usable_windows=8, hf_ref_delta_db=-70) == 'abstain'

def test_soft_rolloff_is_not_a_transcode():
    assert classify_ancestor(cutoff_hz=17000, cliff_db=8, lame_lowpass_hz=None,
                             usable_windows=8, hf_ref_delta_db=-20) == 'none'

def test_fake_flac_gets_its_tier_from_measured_bandwidth_not_the_container():
    """The entire anti-cheat, in one assertion."""
    assert quality_tier(container='flac', ancestor='confirmed',
                        cutoff_hz=16000, eff_bits=16) == 1
    assert quality_tier(container='flac', ancestor='none',
                        cutoff_hz=21500, eff_bits=16) == 5

def test_abstained_lossless_lands_at_tier_four():
    assert quality_tier(container='flac', ancestor='abstain',
                        cutoff_hz=15000, eff_bits=16) == 4

def _f(**kw):
    base = dict(tier=3, cutoff_hz=19500, eff_bits=16, eff_sr=44100,
                inferred_kbps=320, lame_disagrees=False, clipped_pct=0.0,
                true_peak=-1.0, mono_vs_stereo=False, decode_errors=False)
    return {**base, **kw}

def test_real_flac_beats_a_320_mp3():
    a = quality_score(**_f(tier=3, cutoff_hz=19500))
    b = quality_score(**_f(tier=5, cutoff_hz=21500, inferred_kbps=0))
    assert b > a + 8

def test_fake_320_does_not_beat_a_real_320():
    real = _f(tier=3, cutoff_hz=19500)
    fake = _f(tier=2, cutoff_hz=16000, lame_disagrees=True)
    ok, reason = is_upgrade(real, fake)
    assert ok is False
    assert 'not better' in reason or 'fake' in reason

def test_a_genuine_flac_upgrade_over_a_128_is_accepted():
    incumbent = _f(tier=1, cutoff_hz=16000, inferred_kbps=128)
    candidate = _f(tier=5, cutoff_hz=21500, inferred_kbps=0)
    ok, _ = is_upgrade(incumbent, candidate)
    assert ok is True

def test_a_clipped_candidate_is_never_an_upgrade():
    incumbent = _f(tier=3, cutoff_hz=19500)
    candidate = _f(tier=5, cutoff_hz=21500, clipped_pct=0.5)
    ok, reason = is_upgrade(incumbent, candidate)
    assert ok is False
    assert 'clip' in reason
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd worker && python -m pytest tests/test_forensics.py -v`
Expected: FAIL

- [ ] **Step 3: Implement**

```python
# worker/app/forensics.py
import numpy as np

CUTOFF_TABLE = {11000: 64, 15000: 96, 16000: 128, 17250: 160,
                18750: 192, 19000: 192, 19500: 256, 20000: 256, 20500: 320}
LOSSLESS = {'flac', 'wav', 'aiff', 'alac'}

def measure_cutoff(windows: list[np.ndarray], sr: int) -> tuple[int, float]:
    """Highest frequency with real energy, plus cliff sharpness in dB/500Hz.

    MAX-HOLD across windows, never mean: the encoder lowpass is a hard ceiling
    on the whole file, and averaging drags the apparent cutoff down during quiet
    passages, manufacturing false positives.

    Channels are analysed separately and NOT downmixed: MP3 intensity stereo
    folds HF into a shared mono channel, and a downmix destroys that evidence.
    """
    n_fft = 8192
    maxhold = None
    for w in windows:
        for ch in range(w.shape[1]):
            x = w[:, ch]
            for off in range(0, max(1, len(x) - n_fft), n_fft // 2):
                seg = x[off:off + n_fft]
                if len(seg) < n_fft:
                    break
                p = np.abs(np.fft.rfft(seg * np.hanning(n_fft))) ** 2
                maxhold = p if maxhold is None else np.maximum(maxhold, p)
    if maxhold is None:
        return 0, 0.0

    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    S = 10 * np.log10(maxhold + 1e-20)
    ref = S[(freqs >= 1000) & (freqs <= 4000)].mean()
    thresh = ref - 50.0

    above = np.where(S >= thresh)[0]
    if above.size == 0:
        return 0, 0.0
    # highest bin over threshold, requiring 5 consecutive bins to reject spurs
    idx = above[-1]
    for i in range(above.size - 1, 4, -1):
        if np.all(np.diff(above[i - 4:i + 1]) == 1):
            idx = above[i]
            break
    f_c = float(freqs[idx])

    def band(a: float, b: float) -> float:
        sel = (freqs >= a) & (freqs < b)
        return float(S[sel].mean()) if sel.any() else -200.0

    cliff = band(f_c - 500, f_c) - band(f_c, f_c + 500)
    return int(round(f_c)), round(float(cliff), 2)

def classify_ancestor(cutoff_hz: int, cliff_db: float, lame_lowpass_hz: int | None,
                      usable_windows: int, hf_ref_delta_db: float) -> str:
    # 1. cheapest kill: the bitstream disagrees with the PCM
    if lame_lowpass_hz is not None and abs(lame_lowpass_hz - cutoff_hz) > 1500:
        return 'confirmed'
    # 2. abstain BEFORE deciding — this is what makes it fair
    if usable_windows < 4 or hf_ref_delta_db < -60:
        return 'abstain'
    # 3. cliff-based
    if cliff_db >= 30 and cutoff_hz < 21000 and \
       any(abs(cutoff_hz - t) <= 400 for t in CUTOFF_TABLE):
        return 'confirmed'
    if 15 <= cliff_db < 30:
        return 'suspected'
    return 'none'

def quality_tier(container: str, ancestor: str, cutoff_hz: int, eff_bits: int) -> int:
    lossless = container.lower() in LOSSLESS
    if lossless and ancestor == 'none' and cutoff_hz >= 20800 and eff_bits >= 16:
        return 5
    if lossless and ancestor == 'abstain':
        return 4
    # A lossless container with a CONFIRMED lossy ancestor falls through to its
    # MEASURED bandwidth. That single rule is the entire anti-cheat.
    if cutoff_hz >= 19500: return 3
    if cutoff_hz >= 17000: return 2
    return 1

def quality_score(tier: int, cutoff_hz: int, eff_bits: int, eff_sr: int,
                  inferred_kbps: int, lame_disagrees: bool, clipped_pct: float,
                  true_peak: float, mono_vs_stereo: bool, decode_errors: bool) -> float:
    s = 100.0 * tier
    s += 0.8 * min(cutoff_hz, 22050) / 1000
    s += 6.0 * min(max((eff_bits - 16) / 8, 0.0), 1.0)
    s += 4.0 * min(max((eff_sr - 44100) / 51900, 0.0), 1.0)
    s += 10.0 * min(1.0, inferred_kbps / 320) if inferred_kbps else 0.0
    s -= 6.0 if lame_disagrees else 0.0
    s -= 12.0 * min(1.0, clipped_pct / 0.01)
    s -= 4.0 if true_peak > 0.0 else 0.0
    s -= 15.0 if mono_vs_stereo else 0.0
    s -= 25.0 if decode_errors else 0.0
    # NOTE: the published formula also penalised low DR. Deliberately omitted —
    # a loud DR5 remaster may be exactly the club-ready copy a DJ wants, and that
    # term encodes an audiophile preference this pool does not share. DR is
    # informational only; only hard clipping is penalised.
    return round(s, 2)

def is_upgrade(a: dict, b: dict) -> tuple[bool, str]:
    """Does candidate b beat incumbent a? Requires a margin AND a hard win."""
    if b.get('clipped_pct', 0) > 0.001 >= a.get('clipped_pct', 0):
        return False, 'candidate is newly clipped'
    sa, sb = quality_score(**a), quality_score(**b)
    if sb - sa < 8:
        return False, f'not better by enough ({sb - sa:.1f} < 8)'
    hard = (b['tier'] > a['tier']
            or b['cutoff_hz'] >= a['cutoff_hz'] + 1500
            or (a.get('inferred_kbps') and b['tier'] == 5))
    if not hard:
        return False, 'no hard monotone improvement'
    if b.get('lame_disagrees') and b['cutoff_hz'] <= a['cutoff_hz']:
        return False, 'fake: confirmed lossy ancestor at no better bandwidth'
    return True, f'upgrade (+{sb - sa:.1f})'
```

- [ ] **Step 4: Run and confirm pass**

Run: `cd worker && python -m pytest tests/test_forensics.py -v`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add worker/app/forensics.py worker/tests/test_forensics.py
git commit -m "feat(worker): quality forensics — cutoff, ancestor, tier, upgrade test"
```

---

### Task 8: Container and Cloud Run

**Files:**
- Create: `worker/Dockerfile`, `worker/.dockerignore`, `worker/app/main.py`, `worker/deploy.sh`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# worker/Dockerfile
FROM python:3.12-slim AS base

# ffmpeg: LGPL-only. Distro builds are usually --enable-gpl, which makes the
# BINARY gpl even though the filters we use are LGPL. chromaprint gives fpcalc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libchromaprint-tools flac \
    && rm -rf /var/lib/apt/lists/*

# Essentia as a standalone binary, invoked over a subprocess boundary.
# Built WITHOUT FFTW (GPL, and UPF cannot sublicense it) and with NO models —
# the model zoo is CC BY-NC-SA/ND and we never download a .pb.
COPY --from=ghcr.io/mtg/essentia:latest /usr/local/bin/streaming_extractor_music /usr/local/bin/
COPY --from=ghcr.io/mtg/essentia:latest /usr/local/lib/libessentia* /usr/local/lib/
RUN ldconfig

WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir -e .

COPY app/ app/
COPY models/ models/
COPY profiles/ /etc/essentia/

ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    ORT_INTRA_OP_NUM_THREADS=1
# Threading costs MORE on Cloud Run: measured 13.2s CPU at 1 thread vs 19.5s at
# 8 for identical work, and vCPU-seconds are what gets billed.

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
```

- [ ] **Step 2: Write the handler**

```python
# worker/app/main.py
import os, tempfile, time, httpx
from fastapi import FastAPI
from .models import AnalyzeRequest, AnalyzeResponse
from . import decode, fingerprint, beats, key, loudness, peaks, forensics, tags

app = FastAPI()
MAX_DURATION_MS = 15 * 60 * 1000

@app.get('/healthz')
def healthz() -> dict:
    return {'ok': True, 'version': os.environ.get('ANALYSIS_VERSION', 'dev')}

@app.post('/analyze', response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    t0 = time.process_time()
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, 'in.audio')
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.get(req.get_url)
            r.raise_for_status()
            with open(src, 'wb') as fh:
                fh.write(r.content)

        try:
            info = decode.probe(src)
            pcm, sr = decode.decode_mono(src)
            duration_ms = int(len(pcm) / sr * 1000)   # DECODED. authoritative.

            if duration_ms > MAX_DURATION_MS:
                return AnalyzeResponse(
                    file_id=req.file_id, analysis_version=req.analysis_version,
                    ok=False, error='too_long', duration_ms=duration_ms,
                    cpu_seconds=round(time.process_time() - t0, 2))

            stream = next(s for s in info['streams'] if s['codec_type'] == 'audio')
            wins = decode.windows(src, duration_s=duration_ms / 1000)
            cutoff_hz, cliff = forensics.measure_cutoff(wins, sr)

            return AnalyzeResponse(
                file_id=req.file_id, analysis_version=req.analysis_version, ok=True,
                duration_ms=duration_ms,
                container=info['format']['format_name'].split(',')[0],
                codec=stream['codec_name'],
                sample_rate=int(stream['sample_rate']),
                channels=int(stream['channels']),
                fingerprint=fingerprint.fingerprint(src),
                beats=beats.analyze_beats(pcm, sr),
                key=key.analyze_key(src),
                loudness=loudness.analyze_loudness(src),
                tags=tags.read_tags(src),
                cpu_seconds=round(time.process_time() - t0, 2),
            )
        except Exception as e:                       # noqa: BLE001
            return AnalyzeResponse(
                file_id=req.file_id, analysis_version=req.analysis_version,
                ok=False, error=f'{type(e).__name__}: {e}',
                cpu_seconds=round(time.process_time() - t0, 2))
```

Note the handler **never raises to the caller** — it returns `ok=False` with the reason. The Cloudflare Worker decides whether that is retryable, because only the Worker knows the retry budget.

- [ ] **Step 3: Build and test locally**

```bash
cd worker
docker build -t localchune-analysis .
docker run --rm -p 8080:8080 localchune-analysis &
curl -s localhost:8080/healthz
```
Expected: `{"ok":true,"version":"dev"}`

- [ ] **Step 4: Verify the measured budget holds in the container**

```bash
python -m http.server 9000 --directory bench/fixtures &
curl -s -X POST localhost:8080/analyze -H 'content-type: application/json' \
  -d '{"file_id":"t1","get_url":"http://host.docker.internal:9000/beat128.wav","analysis_version":"v1"}' \
  | python -m json.tool | grep -E 'cpu_seconds|bpm|duration_ms|camelot'
```

Expected: `bpm` ≈ 128, `duration_ms` ≈ 360000, `cpu_seconds` in the 15–40 s band. **If `cpu_seconds` exceeds 60, stop and investigate before deploying** — the whole free-tier cost model assumes ~35 s.

- [ ] **Step 5: Deploy**

```bash
# worker/deploy.sh
gcloud artifacts repositories create localchune --repository-format=docker --location=us-central1 || true
gcloud builds submit --tag us-central1-docker.pkg.dev/$PROJECT/localchune/analysis:$(git rev-parse --short HEAD)
gcloud run deploy localchune-analysis \
  --image us-central1-docker.pkg.dev/$PROJECT/localchune/analysis:$(git rev-parse --short HEAD) \
  --region us-central1 \
  --cpu 1 --memory 2Gi \
  --concurrency 1 \
  --max-instances 8 \
  --min-instances 0 \
  --timeout 900 \
  --no-allow-unauthenticated \
  --set-env-vars ANALYSIS_VERSION=v1
```

`--cpu 1 --concurrency 1` is deliberate and cost-driven, not conservatism. `--max-instances 8` bounds a runaway loop; without it a bug is unbounded spend.

- [ ] **Step 6: Set a budget alert**

Cloud Run has no free-tier spend cap by default. In the GCP console set a billing budget alert at $5 before sending real traffic.

- [ ] **Step 7: Commit**

```bash
git add worker/Dockerfile worker/app/main.py worker/deploy.sh
git commit -m "feat(worker): container + cloud run deploy, 1vcpu/2gib/concurrency1"
```

---

### Task 9: Queue consumer

**Files:**
- Create: `src/workers/analyze-consumer.ts`, `supabase/migrations/…_analysis.sql`
- Modify: `wrangler.jsonc`

**Interfaces:**
- Consumes: `AnalyzeResponse` from Task 1.
- Produces: rows in `audio_analysis` and `fingerprints`; `files.state` transitions.

- [ ] **Step 1: Write the migration**

```sql
create table public.audio_analysis (
  file_id          uuid primary key references public.files(id) on delete cascade,
  analysis_version text not null,
  duration_ms      int,
  bpm              real,
  bpm_median_ibi   real,
  beat_grid        real[],
  downbeat_grid    real[],
  ibi_std_ms       real,
  key_camelot      text,
  key_open         text,
  key_musical      text,
  key_strength     real,
  key_alt_profiles jsonb,
  integrated_lufs  real,
  lra_lu           real,
  true_peak_dbtp   real,
  replaygain_db    real,
  clipped_pct      real,
  meas_cutoff_hz   int,
  meas_cliff_db    real,
  lossy_ancestor   text check (lossy_ancestor in ('none','suspected','confirmed','abstain')),
  quality_tier     smallint,
  quality_score    real,
  raw_tags         jsonb,
  cpu_seconds      real,
  analyzed_at      timestamptz not null default now(),
  unique (file_id, analysis_version)
);
alter table public.audio_analysis enable row level security;
create index audio_analysis_track_idx on public.audio_analysis (quality_score desc);
```

- [ ] **Step 2: Write the consumer**

```ts
// src/workers/analyze-consumer.ts
import { AwsClient } from 'aws4fetch'

interface Msg { file_id: string; r2_key: string; analysis_version: string }

export default {
  async queue(batch: MessageBatch<Msg>, env: Env): Promise<void> {
    const aws = new AwsClient({
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      service: 's3', region: 'auto',
    })

    for (const m of batch.messages) {
      try {
        const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${m.body.r2_key}?X-Amz-Expires=1800`
        const signed = await aws.sign(new Request(url, { method: 'GET' }), {
          aws: { signQuery: true },
        })

        const res = await fetch(`${env.ANALYSIS_URL}/analyze`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await mintGoogleIdToken(env)}`,
          },
          body: JSON.stringify({
            file_id: m.body.file_id,
            get_url: signed.url,
            analysis_version: m.body.analysis_version,
          }),
        })
        if (!res.ok) throw new Error(`analysis ${res.status}`)
        const r = await res.json<AnalyzeResponse>()

        // Idempotent by (file_id, analysis_version). Queues is at-least-once.
        await persist(env, r)
        m.ack()
      } catch (err) {
        m.retry()   // Queues handles backoff and the dead-letter queue
      }
    }
  },
}
```

- [ ] **Step 3: Wire the queue into `wrangler.jsonc`**

```jsonc
"queues": {
  "producers": [{ "queue": "localchune-analyze", "binding": "ANALYZE_QUEUE" }],
  "consumers": [{
    "queue": "localchune-analyze",
    "max_batch_size": 1,
    "max_retries": 5,
    "dead_letter_queue": "localchune-analyze-dlq"
  }]
}
```

`max_batch_size: 1` is load-bearing — a batch retry re-delivers **every** message in the batch, so one poisoned file would re-run its neighbours.

- [ ] **Step 4: Add the stuck-job cron**

Free-plan Queues retention is **24 hours and non-configurable**, so the queue cannot be the system of record. `files.state` is. This cron makes the pipeline self-healing and turns the retention limit into a non-issue.

```ts
export async function scheduled(_ev: ScheduledController, env: Env) {
  const stuck = await sql(env, `
    select id, r2_key from files
     where state = 'analysing' and created_at < now() - interval '1 hour'
     limit 100`)
  for (const f of stuck) {
    await env.ANALYZE_QUEUE.send({ file_id: f.id, r2_key: f.r2_key, analysis_version: 'v1' })
  }
}
```

- [ ] **Step 5: End-to-end verification**

1. Upload one file through the Milestone 2 flow
2. Confirm an `audio_analysis` row appears within ~2 minutes
3. **Send the same queue message twice by hand and confirm exactly one row exists** — this is the at-least-once assertion
4. Point a message at a deleted R2 key and confirm it lands in the DLQ after 5 attempts rather than looping

- [ ] **Step 6: Commit and PR**

```bash
git add src/workers supabase/migrations wrangler.jsonc
git commit -m "feat: queue consumer, analysis persistence, stuck-job cron"
git push -u origin rohan/m3-analysis
gh pr create --title "M3: analysis worker" --fill
gh pr list --state open
```

---

## Done when

- One uploaded file produces a complete `audio_analysis` row.
- `cpu_seconds` is in the 15–40 s band on Cloud Run. If not, the cost model is wrong and needs revisiting before backfill.
- BPM on the fixtures is exact via least-squares, and demonstrably better than median-IBI.
- A fake FLAC (a 128 kbps MP3 re-encoded to FLAC) gets `tier = 1`, not 5.
- Replaying a queue message creates no second row.
- A budget alert exists in GCP.
