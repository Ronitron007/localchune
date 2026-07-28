# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
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

def _clipped_pct(astats_stderr: str) -> float:
    """Ratio of samples sitting at the digital ceiling, as a percent.

    Verified against real ffmpeg 8.0.1: astats no longer prints "Number of
    clipped samples" at all (absent from `-h filter=astats`'s option list
    and from `strings` on the built libavfilter/ffmpeg binary -- it is not
    a stderr-format drift, the field is simply gone). "Abs Peak count" --
    samples that hit the exact absolute peak sample value -- is the closest
    available proxy: a handful of samples touching the peak is normal for
    any full-scale material, but a clipped signal pins a large fraction of
    samples there (verified: an unclipped -20 dBFS tone reads ~1%, a 2x
    over-driven tone reads ~33%). The old field name is tried first in case
    a different ffmpeg build still emits it.
    """
    m = (re.search(r'Number of clipped samples:\s*(\d+)', astats_stderr)
         or re.search(r'Abs Peak count:\s*(\d+\.?\d*)', astats_stderr))
    n = re.search(r'Number of samples:\s*(\d+)', astats_stderr)
    if not (m and n) or not int(float(n.group(1))):
        return 0.0
    return round(float(m.group(1)) / float(n.group(1)) * 100, 4)

def analyze_loudness(path: str) -> Loudness:
    """Measure loudness, dynamic range, and clipping suspicion.

    clipped_pct is a heuristic proxy: ffmpeg 8 astats has no clipped-sample field,
    so it uses Abs Peak count recurrence as a suspicion signal. Verified to separate
    clean (~1%) from clipped (~33%) material. Treat as a threshold indicator, not a
    literal percentage.
    """
    # NOTE: '-v info', not '-v error'. ebur128's Summary block and astats'
    # measurements are both logged at AV_LOG_INFO -- '-v error' silences
    # them entirely (verified: 0 bytes of stderr on real ffmpeg 8.0.1),
    # which made parse_ebur128 raise ValueError on every real invocation.
    # framelog=verbose's per-frame lines log at AV_LOG_VERBOSE, a level
    # '-v info' still suppresses, so the Summary is the only ebur128 line
    # in stderr -- no risk of matching an early per-frame value instead.
    p = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', path, '-filter_complex',
         'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'],
        capture_output=True, text=True)
    r = parse_ebur128(p.stderr)
    a = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', path,
         '-af', 'astats=measure_perchannel=all', '-f', 'null', '-'],
        capture_output=True, text=True).stderr
    return Loudness(
        integrated_lufs=r['integrated_lufs'],
        lra_lu=r['lra_lu'],
        true_peak_dbtp=r['true_peak_dbtp'],
        replaygain_db=replaygain_from_lufs(r['integrated_lufs']),
        clipped_pct=_clipped_pct(a),
    )

def make_preview(path: str, out: str) -> None:
    """128k Opus. Lossless sources only — MP3/M4A stream as-is.
    Measured 3.33s CPU, 3.9MB for 6:00."""
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-i', path,
         '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', out], check=True)
