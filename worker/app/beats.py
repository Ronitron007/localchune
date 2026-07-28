# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
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
    from .beat_runtime import infer            # torch, decided in Task 2
    beat_times, downbeat_times = infer(pcm, sr)
    beats = np.asarray(beat_times, dtype=float)
    ibi = np.diff(beats)

    # Degrade gracefully on beatless input: lsq_bpm requires ≥2 beats
    if beats.size < 2:
        return Beats(
            bpm=0.0,
            bpm_median_ibi=0.0,
            beat_count=int(beats.size),
            ibi_std_ms=0.0,
            beat_grid=[round(float(t), 4) for t in beats],
            downbeat_grid=[round(float(t), 4) for t in downbeat_times],
            confidence=0.0,
        )

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
