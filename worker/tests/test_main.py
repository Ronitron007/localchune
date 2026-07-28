# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""Tests for the pieces of app.main that are pure logic.

The extension tests are a REGRESSION GUARD, not decoration. Bytes arrive over
PUT with no filename, and Task 8 measured streaming_extractor_music failing
on the deployed container purely because the working file had no suffix:
exit 1 with "pcmMetadata cannot read files which are neither wav nor aiff",
on a FLAC that the same binary reads happily when it is named .flac. Nothing
about the content changed. If _link_with_extension is ever removed as
redundant, key detection dies for every upload and the only symptom is a
non-zero exit code.
"""
import os

import pytest

from app.main import _extension_for, _link_with_extension, _paths


@pytest.mark.parametrize("format_name,expected", [
    ("flac", "flac"),
    ("wav", "wav"),
    ("mp3", "mp3"),
    ("ogg", "ogg"),
    ("aiff", "aiff"),
    # ffprobe reports every demuxer that matched; the first is canonical.
    ("mov,mp4,m4a,3gp,3g2,mj2", "m4a"),
    ("matroska,webm", "mkv"),
    ("asf", "wma"),
    ("  FLAC  ", "flac"),
])
def test_extension_for(format_name, expected):
    assert _extension_for(format_name) == expected


def test_extension_for_never_returns_empty():
    """An empty suffix would rebuild the exact bug this guards against."""
    assert _extension_for("") == "bin"


def test_link_with_extension_shares_bytes_and_keeps_the_original(tmp_path):
    src = tmp_path / "in.audio"
    src.write_bytes(b"RIFFfake")
    link = _link_with_extension(str(src), "wav")

    assert link.endswith(".wav")
    assert os.path.isfile(link)
    # The original name survives, so a retried analysis still finds it.
    assert src.exists()
    # Same bytes, one copy on disk: a 15-minute FLAC must not be duplicated.
    assert os.path.samefile(link, str(src))


def test_link_with_extension_is_idempotent(tmp_path):
    src = tmp_path / "in.audio"
    src.write_bytes(b"x")
    first = _link_with_extension(str(src), "flac")
    second = _link_with_extension(str(src), "flac")
    assert first == second


def test_paths_refuses_to_escape_the_work_directory():
    """file_id arrives from a queue message and is pasted into a path."""
    d, src = _paths("../../etc/passwd")
    assert "/etc/passwd" not in d
    assert d.endswith("passwd")
    assert src.startswith(d)
