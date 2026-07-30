# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""The LAME/Xing/Info tag, read without mp3guessenc.

Every fixture here is produced by a REAL encoder at test time. Task 7 of M3
proved the cost of trusting a hand-built byte fixture: the published
128 kbps cutoff figure was 800 Hz wrong against real LAME output, which
would have silently downgraded a real fake FLAC from 'confirmed' to 'none'.

TWO BRIEF-VS-REALITY CORRECTIONS, both found by running the real encoders:

1. THE FIXTURE MUST COME FROM THE `lame` CLI, NOT FROM
   `ffmpeg -c:a libmp3lame`. ffmpeg does not let libmp3lame write the
   Xing/Info frame — ffmpeg's own mp3 muxer writes it, and it writes a stub
   whose encoder string is 'Lavc62.11' with the lowpass byte left at ZERO.
   Measured: every `ffmpeg -c:a libmp3lame` file in this tree has no 'LAME'
   string anywhere in its first frame. A test built on ffmpeg would have
   asserted nothing at all — read_lame_tag() would return None for the
   reason the parser is designed to return None, and the assertion
   `tag is not None` would have failed with no clue why.

2. THE LOWPASS IS AT BYTE 10 OF THE LAME EXTENSION, NOT BYTE 21. Byte 21 is
   the first of the three encoder-delay bytes. Measured on real LAME 3.100
   output: byte 10 reads 170 -> 17000 Hz at 128 kbps and 205 -> 20500 Hz at
   320 kbps, which is exactly what this file asserts; byte 21 reads 36 on
   BOTH, i.e. a constant 3600 Hz that would make lame_lowpass_hz disagree
   with the measured cutoff on every single MP3 and mark the whole pool
   'confirmed'. That is the worst possible failure for this module — it
   accuses everyone.
"""
import shutil
import subprocess

import pytest

from app.lametag import read_lame_tag

# The `lame` CLI is a TEST-ONLY dependency (brew install lame / apt-get
# install lame). It is deliberately NOT in worker/Dockerfile: nothing at
# runtime encodes MP3s, and read_lame_tag() only ever READS a tag some other
# encoder wrote. Skipping loudly rather than silently passing, because a
# vanished fixture here is exactly how bug 2 above would come back.
_HAS_LAME = shutil.which('lame') is not None
needs_lame = pytest.mark.skipif(
    not _HAS_LAME,
    reason='the real `lame` CLI is required — ffmpeg -c:a libmp3lame writes a '
           'Lavc stub with no lowpass and would make these assertions vacuous')


def _raw_wav(tmp_path, seconds: int = 8) -> str:
    out = str(tmp_path / 'raw.wav')
    subprocess.run(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
         '-i', f'anoisesrc=d={seconds}:c=pink:r=44100:a=0.5',
         '-ac', '2', out], check=True)
    return out


def _encode(tmp_path, kbps: int, seconds: int = 8) -> str:
    """A REAL LAME encode, with a real LAME tag in its first frame."""
    out = str(tmp_path / f'{kbps}.mp3')
    subprocess.run(['lame', '--quiet', '-b', str(kbps), _raw_wav(tmp_path, seconds), out],
                   check=True)
    return out


@needs_lame
@pytest.mark.parametrize('kbps,expect_lowpass_hz', [(128, 17000), (320, 20500)])
def test_reads_the_lowpass_a_real_encoder_wrote(tmp_path, kbps, expect_lowpass_hz):
    tag = read_lame_tag(_encode(tmp_path, kbps))
    assert tag is not None
    # The tag stores lowpass/100, so the resolution is 100 Hz and the
    # tolerance below is about the ENCODER's choice, not our parsing.
    assert abs(tag.lowpass_hz - expect_lowpass_hz) <= 1500
    assert tag.encoder_string.startswith('LAME')


@needs_lame
def test_reads_the_vbr_method(tmp_path):
    """`-b N` is CBR. The field is informational, but a parser that reads it
    from the wrong byte is a parser reading the whole extension at the wrong
    offset, which is bug 2 in this file's docstring."""
    assert read_lame_tag(_encode(tmp_path, 320)).vbr_method == 'cbr'


def test_returns_none_for_a_flac(tmp_path):
    out = str(tmp_path / 'x.flac')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
                    '-i', 'anoisesrc=d=2:r=44100', out], check=True)
    assert read_lame_tag(out) is None


def test_returns_none_for_an_ffmpeg_written_stub_tag(tmp_path):
    """ffmpeg's mp3 muxer writes 'Lavc<version>' where LAME writes
    'LAME3.100', and leaves the lowpass byte at zero. There is no lowpass to
    read, so there is no evidence — and no evidence must read as None, which
    classify_ancestor() handles by falling through to the spectral path.
    Inventing a 0 Hz lowpass here would make |0 - cutoff| > 1500 on every
    file and confirm a lossy ancestor for all of them."""
    src = str(tmp_path / 'src.wav')
    out = str(tmp_path / 'ffmpeg.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
                    '-i', 'anoisesrc=d=4:c=pink:r=44100:a=0.5', '-ac', '2', src],
                   check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src,
                    '-c:a', 'libmp3lame', '-b:a', '128k', out], check=True)
    assert read_lame_tag(out) is None


@needs_lame
def test_returns_none_rather_than_raising_on_a_truncated_file(tmp_path):
    p = _encode(tmp_path, 128)
    with open(p, 'r+b') as fh:
        fh.truncate(64)
    # A malformed file is a normal event in a pool of files from strangers.
    # It must never take the whole analysis down.
    assert read_lame_tag(p) is None


def test_returns_none_rather_than_raising_on_a_missing_file(tmp_path):
    assert read_lame_tag(str(tmp_path / 'nope.mp3')) is None


@needs_lame
def test_skips_a_large_id3v2_tag_to_find_the_frame(tmp_path):
    """An ID3v2 tag holding embedded art pushes the first MPEG frame — and
    therefore the LAME tag inside it — kilobytes into the file. A reader
    that assumes offset 0 finds nothing on most real DJ files.

    LAME writes the ID3v2 tag itself here, via `--ti`. Re-muxing an existing
    MP3 through ffmpeg to attach art does NOT work and is the trap: ffmpeg's
    mp3 muxer drops the source's Xing frame and writes its own Lavc stub in
    its place, so the file under test would have no LAME tag left to find and
    the assertion would fail for a reason that has nothing to do with ID3v2.
    """
    art = str(tmp_path / 'art.jpg')
    out = str(tmp_path / 'tagged.mp3')
    # Noise, not a flat colour: a flat 600x600 JPEG is ~10 KB, and the bug
    # this guards against — reading the 28-bit synchsafe size as a plain
    # big-endian integer — grows with tag size.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi',
                    '-i', 'nullsrc=s=1400x1400', '-vf', 'geq=random(1)*255:128:128',
                    '-frames:v', '1', '-q:v', '2', art], check=True)
    subprocess.run(['lame', '--quiet', '-b', '320', '--ti', art,
                    _raw_wav(tmp_path), out], check=True)

    with open(out, 'rb') as fh:
        head = fh.read(10)
    from app.lametag import _id3v2_size
    naive = 10 + int.from_bytes(head[6:10], 'big')
    assert _id3v2_size(head) > 100 * 1024, 'the art fixture did not land a large tag'
    assert naive != _id3v2_size(head), 'this fixture cannot expose the synchsafe bug'

    tag = read_lame_tag(out)
    assert tag is not None and tag.lowpass_hz > 0


def test_a_synchsafe_size_is_not_read_as_a_plain_integer():
    """The 28-bit synchsafe size is the classic ID3v2 bug: read as a plain
    big-endian int, a 132 KB tag (every file with cover art) lands the reader
    kilobytes into the audio and it finds nothing."""
    from app.lametag import _id3v2_size

    # 0x00 0x01 0x00 0x00 synchsafe == (1 << 14) == 16384, NOT 65536.
    assert _id3v2_size(b'ID3\x04\x00\x00\x00\x01\x00\x00') == 10 + 16384
    # A high bit set anywhere means it is not a synchsafe integer at all.
    assert _id3v2_size(b'ID3\x04\x00\x00\x80\x01\x00\x00') == 0
    # No tag at all.
    assert _id3v2_size(b'\xff\xfb\x90\x00\x00\x00\x00\x00\x00\x00') == 0
    # A footer adds ten more bytes to skip.
    assert _id3v2_size(b'ID3\x04\x00\x10\x00\x00\x00\x0a') == 10 + 10 + 10
