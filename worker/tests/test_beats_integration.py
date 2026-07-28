# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
#
# analyze_beats() is exercised exactly as production calls it: through the
# real app.beat_runtime, on the real `final0` weights. Task 3 had to stand up
# a throwaway sys.modules shim here because beat_runtime did not exist yet;
# Task 8 created it, so the shim is gone.
import pytest
import soundfile as sf

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
