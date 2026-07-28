# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
#
# `app.beat_runtime` is Task 8's file (real model loading wired into the
# container) and does not exist yet. This test builds a throwaway shim,
# backed directly by beat_this's own Audio2Beats, and installs it into
# sys.modules before calling analyze_beats -- so analyze_beats(pcm, sr) is
# exercised exactly as it will be called in production, without creating
# Task 8's file early.
import sys
import types

import pytest
import soundfile as sf

from app.beats import analyze_beats


@pytest.fixture(scope="module", autouse=True)
def _install_beat_runtime_shim():
    from beat_this.inference import Audio2Beats

    a2b = Audio2Beats(checkpoint_path="final0", device="cpu", dbn=False)

    def infer(pcm, sr):
        return a2b(pcm, sr)

    shim = types.ModuleType("app.beat_runtime")
    shim.infer = infer
    sys.modules["app.beat_runtime"] = shim
    yield
    del sys.modules["app.beat_runtime"]


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
