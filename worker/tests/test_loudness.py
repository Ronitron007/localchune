# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import os
import subprocess

import pytest

from app.loudness import parse_ebur128, replaygain_from_lufs, analyze_loudness, make_preview
from app.models import Loudness

SAMPLE = """
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -8.9 LUFS
    Threshold: -19.2 LUFS

  Loudness range:
    LRA:        5.4 LU
    Threshold: -39.1 LUFS
    LRA low:   -12.6 LUFS
    LRA high:   -7.2 LUFS

  True peak:
    Peak:        0.4 dBFS
"""

def test_parse_ebur128():
    r = parse_ebur128(SAMPLE)
    assert r['integrated_lufs'] == pytest.approx(-8.9)
    assert r['lra_lu'] == pytest.approx(5.4)
    assert r['true_peak_dbtp'] == pytest.approx(0.4)

def test_replaygain_is_minus_18_reference():
    assert replaygain_from_lufs(-8.9) == pytest.approx(-9.1)
    assert replaygain_from_lufs(-18.0) == pytest.approx(0.0)

def test_parse_ebur128_raises_on_garbage():
    with pytest.raises(ValueError):
        parse_ebur128("no summary here")


# --- Real ffmpeg 8.0.1 integration. ---
#
# These generate tiny synthetic fixtures at test time (no audio committed to
# the repo) and shell out to the real, locally-installed ffmpeg 8.0.1 -- no
# mocking. This is what caught two real bugs in the brief's literal code,
# neither of which the brief's own canned-stderr test could have caught:
#
# 1. analyze_loudness ran ffmpeg with '-v error'. Both ebur128's Summary
#    block and astats' measurements log at AV_LOG_INFO, which '-v error'
#    silences outright (confirmed: 0 bytes of stderr) -- parse_ebur128
#    raised ValueError on every real invocation. Fixed to '-v info'.
# 2. astats' "Number of clipped samples" field does not exist in ffmpeg
#    8.0.1 at all (confirmed via `-h filter=astats`'s exhaustive option
#    list and `strings` on the built binary) -- clipped_pct silently read
#    as 0.0 forever, never raising, which is a worse failure mode than the
#    ValueError above. Fixed to fall back to the "Abs Peak count" field
#    (see the docstring on app.loudness._clipped_pct for the reasoning).
#
# Sub-second each; not marked @pytest.mark.integration -- ffmpeg is a hard
# runtime dependency of this module already (like fpcalc is for
# app.fingerprint, see test_fingerprint.py::test_algo_version_format),
# unlike the Task 5 Essentia/beat_this binaries that only exist in the
# Task 8 Docker image.

def _run(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True)

def _sine_wav(path: str, dbfs: float, duration: float = 5.0, freq: int = 1000) -> None:
    """A true-stereo (not mono-upmixed -- see below) sine at an exact peak
    dBFS. Both channels are synthesized directly with the same expression;
    ffmpeg's automatic mono->stereo upmix (e.g. piping a mono aevalsrc
    through '-ac 2') applies a -3.01 dB matrixing gain, which was verified
    experimentally and would silently throw off the target level."""
    amp = 10 ** (dbfs / 20)
    expr = f'{amp}*sin(2*PI*{freq}*t)'
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', f'aevalsrc={expr}|{expr}:s=44100:d={duration}', path)

def _clipped_wav(path: str, duration: float = 2.0, freq: int = 1000) -> None:
    """2x-amplitude sine written straight to s16 PCM -- clamps on encode,
    genuinely clipping roughly a third of samples (verified with astats)."""
    expr = f'2.0*sin(2*PI*{freq}*t)'
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', f'aevalsrc={expr}:s=44100:d={duration}', '-c:a', 'pcm_s16le', path)

def _pink_noise_flac(path: str, duration: float = 10.0) -> None:
    """Pink noise, not a pure tone: FLAC is lossless and barely compresses
    noise, which is what makes the Opus preview's size drop dramatic and
    representative -- a pure sine compresses so well in FLAC already that
    Opus at 128k can come out *larger* (verified experimentally)."""
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', f'anoisesrc=color=pink:duration={duration}:sample_rate=44100',
         '-ac', '2', path)


def test_real_ffmpeg_ebur128_output_matches_brief_shape(tmp_path):
    """The brief's canned SAMPLE block IS shaped like real ffmpeg 8.0.1
    output (I:/LRA:/Peak: lines match character-for-character) -- the bug
    was the '-v error' flag suppressing it outright, not a format drift."""
    wav = str(tmp_path / 'tone.wav')
    _sine_wav(wav, dbfs=-20.0)
    p = subprocess.run(
        ['ffmpeg', '-v', 'info', '-i', wav, '-filter_complex',
         'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'],
        capture_output=True, text=True)
    assert 'Summary:' in p.stderr
    r = parse_ebur128(p.stderr)  # must not raise
    assert r['integrated_lufs'] == pytest.approx(-20.0, abs=0.5)

def test_analyze_loudness_on_real_minus20dbfs_tone(tmp_path):
    wav = str(tmp_path / 'tone.wav')
    _sine_wav(wav, dbfs=-20.0)
    result = analyze_loudness(wav)
    assert isinstance(result, Loudness)
    assert result.integrated_lufs == pytest.approx(-20.0, abs=1.0)
    assert result.true_peak_dbtp == pytest.approx(-20.0, abs=1.0)
    assert result.replaygain_db == pytest.approx(-18.0 - result.integrated_lufs, abs=0.01)
    assert result.clipped_pct < 2.0  # clean tone: no real clipping

def test_analyze_loudness_detects_real_clipping(tmp_path):
    clean = str(tmp_path / 'clean.wav')
    clipped = str(tmp_path / 'clipped.wav')
    _sine_wav(clean, dbfs=-20.0, duration=2.0)
    _clipped_wav(clipped)
    clean_result = analyze_loudness(clean)
    clipped_result = analyze_loudness(clipped)
    # Absolute floor: a 2x over-driven sine clamped to s16 clips roughly a
    # third of its samples (verified with astats' Abs Peak count).
    assert clipped_result.clipped_pct > 10.0
    # Relative: clipping must read far higher than clean material, whatever
    # ffmpeg build's astats output shape supplies the numerator.
    assert clipped_result.clipped_pct > clean_result.clipped_pct * 5

def test_make_preview_produces_smaller_real_opus_file(tmp_path):
    src = str(tmp_path / 'source.flac')
    out = str(tmp_path / 'preview.opus')
    _pink_noise_flac(src)
    make_preview(src, out)

    assert os.path.exists(out)
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name',
         '-of', 'csv=p=0', out],
        capture_output=True, text=True, check=True)
    assert probe.stdout.strip() == 'opus'

    src_size = os.path.getsize(src)
    out_size = os.path.getsize(out)
    assert out_size < src_size * 0.5, (
        f'preview ({out_size}B) is not dramatically smaller than source ({src_size}B)')
