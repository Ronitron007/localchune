# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import re
from app.fingerprint import make_query_items, algo_version

def test_query_items_are_sorted_deduped_and_masked():
    raw = [0xFFFFFFFF, 0xFFFFFFFF, 0x00000000, 0x0FFF0000]
    items = make_query_items(raw, mask=12, windows=[(0, 4)])
    assert items == sorted(set(items))
    assert all(0 <= i < (1 << 20) for i in items)

def test_query_items_use_both_windows():
    # 120 seconds at 8/s. Shifted left by the mask width so each index lands
    # in its own bucket after `>> mask` — the brief's literal `range(0, 960)`
    # never exceeds 1<<12, so every value collapses to bucket 0 regardless of
    # window and the assertion below is mathematically unsatisfiable. Fixture
    # fixed; make_query_items itself is unchanged from the brief.
    raw = [x << 12 for x in range(0, 8 * 120)]
    a = make_query_items(raw, mask=12, windows=[(10, 40)])
    b = make_query_items(raw, mask=12, windows=[(10, 40), (60, 90)])
    assert len(b) > len(a)

def test_algo_version_format():
    # algo_version() returns a string matching cp-X.Y(.Z)?/test2/11025
    version_str = algo_version()
    assert isinstance(version_str, str)
    assert re.match(r'^cp-\d+\.\d+(\.\d+)?/test2/11025$', version_str)


# --- Production failure, 2026-07-29: three real uploads went to 'failed'
# --- with "CalledProcessError: Command '['fpcalc', '-raw', '-length', '0',
# --- ...]' returned non-zero exit status 3".
#
# fpcalc exits 3 on an MP3 with a damaged region — and still writes a
# COMPLETE DURATION and a full 36 KB FINGERPRINT to stdout, because
# chromaprint fingerprints everything it managed to decode and only then
# reports that the decode was not clean. check=True threw that away, so
# three perfectly matchable tracks were lost over a few damaged frames.
#
# The fixture is built by a REAL encoder at test time and then damaged, not
# hand-written: it must reproduce the exact exit-3-with-output behaviour, and
# only fpcalc gets to decide when that happens. Verified to reproduce the
# production stderr string byte for byte.

import shutil
import subprocess

import pytest

from app.fingerprint import fingerprint


def _run(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True)


@pytest.fixture
def damaged_mp3(tmp_path):
    p = str(tmp_path / 'damaged.mp3')
    _run('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
         '-i', 'anoisesrc=d=40:c=pink:r=44100:a=0.5', '-ac', '2',
         '-c:a', 'libmp3lame', '-b:a', '192k', p)
    b = bytearray(open(p, 'rb').read())
    start = int(len(b) * 0.6)
    b[start:start + 20000] = b'\xff' * 20000
    open(p, 'wb').write(bytes(b))
    return p


@pytest.mark.skipif(shutil.which('fpcalc') is None, reason='fpcalc not installed')
def test_the_fixture_really_does_make_fpcalc_exit_non_zero(damaged_mp3):
    """If this stops holding, the test below proves nothing and must be
    rebuilt — it would be passing on a clean file."""
    proc = subprocess.run(['fpcalc', '-raw', '-length', '0', damaged_mp3],
                          capture_output=True, text=True)
    assert proc.returncode != 0
    assert 'Error reading from the audio source' in proc.stderr
    assert 'FINGERPRINT=' in proc.stdout


@pytest.mark.skipif(shutil.which('fpcalc') is None, reason='fpcalc not installed')
def test_a_damaged_file_still_yields_the_fingerprint_fpcalc_did_produce(damaged_mp3):
    fp = fingerprint(damaged_mp3)
    assert fp.frame_count > 100
    assert fp.duration_s > 0
    assert len(fp.fp_sha256) == 64
    assert fp.query_items, 'no query items means no dedup candidate retrieval'


@pytest.mark.skipif(shutil.which('fpcalc') is None, reason='fpcalc not installed')
def test_a_file_with_no_fingerprint_at_all_still_raises(tmp_path):
    """Trusting the OUTPUT is not the same as ignoring failure. With nothing
    usable on stdout, the exit code is the only diagnosis there is."""
    p = str(tmp_path / 'notaudio.mp3')
    open(p, 'wb').write(b'this is not audio' * 100)
    with pytest.raises(subprocess.CalledProcessError) as e:
        fingerprint(p)
    assert e.value.returncode != 0
