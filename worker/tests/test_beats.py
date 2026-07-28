# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
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
