# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""Beat This! model loading and inference — the real thing behind
``app.beats.analyze_beats``'s deferred ``from .beat_runtime import infer``.

Kept in its own module for two reasons:

1. ``analyze_beats`` imports it INSIDE the function body, so importing
   ``app.beats`` (and therefore ``app.models``, and therefore the whole
   FastAPI contract) never drags in torch. Unit tests stay fast and torch-free.
2. Loading torch and 77 MB of weights is a once-per-process cost. It happens
   here, behind a module-level cache, and ``app.main`` warms it during startup
   so that per-track ``cpu_seconds`` measures analysis and not model load.

Runtime: PyTorch eager on CPU. Task 2 exported the same network to ONNX and
measured it 2.2x SLOWER (12.7-12.9s vs 27.5-28.1s CPU per 6-minute track):
Beat This!'s RMSNorm-gated attention does not match ONNX Runtime's fusion
patterns, so 12 attention blocks decompose into unfused MatMul/Softmax/MatMul,
where torch eager reaches a fused kernel. See worker/bench/README.md.
"""
import os
import threading

import numpy as np

# Where the Dockerfile puts the sha256-pinned `final0` checkpoint. Outside the
# container the file is absent and beat_this falls back to its own shortname
# resolution, which downloads to the torch hub cache — convenient for a dev
# machine, unacceptable in the image (a cold start must never depend on
# cloud.cp.jku.at being up).
_CHECKPOINT = os.environ.get("BEAT_THIS_CHECKPOINT", "/app/models/beat_this-final0.ckpt")

_model = None
_lock = threading.Lock()


def checkpoint_path() -> str:
    """The checkpoint actually used: the pinned local file when present, else
    beat_this's own ``final0`` shortname (downloads on first use)."""
    return _CHECKPOINT if os.path.isfile(_CHECKPOINT) else "final0"


def load() -> object:
    """Build the Audio2Beats pipeline once, then hand back the cached one.

    Thread-guarded because uvicorn's default thread pool runs sync endpoints
    off the event loop: two requests could otherwise each pay the ~1 GB load.
    """
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        import torch

        # The single most cost-load-bearing line in the worker. The container
        # has 1 vCPU but torch reads the HOST core count; unpinned it spawns
        # 8+ threads that fight over one core and bill ~48% more CPU for the
        # same answer (13.2s vs 19.5s measured, Task 2). OMP_NUM_THREADS in
        # the image env is not sufficient on its own — torch caches its own
        # intra-op pool size.
        torch.set_num_threads(1)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            # Raises if any inter-op parallel work already started. Harmless:
            # it means the pool exists, and the intra-op pin above is the one
            # that carries the cost.
            pass

        from beat_this.inference import Audio2Beats

        _model = Audio2Beats(
            checkpoint_path=checkpoint_path(), device="cpu", dbn=False
        )
        return _model


def infer(pcm: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """(beat_times, downbeat_times) in seconds, for mono float32 PCM.

    Audio2Beats resamples to 22.05 kHz itself, so `sr` is passed through
    rather than pre-resampled here — soxr inside beat_this is the same
    resampler the published metrics were produced with.
    """
    signal = np.asarray(pcm, dtype=np.float32)
    if signal.ndim == 2:
        signal = signal.mean(axis=1)
    return load()(signal, int(sr))
