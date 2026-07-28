# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
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
