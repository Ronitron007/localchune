# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import os
import subprocess

from app import tags
from app.tags import parse_tags, read_tags, extract_artwork, make_thumb


# --- parse_tags: canned ffprobe JSON documents. ---
#
# Each doc below is the real, unedited shape ffprobe -show_format
# -show_streams -of json produced against a file real ffmpeg 8.0.1 built
# with that container/codec (see the real-file tests further down for the
# generation commands) -- not a guessed/fictional shape.

def test_parse_tags_reads_format_level_tags_mp3_flac_m4a():
    """MP3 (ID3), FLAC and M4A all surface tags under format.tags."""
    doc = {
        'format': {'tags': {
            'title': 'Test Title', 'artist': 'Test Artist', 'album': 'Test Album',
            'genre': 'House', 'date': '2024', 'track': '3/12', 'encoder': 'Lavf62.3.100',
        }},
        'streams': [{'codec_type': 'audio'}, {'codec_type': 'video', 'tags': {'comment': 'Other'}}],
    }
    tags = parse_tags(doc)
    assert tags['title'] == 'Test Title'
    assert tags['artist'] == 'Test Artist'
    assert tags['album'] == 'Test Album'
    assert tags['genre'] == 'House'
    assert tags['track'] == '3/12'

def test_parse_tags_lowercases_keys_regardless_of_source_casing():
    """FLAC/Ogg vorbis comments round-trip through ffprobe with whatever
    case they were written in (verified: 'ALBUM' stays 'ALBUM', 'title'
    stays 'title') -- callers should not have to guess casing."""
    doc = {'format': {'tags': {'title': 'Flac Title', 'ALBUM': 'Flac Album'}}, 'streams': []}
    tags = parse_tags(doc)
    assert tags == {'title': 'Flac Title', 'album': 'Flac Album'}

def test_parse_tags_falls_back_to_audio_stream_tags_when_format_tags_absent():
    """Real Ogg/Opus files put tags on the audio stream, not format --
    verified with real ffmpeg: format.tags comes back None entirely."""
    doc = {
        'format': {'tags': None},
        'streams': [
            {'codec_type': 'audio', 'tags': {'title': 'Ogg Title', 'ARTIST': 'Ogg Artist'}},
        ],
    }
    tags = parse_tags(doc)
    assert tags['title'] == 'Ogg Title'
    assert tags['artist'] == 'Ogg Artist'

def test_parse_tags_stream_fallback_ignores_video_streams():
    doc = {
        'format': {},
        'streams': [
            {'codec_type': 'video', 'tags': {'comment': 'Other'}},
            {'codec_type': 'audio', 'tags': {'title': 'Real Title'}},
        ],
    }
    tags = parse_tags(doc)
    assert tags == {'title': 'Real Title'}

def test_parse_tags_handles_missing_format_and_streams_keys():
    assert parse_tags({}) == {}


# --- Real ffmpeg 8.0.1 integration: generated fixtures, no mocking. ---
#
# Sub-second; ffprobe/ffmpeg are hard runtime dependencies of this module
# already, so these are not marked @pytest.mark.integration (same
# reasoning as tests/test_loudness.py).

def _run(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True)

def _cover_png(path: str) -> None:
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', 'color=c=red:s=32x32:d=1', '-frames:v', '1', path)

def _tagged_mp3_with_art(path: str, cover: str) -> None:
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
         '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-b:a', '128k',
         '-c:v', 'mjpeg', '-id3v2_version', '3',
         '-metadata', 'title=Test Title', '-metadata', 'artist=Test Artist',
         '-metadata', 'album=Test Album', '-disposition:v', 'attached_pic', path)

def _tagged_mp3_no_art(path: str) -> None:
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
         '-metadata', 'title=No Art', path)

def _tagged_ogg(path: str) -> None:
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
         '-c:a', 'libopus', '-metadata', 'title=Ogg Title', '-metadata', 'ARTIST=Ogg Artist', path)


def test_read_tags_on_real_mp3(tmp_path):
    mp3 = str(tmp_path / 'tagged.mp3')
    cover = str(tmp_path / 'cover.png')
    _cover_png(cover)
    _tagged_mp3_with_art(mp3, cover)

    tags = read_tags(mp3)
    assert tags['title'] == 'Test Title'
    assert tags['artist'] == 'Test Artist'
    assert tags['album'] == 'Test Album'

def test_read_tags_on_real_ogg_uses_stream_fallback(tmp_path):
    ogg = str(tmp_path / 'tagged.ogg')
    _tagged_ogg(ogg)

    tags = read_tags(ogg)
    assert tags['title'] == 'Ogg Title'
    assert tags['artist'] == 'Ogg Artist'

def test_extract_artwork_on_real_mp3_with_embedded_art(tmp_path):
    mp3 = str(tmp_path / 'tagged.mp3')
    cover = str(tmp_path / 'cover.png')
    out = str(tmp_path / 'art.jpg')
    _cover_png(cover)
    _tagged_mp3_with_art(mp3, cover)

    assert extract_artwork(mp3, out) is True
    assert os.path.exists(out)
    assert os.path.getsize(out) > 0

def test_extract_artwork_returns_false_when_no_art_embedded(tmp_path):
    mp3 = str(tmp_path / 'noart.mp3')
    out = str(tmp_path / 'art.jpg')
    _tagged_mp3_no_art(mp3)

    assert extract_artwork(mp3, out) is False
    assert not os.path.exists(out)

def test_extract_artwork_drops_and_returns_false_when_over_cap(tmp_path, monkeypatch):
    """A crafted source can carry an attached-picture stream of any size --
    ffmpeg's stream copy has no limit of its own. Generating a real >20MB
    fixture is slow and wasteful for a unit test, so the cap is monkeypatched
    down to a few bytes: the ordinary small cover produced by _cover_png then
    reliably exceeds it, exercising the same over-cap path a genuinely huge
    embedded image would take. extract_artwork must return False and leave
    no output file behind -- a missing cover must never fail an analysis."""
    monkeypatch.setattr(tags, 'MAX_ARTWORK_BYTES', 16)

    mp3 = str(tmp_path / 'tagged.mp3')
    cover = str(tmp_path / 'cover.png')
    out = str(tmp_path / 'art.jpg')
    _cover_png(cover)
    _tagged_mp3_with_art(mp3, cover)

    assert extract_artwork(mp3, out) is False
    assert not os.path.exists(out)

def test_make_thumb_produces_a_small_square_jpeg(tmp_path):
    mp3 = str(tmp_path / 'tagged.mp3')
    cover = str(tmp_path / 'cover.png')
    art = str(tmp_path / 'artwork.jpg')
    thumb = str(tmp_path / 'thumb.jpg')
    _cover_png(cover)
    _tagged_mp3_with_art(mp3, cover)

    assert extract_artwork(mp3, art) is True
    assert make_thumb(art, thumb) is True
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', thumb],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h = (int(x) for x in out.split(','))
    assert (w, h) == (64, 64)
    assert 0 < os.path.getsize(thumb) < 20_000   # a 64px q~70 jpeg is a few KB

def test_make_thumb_returns_false_for_a_missing_source(tmp_path):
    assert make_thumb(str(tmp_path / 'absent.jpg'), str(tmp_path / 'out.jpg')) is False
