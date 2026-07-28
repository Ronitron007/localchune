# localchune — MIT licensed. See LICENSE.
#
# Benchmark harness: PyTorch vs ONNX Runtime for Beat This!, on this machine
# (Apple Silicon, native — NOT the linux/amd64 Cloudflare Containers target).
# See worker/bench/README.md for why that's still a valid *relative*
# comparison and what it can't tell us.
#
# Usage:
#   .venv/bin/python benchmark.py torch   # PyTorch baseline -> results_torch.json
#   .venv/bin/python benchmark.py onnx    # ONNX Runtime     -> results_onnx.json
#   .venv/bin/python benchmark.py compare # diff the two result files
#
# Each mode is a separate process invocation deliberately: resource.getrusage
# peak RSS is cumulative for the life of the process, so running torch and
# onnx back to back in one process would pollute the onnx RSS reading with
# torch's own footprint.
import json
import os
import resource
import sys
import time

import numpy as np

os.environ.setdefault("OMP_NUM_THREADS", "1")

FIXTURES = ["fixtures/beat128.wav", "fixtures/beat174.wav"]
TRUE_BPM = {"fixtures/beat128.wav": 128.0, "fixtures/beat174.wav": 174.0}
ONNX_PATH = "../models/beat_this.onnx"

# beat_this's own frame rate for framewise logits (see
# beat_this.model.postprocessor.Postprocessor, fps=50 default).
FPS = 50
FRAME_S = 1.0 / FPS


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
                        beats=len(beats), downbeats=len(downbeats),
                        bpm_lsq=lsq_bpm(np.asarray(beats)),
                        bpm_median=60.0 / np.median(np.diff(beats)),
                        beat_times=list(map(float, beats)),
                        downbeat_times=list(map(float, downbeats))))
    return load, out


class _OnnxModel:
    """Wraps an onnxruntime session so beat_this.inference.split_predict_aggregate
    can call it exactly like the torch nn.Module it was written for: takes a
    (1, frames, 128) torch tensor, returns {"beat": tensor, "downbeat": tensor}
    of shape (1, frames)."""

    def __init__(self, sess):
        self.sess = sess

    def __call__(self, chunk):
        import torch

        beat, downbeat = self.sess.run(
            None, {"spect": chunk.numpy().astype(np.float32)}
        )
        return {"beat": torch.from_numpy(beat), "downbeat": torch.from_numpy(downbeat)}


def bench_onnx(paths):
    # Preprocessing (audio -> log-mel spectrogram) and postprocessing
    # (framewise logits -> beat times) are plain torch/numpy math, not part
    # of the exported graph, so they're identical for both runtimes here.
    # This is what an eventual production ONNX pipeline would still need to
    # reimplement without torch to get the full image-size win described in
    # the README; this benchmark borrows beat_this's torch implementation of
    # both purely to prove the exported model produces the same beats.
    import torch
    import onnxruntime as ort
    from beat_this.inference import load_audio, split_predict_aggregate
    from beat_this.model.postprocessor import Postprocessor
    from beat_this.preprocessing import LogMelSpect
    import soxr

    torch.set_num_threads(1)

    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    t = time.perf_counter()
    sess = ort.InferenceSession(ONNX_PATH, so, providers=["CPUExecutionProvider"])
    model = _OnnxModel(sess)
    spect_fn = LogMelSpect(device="cpu")
    postp = Postprocessor(type="minimal")
    load = time.perf_counter() - t

    out = []
    for p in paths:
        c0 = time.process_time(); w0 = time.perf_counter()
        signal, sr = load_audio(p)
        if signal.ndim == 2:
            signal = signal.mean(1)
        if sr != 22050:
            signal = soxr.resample(signal, in_rate=sr, out_rate=22050)
        signal_t = torch.tensor(signal, dtype=torch.float32)
        spect = spect_fn(signal_t)
        # Same chunking beat_this's own Spect2Frames.spect2frames uses in
        # production (chunk_size=1500, border_size=6, overlap_mode
        # "keep_first") -- NOT the brief's single-shot sketch. A 6-minute
        # track is ~18,000 frames; full self-attention over that length in
        # the un-chunked graph needs >20 GB for one layer's score matrix on
        # this 16 GB machine (16 heads x 18000^2 x 4 bytes), so unchunked
        # inference is infeasible here and isn't how beat_this runs in
        # practice either -- the model was never trained on inputs that long.
        # split_predict_aggregate returns a dict ({"beat": ..., "downbeat":
        # ...}), not a tuple -- unpacking it directly would iterate its keys.
        frame_pred = split_predict_aggregate(
            spect=spect, chunk_size=1500, border_size=6,
            overlap_mode="keep_first", model=model,
        )
        beats, downbeats = postp(
            frame_pred["beat"].float(), frame_pred["downbeat"].float()
        )
        out.append(dict(path=p, cpu=time.process_time() - c0,
                        wall=time.perf_counter() - w0,
                        rss_mb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6,
                        beats=len(beats), downbeats=len(downbeats),
                        bpm_lsq=lsq_bpm(np.asarray(beats)),
                        bpm_median=60.0 / np.median(np.diff(beats)),
                        beat_times=list(map(float, beats)),
                        downbeat_times=list(map(float, downbeats))))
    return load, out


def run_torch():
    load, rows = bench_torch(FIXTURES)
    print(f"torch load={load:.2f}s")
    for r in rows:
        print(f"  {r['path']}: cpu={r['cpu']:.2f}s wall={r['wall']:.2f}s "
              f"rss={r['rss_mb']:.0f}MB beats={r['beats']} downbeats={r['downbeats']} "
              f"lsq={r['bpm_lsq']:.3f} median={r['bpm_median']:.2f}")
        true_bpm = TRUE_BPM[r["path"]]
        assert abs(r["bpm_lsq"] - true_bpm) < 0.01, (
            f"lsq_bpm {r['bpm_lsq']} not within 0.01 of true {true_bpm}"
        )
        pct_off = abs(r["bpm_median"] - true_bpm) / true_bpm * 100
        assert 1.0 <= pct_off <= 2.0, (
            f"median_bpm {r['bpm_median']} is {pct_off:.2f}% off true "
            f"{true_bpm}, expected 1-2% (this is the recorded justification "
            f"for using lsq instead of median)"
        )
    with open("results_torch.json", "w") as f:
        json.dump(dict(load=load, rows=rows), f)
    print("assertions OK (lsq within 0.01, median 1-2% off) -> results_torch.json")


def run_onnx():
    load, rows = bench_onnx(FIXTURES)
    print(f"onnx load={load:.2f}s")
    for r in rows:
        print(f"  {r['path']}: cpu={r['cpu']:.2f}s wall={r['wall']:.2f}s "
              f"rss={r['rss_mb']:.0f}MB beats={r['beats']} downbeats={r['downbeats']} "
              f"lsq={r['bpm_lsq']:.3f} median={r['bpm_median']:.2f}")
    with open("results_onnx.json", "w") as f:
        json.dump(dict(load=load, rows=rows), f)
    print("-> results_onnx.json")


def run_compare():
    with open("results_torch.json") as f:
        torch_r = json.load(f)["rows"]
    with open("results_onnx.json") as f:
        onnx_r = json.load(f)["rows"]
    ok = True
    for tr, orr in zip(torch_r, onnx_r):
        assert tr["path"] == orr["path"]
        print(f"\n{tr['path']}")
        print(f"  beats:     torch={tr['beats']} onnx={orr['beats']}")
        print(f"  downbeats: torch={tr['downbeats']} onnx={orr['downbeats']}")
        print(f"  lsq bpm:   torch={tr['bpm_lsq']:.3f} onnx={orr['bpm_lsq']:.3f}")
        if tr["beats"] != orr["beats"]:
            print(f"  MISMATCH: beat count differs")
            ok = False
        if tr["downbeats"] != orr["downbeats"]:
            print(f"  MISMATCH: downbeat count differs")
            ok = False
        if round(tr["bpm_lsq"], 3) != round(orr["bpm_lsq"], 3):
            print(f"  MISMATCH: lsq bpm differs at 3 decimals")
            ok = False
        tb, ob = np.asarray(tr["beat_times"]), np.asarray(orr["beat_times"])
        if len(tb) == len(ob):
            diffs = np.abs(tb - ob)
            max_diff = diffs.max() if len(diffs) else 0.0
            frames_off = max_diff / FRAME_S
            print(f"  max beat-time diff: {max_diff * 1000:.1f}ms ({frames_off:.2f} frames)")
            if frames_off > 1.0 + 1e-6:
                print(f"  MISMATCH: beat times differ by more than 1 frame")
                ok = False
        else:
            print(f"  MISMATCH: different beat array lengths, cannot align")
            ok = False
    print(f"\n{'IDENTICAL (within tolerance) -> ONNX may be adopted' if ok else 'DIFFERS -> do NOT adopt ONNX'}")
    return ok


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "torch"
    if mode == "torch":
        run_torch()
    elif mode == "onnx":
        run_onnx()
    elif mode == "compare":
        ok = run_compare()
        sys.exit(0 if ok else 1)
    else:
        print(f"unknown mode {mode!r}, expected torch|onnx|compare", file=sys.stderr)
        sys.exit(2)
