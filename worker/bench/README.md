# Beat This! benchmark — PyTorch vs ONNX Runtime

**Decision: PyTorch.** ONNX Runtime gave byte-identical beat output. But it
was **2.2 times slower**, not faster. This is the opposite of the design
phase assumption. This is the reason for the decision. See "Why not ONNX"
below for the full case.

Machine: Apple M1 Pro, macOS 26.0.1 (25A362), arm64, 16 GB RAM. Date:
2026-07-28. Versions: Python 3.12.12, torch 2.13.0, torchaudio 2.11.0,
onnxruntime 1.28.0, onnx 1.22.0, beat_this @ `b95c8ab` (CPJKU/beat_this,
`final0` checkpoint).

This test ran natively on Apple Silicon, not on the `linux/amd64`
deployment target. Cloudflare Containers only runs `linux/amd64`. The Mac
can only run that image under QEMU, and QEMU timings mean nothing.

This test measures a *relative* question: is ONNX faster than PyTorch for
this model, on the same inputs, on the same hardware? The team expected
this relative answer to survive the change to `linux/amd64`. **It might
not, in this case** — see the caveat near the end. Task 8, Step 6
re-measures the real per-track cost on the deployed container.

## PyTorch baseline

Command:
```
cd worker/bench && OMP_NUM_THREADS=1 ../.venv/bin/python benchmark.py torch
```

Output:
```
torch load=0.34s
  fixtures/beat128.wav: cpu=12.88s wall=13.34s rss=1058MB beats=769 downbeats=751 lsq=128.000 median=130.43
  fixtures/beat174.wav: cpu=12.74s wall=12.21s rss=1058MB beats=1045 downbeats=1045 lsq=174.000 median=176.47
assertions OK (lsq within 0.01, median 1-2% off) -> results_torch.json
```

This matches the design-phase reference within noise (reference: 13.2s CPU,
about 13.2s wall, 944-977MB RSS, lsq exactly 128.000/174.000, median
130.43/176.47). Both required checks pass. `lsq_bpm` is exact to 3 decimals
against the true BPM. `median_bpm` is 1-2% off the true BPM. This gap is the
reason the harness uses a least-squares fit over the beat times, not the
median inter-beat interval — the median has a small, steady bias on this
signal.

RSS (1058MB) runs a little higher than the design-phase number (944-977MB).
A likely cause is the torch version (2.13.0 here, an unknown version at
design time). This gap does not change the decision, so the report does not
chase it further.

Thread pins used in every run: `torch.set_num_threads(1)`,
`OMP_NUM_THREADS=1` in the environment, and (for ONNX)
`intra_op_num_threads=1` and `inter_op_num_threads=1`.

## ONNX export

Command:
```
cd worker/bench && OMP_NUM_THREADS=1 ../.venv/bin/python export_onnx.py
```

The export worked on the first real attempt. It used the legacy
TorchScript-based tracer (`torch.onnx.export(..., dynamo=False)`). Two
dependency gaps needed a fix first. Both were pre-existing gaps in
`worker/pyproject.toml`, not new problems from this task, so the fix went
into the config rather than around it:

1. `worker/pyproject.toml` had no `[build-system]` block and no
   package-discovery config. Without it, setuptools treats every top-level
   folder with a `.py` file as an importable package. This stayed hidden
   while only `app/` existed. It broke as soon as this task added `bench/`
   and `models/`. The fix: an explicit
   `[tool.setuptools.packages.find] include = ["app*"]`.
2. torch 2.6 and later default to `torch.onnx.export(dynamo=True)`. This
   path needs the `onnxscript` package, which was not installed. It is also
   a newer, less proven export path for a model with rotary embeddings and
   Python-level branching. The fix: pass `dynamo=False` to use the legacy
   tracer instead. This matches both the design-phase numbers and the
   brief's own note that "dynamo export" is one workaround among several,
   not a requirement. Saving the traced graph also needs the separate
   `onnx` package (`onnxruntime` only *runs* graphs, it does not write
   them). The fix: add `onnx>=1.17` to the `bench` extra.

The tracer prints `TracerWarning` messages from `rotary_embedding_torch`
(`should_cache and ...`, tensor-to-bool checks) and from `beat_tracker.py`
(`len(x)` on a tensor). These are the exact rotary-embedding risk the brief
warned about. None of them stopped the export. The traced graph freezes the
control-flow path for the traced shape into constants. This is safe here,
because the real inference path
(`beat_this.inference.split_predict_aggregate`, not the brief's one-shot
sketch) always calls the model with a fixed `(1, 1500, 128)` chunk. `1500`
is beat_this's own `chunk_size`. Every chunk gets zero-padded to exactly
that length before the model sees it. See "Changes from the brief" below
for why the export shape is fixed instead of `dynamic_axes` on the frames
dimension, and for the one real limit that choice adds.

The team made two export attempts:

| Attempt | Shape | Nodes | Cos/Sin/Gather present? | sha256 |
|---|---|---|---|---|
| 1 — `dynamic_axes` on frames (brief's sketch) | `(batch, frames, 128)` | 4740 | yes (rebuilt on every call) | `f15c88f7…` (83,077,749 bytes) |
| 2 — fixed `(1, 1500, 128)` (used for benchmarking) | fixed | 2255 | no (folded into constants) | `d67a8860…` (82,524,585 bytes) |

Both attempts give correct output (see the comparison section below).
Attempt 2 cut the node count in half. It also cut peak RSS from
2169-2249MB down to 1427MB, by letting the exporter fold
`rotary_embedding_torch`'s position tables into constants. The exporter
cannot do this fold when the frames axis stays symbolic. Neither file is
committed to git. Both match the `worker/models/*.onnx` gitignore rule,
since both run tens of MB, and neither is the artifact this task adopts
(see the decision above). `worker/models/.gitkeep` keeps the folder itself
tracked in git.

## ONNX benchmark

Command:
```
cd worker/bench && OMP_NUM_THREADS=1 ../.venv/bin/python benchmark.py onnx
```
(This uses the fixed-shape export, attempt 2 above. It runs in its own
process, so the peak-RSS reading does not carry over torch's memory
footprint from an earlier run in the same process.)

Output:
```
onnx load=0.19s
  fixtures/beat128.wav: cpu=27.49s wall=29.47s rss=1427MB beats=769 downbeats=751 lsq=128.000 median=130.43
  fixtures/beat174.wav: cpu=28.13s wall=30.12s rss=1427MB beats=1045 downbeats=1045 lsq=174.000 median=176.47
```

`benchmark.py`'s `bench_onnx` function copies `beat_this.inference`'s real
chunked path (`split_piece` and `aggregate_prediction`, chunk size 1500,
border size 6, `overlap_mode="keep_first"`). It swaps in an onnxruntime
session in place of the torch model. This is **not** a single forward pass
over the whole ~18,000-frame track, which is what the brief's `bench_onnx`
sketch suggests. See "Changes from the brief" below for why: that approach
does not fit in memory on this 16GB machine, and it is not how the model
runs in practice. The spectrogram step and the beat-extraction step reuse
`beat_this`'s own torch code, unchanged, for both runtimes. So the only
difference between the two benchmark runs is which engine runs the network
itself.

## Comparison

Command:
```
cd worker/bench && ../.venv/bin/python benchmark.py compare
```

Output:
```
fixtures/beat128.wav
  beats:     torch=769 onnx=769
  downbeats: torch=751 onnx=751
  lsq bpm:   torch=128.000 onnx=128.000
  max beat-time diff: 0.0ms (0.00 frames)

fixtures/beat174.wav
  beats:     torch=1045 onnx=1045
  downbeats: torch=1045 onnx=1045
  lsq bpm:   torch=174.000 onnx=174.000
  max beat-time diff: 0.0ms (0.00 frames)

IDENTICAL (within tolerance) -> ONNX may be adopted
```

Beat and downbeat counts match exactly on both fixtures. The lsq BPM
matches to 3 decimals. Every single beat timestamp matches to 0.0ms — well
inside the ±1 frame (20ms) tolerance the brief allows, in fact exactly
equal. **The correctness gate is met without doubt.**

## Decision table

| Runtime | CPU/track (M1 Pro, 1 thread) | Wall/track | Peak RSS | amd64 image size | Deploys before 50GB cap | Beat output vs torch |
|---|---|---|---|---|---|---|
| PyTorch eager, 1 thread | 12.7-12.9s | 12.2-13.3s | 1058MB | ~2.5GB (estimate, not measured — see below) | ~20 | baseline |
| ONNX Runtime (CPUExecutionProvider), 1 thread | **27.5-28.1s** | 29.5-30.1s | 1427MB | ~300MB (estimate, not measured — see below) | ~160 | **identical (0.0ms)** |

The team did not measure image size. It did not run `docker buildx build
--platform linux/amd64`, because the decision does not reach that step (see
below). The ~2.5GB and ~300MB figures come from the brief's own estimate.
This report carries them through for completeness. It does not check them.

## Why not ONNX

The brief expected ONNX to win on three points. It named rollback headroom
as the deciding point, even before anyone measured speed: (1) rollback
headroom from a ~300MB image against a ~2.5GB image, (2) faster cold start
from the smaller image, (3) "a possible ~5-8s/track against ~13s" of CPU
time. Point one and two are estimates from the brief, not measured here.
Correctness passed without any gap.

But point three did not just fall short — it went the other way. **ONNX
cost 27.5-28.1s of CPU per 6-minute track, 2.2 times more than PyTorch's
12.7-12.9s.** A single-chunk test confirms this: 5 runs of one chunk
average 2.124s on ONNX against 0.941s on PyTorch, for the same 1500-frame
chunk and the same weights. This is not noise and not a bug in the test
script. It shows up on both fixtures and at the single-chunk level.

**Root cause**, confirmed by looking inside the exported graph: Beat This!'s
attention blocks use `F.scaled_dot_product_attention` with an RMSNorm
pre-norm step and a learned output gate. This is not the plain
LayerNorm-based attention shape that ONNX Runtime's built-in graph-fusion
patterns expect. At opset 17, the legacy TorchScript exporter has no single
ONNX op for scaled-dot-product attention. So it breaks each of the model's
12 attention calls into separate MatMul, Softmax, and MatMul steps.

The test confirmed ORT's default `graph_optimization_level`
(`ORT_ENABLE_ALL`) was already on. It did fuse some parts — GELU, and a
scale-into-matmul fusion that produces `FusedMatMul` — but it never merged
the 12 broken-apart attention triples back into one fused attention kernel.
The pattern match failed without any error message, which is the known
failure mode for attention blocks that do not match the standard shape.
PyTorch eager sends `F.scaled_dot_product_attention` straight to a fused,
hand-tuned CPU kernel instead. The result: ONNX Runtime does more raw work
per attention call than PyTorch does on CPU, for this one model.

CPU time is the thing the platform bills. Beat This! makes up 65% of the
whole milestone's compute budget. A 2.2 times regression there is a real,
first-order cost increase. It is not a detail to set aside in favor of
image size. It also runs against the exact premise this task was set up to
test.

There is a second, separate reason ONNX does not give the brief's promised
gains *today*, even without the CPU regression. The ~300MB-image and
faster-cold-start case needs the deployed container to drop
`torch`/`torchaudio` completely. This benchmark's ONNX path still imports
torch. It reuses `beat_this`'s own torch-based spectrogram and
beat-extraction code for both runtimes, on purpose, so the test isolates
"which engine runs the network" from "did someone reimplement the rest
correctly." That reuse is the right choice to prove correctness.

But it means today's ONNX pipeline still needs the full torch and
torchaudio dependency chain in the image, the same as the PyTorch pipeline.
To get the size win, someone must also rewrite audio loading, resampling,
and the log-mel spectrogram step, plus the "minimal" peak-picking
beat-extraction step, without torch. This is possible with plain numpy and
soxr. But it is separate, unscoped work, not part of this task.

Given a real, repeatable 2.2 times CPU regression today, and a size and
rollback gain that needs separate unscoped work before it even applies,
**the call is PyTorch.** The cost: a ~2.5GB image (estimate, not verified),
about 20 deploys before `wrangler containers images delete` becomes
forced (which then breaks rollback to any version that used the deleted
image), and about 13s of CPU per track. This matches the brief's own
fallback cost, word for word — the outcome lands on the brief's failure-mode
plan even though the export itself did not fail.

**A caveat on hardware.** The brief assumes a relative ONNX-vs-PyTorch
result survives the move from arm64 (this Mac) to the deployed
`linux/amd64` container, because both engines run natively there and the
scaling factor should cancel out. That is a safe assumption for work that
scales evenly with clock speed and core count.

It is a **weaker assumption when a fused-kernel gap drives the result**, as
it does here. PyTorch's fused attention kernel and ONNX Runtime's
attention-fusion pass are both tied to the hardware backend (Apple's
Accelerate/vecLib here, MKL-DNN/oneDNN on x86). So the size of the 2.2
times gap, maybe even its direction, might not hold on amd64.

**Task 8, Step 6 should re-run `benchmark.py onnx` on the deployed amd64
container** before ruling out ONNX for good — the exported `.onnx` file and
`export_onnx.py` are cheap to reproduce from this task. If oneDNN's
attention path on x86 behaves better than Accelerate's does here, the
result could flip. Until that check runs, PyTorch stays the safer default.

**Update — Task 8's amd64 re-check (M3 final review, Finding F7).** It
flipped, as the caveat above predicted it might. Measured on the deployed
container class (the actual `linux/amd64` target, not this Mac), across the
same two fixtures used above:

| Fixture | PyTorch (s) | ONNX Runtime (s) | ONNX vs PyTorch |
|---|---|---|---|
| 128 BPM, 6 min | 35.85 | 32.42 | ~10% faster |
| 174 BPM, 6 min | 34.58 | 26.53 | ~23% faster |

Beat output was byte-identical between the two runtimes on both fixtures,
same as the arm64 result above. oneDNN's attention path on x86 evidently
does not carry the same fusion gap Apple's Accelerate/vecLib showed on
arm64 — the mechanism section above ("Why not ONNX") explains the gap that
no longer applies here.

This does **not** flip the Dockerfile's choice on its own. `worker/Dockerfile`
still installs PyTorch: the win here is 10-23% CPU per track, real but not
urgent, and adopting ONNX Runtime is not a drop-in swap — it needs its own
pass to actually drop the torch/torchaudio dependency chain from the image
(see "There is a second, separate reason" above; this benchmark's ONNX path
still imports torch for preprocessing). That is unscoped work and stays on
the backlog. The Dockerfile comment records this as deferred, not rejected.

## Changes from the brief

1. **Fixed export shape, not `dynamic_axes` on frames.** The brief's
   `export_onnx.py` sketch marks the frames dimension as dynamic. The real
   caller (`beat_this.inference.split_predict_aggregate`) only ever passes
   fixed 1500-frame chunks (zero-padded to that length by `split_piece`).
   So a fixed shape matches real use, lets the exporter fold the
   rotary-embedding position tables into constants (see the export
   section), and measurably cut RSS. **Limit this adds:** `split_piece`
   only pads a chunk up to exactly `chunk_size` when the input spectrogram
   holds at least 1488 frames (about 29.76s of audio). A shorter piece
   produces a chunk under 1500 frames, which this fixed-shape graph cannot
   take. This does not affect this benchmark's 6-minute fixtures. It is
   unlikely to matter for a DJ track pool in practice. Whoever wires this
   into the real `/analyze` path should either pad short tracks up to 1500
   frames before the ONNX call, or keep a `dynamic_axes` export on hand for
   that edge case.
2. **Chunked ONNX inference, not the brief's one-shot sketch.** The brief's
   `bench_onnx` sketch calls `sess.run` once on the whole-track
   spectrogram. A 6-minute track holds about 18,000 frames. Full
   self-attention over the un-chunked main transformer at that length needs
   over 20GB for one layer's attention-score matrix alone (16 heads ×
   18000² × 4 bytes). This machine has 16GB. It also is not how Beat This!
   is meant to run — it trained on 1500-frame windows, which is exactly why
   `split_predict_aggregate` exists in the library. `bench_onnx` rebuilds
   that chunking with an ONNX-session adapter in its place.
3. **Added `onnx>=1.17` to the `bench` extra**, and added an explicit
   `[tool.setuptools.packages.find]` block to `pyproject.toml` — see the
   export section above. Both fix pre-existing gaps that this task's new
   files exposed. Neither is a new requirement added for convenience.

## Files

- `worker/bench/make_fixtures.py` — the synthetic 128/174 BPM, 6-minute
  fixture generator (copied from the brief without change). Its output
  files are gitignored (`worker/bench/fixtures/*.wav`).
- `worker/bench/benchmark.py` — a CLI with three modes: `torch`, `onnx`,
  `compare`. Each mode runs as its own process, so a `resource.getrusage`
  peak-RSS reading never picks up the other runtime's memory footprint. The
  raw JSON output (`results_torch.json`, `results_onnx.json`) is
  gitignored. Regenerate it with the commands above.
- `worker/bench/export_onnx.py` — the adopted fixed-shape export script.
  This stays in the repo, working and documented, even though the decision
  is PyTorch. It is useful for the Task 8 amd64 re-check above, and for
  anyone who later fixes the fusion gap.
- `worker/models/.gitkeep` — no `.onnx` file is committed. Neither export
  attempt is adopted. Both sha256 hashes are in this file if anyone needs
  to reproduce either one exactly.
