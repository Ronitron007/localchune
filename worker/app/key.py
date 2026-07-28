# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import json, subprocess, tempfile, os
from .models import Key

_ENH = {'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb',
        'Cb': 'B', 'Fb': 'E', 'E#': 'F', 'B#': 'C'}

# Camelot wheel: (key, scale) -> code. Majors are B, minors are A.
_MAJOR = ['B', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E']
_MINOR = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'Gb', 'Db']

CAMELOT: dict[tuple[str, str], str] = {}
for i, k in enumerate(_MAJOR):
    CAMELOT[(k, 'major')] = f'{i + 1}B'
for i, k in enumerate(_MINOR):
    CAMELOT[(k, 'minor')] = f'{i + 1}A'

def _norm(key: str) -> str:
    k = key.strip().capitalize().replace('♯', '#').replace('♭', 'b')
    return _ENH.get(k, k)

def to_camelot(key: str, scale: str) -> str:
    return CAMELOT[(_norm(key), scale.lower())]

def to_open_key(key: str, scale: str) -> str:
    """Open Key is Camelot rotated by 5: Camelot 8 == Open Key 1."""
    c = to_camelot(key, scale)
    num, letter = int(c[:-1]), c[-1]
    return f'{(num + 4) % 12 + 1}{"d" if letter == "B" else "m"}'

PROFILES = ('edmm', 'edma', 'bgate')

def analyze_key(path: str) -> Key:
    """Essentia as an ARM'S-LENGTH SUBPROCESS. Never `import essentia` —
    see PRD 7.3 rule 2. argv in, JSON out, no shared address space.
    """
    results: dict[str, tuple[str, str, float]] = {}
    for profile in PROFILES:
        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tf:
            out_path = tf.name
        try:
            subprocess.run(
                ['streaming_extractor_music', path, out_path,
                 '--profile', f'/etc/essentia/{profile}.yaml'],
                capture_output=True, check=True)
            with open(out_path) as fh:
                doc = json.load(fh)
            t = doc['tonal']
            results[profile] = (t['key_key'], t['key_scale'], float(t['key_strength']))
        finally:
            os.unlink(out_path)

    key, scale, strength = results['edmm']          # edmm is primary: best on GiantSteps
    return Key(
        key=key, scale=scale,
        camelot=to_camelot(key, scale),
        open_key=to_open_key(key, scale),
        strength=strength,
        alt_profiles={p: to_camelot(k, s) for p, (k, s, _) in results.items()},
    )
