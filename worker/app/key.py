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

# The stock streaming_extractor_music binary computes three FIXED key
# profiles together in a single run -- temperley, krumhansl, edma -- nested
# under tonal.key_<profile> (each an object with key/scale/strength). There
# is no keyProfile knob on this binary: edmm and bgate are not reachable
# through it at all (see MusicTonalDescriptors.cpp / musicextractor.cpp
# upstream). edma is the best of the three available here on GiantSteps.
_ALT_PROFILE_TONAL_KEYS = {
    'edma': 'key_edma',
    'temperley': 'key_temperley',
    'krumhansl': 'key_krumhansl',
}

def analyze_key(path: str) -> Key:
    """Essentia as an ARM'S-LENGTH SUBPROCESS. Never `import essentia` —
    see PRD 7.3 rule 2. argv in, JSON out, no shared address space.

    Real usage: `streaming_extractor_music input output [profile]` — a bare
    positional argv, not flags. The optional 3rd positional is a frame-level
    tuning YAML (frameSize/hopSize/zeroPadding/windowType/silentFrames/stats)
    we don't need, so it's omitted.
    """
    with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tf:
        out_path = tf.name
    try:
        subprocess.run(
            ['streaming_extractor_music', path, out_path],
            capture_output=True, check=True)
        with open(out_path) as fh:
            doc = json.load(fh)
        tonal = doc['tonal']

        primary = tonal['key_edma']
        key, scale = primary['key'], primary['scale']
        strength = float(primary['strength'])

        alt_profiles = {
            alt: to_camelot(tonal[tonal_key]['key'], tonal[tonal_key]['scale'])
            for alt, tonal_key in _ALT_PROFILE_TONAL_KEYS.items()
        }

        return Key(
            key=key, scale=scale,
            camelot=to_camelot(key, scale),
            open_key=to_open_key(key, scale),
            strength=strength,
            alt_profiles=alt_profiles,
        )
    finally:
        os.unlink(out_path)
