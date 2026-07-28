# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
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
