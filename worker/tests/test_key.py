# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import json
from unittest.mock import patch, MagicMock

import pytest

from app.key import to_camelot, to_open_key, analyze_key, CAMELOT, PROFILES


@pytest.mark.parametrize("key,scale,expected", [
    ("C",  "major", "8B"), ("A",  "minor", "8A"),
    ("G",  "major", "9B"), ("E",  "minor", "9A"),
    ("F",  "major", "7B"), ("D",  "minor", "7A"),
    ("Db", "major", "3B"), ("Bb", "minor", "3A"),
    ("F#", "major", "2B"), ("D#", "minor", "2A"),
])
def test_camelot_mapping(key, scale, expected):
    assert to_camelot(key, scale) == expected

def test_enharmonics_agree():
    assert to_camelot("C#", "major") == to_camelot("Db", "major")
    assert to_camelot("Eb", "minor") == to_camelot("D#", "minor")

def test_all_24_camelot_codes_are_reachable_and_unique():
    seen = {to_camelot(k, s) for k, s in CAMELOT}
    assert len(seen) == 24

def test_open_key_is_camelot_rotated_by_five():
    assert to_open_key("C", "major") == "1d"
    assert to_open_key("A", "minor") == "1m"

def test_unknown_key_raises():
    with pytest.raises(KeyError):
        to_camelot("H", "major")


# --- analyze_key: mocked subprocess. The real streaming_extractor_music
# binary is not installed on this machine -- it ships in the Task 8 Docker
# image. subprocess.run is patched to write a canned Essentia JSON document
# to the out_path argv element instead of actually invoking the binary, so
# these tests exercise argv construction, JSON parsing, and the edmm-primary
# / alt_profiles assembly logic without ever touching essentia. Real-binary
# execution against real audio is Task 8's integration concern.

def _fake_doc(key: str, scale: str, strength: float) -> dict:
    return {"tonal": {"key_key": key, "key_scale": scale, "key_strength": strength}}


def _make_fake_run(docs_by_profile: dict[str, dict]):
    """Return a fake for subprocess.run that writes the right canned JSON doc
    for the profile named in argv (`--profile /etc/essentia/<profile>.yaml`)
    to the out_path argv element, mimicking streaming_extractor_music."""
    def fake_run(argv, capture_output=True, check=True):
        path, out_path = argv[1], argv[2]
        profile_arg = argv[argv.index("--profile") + 1]
        profile = profile_arg.rsplit("/", 1)[-1].removesuffix(".yaml")
        with open(out_path, "w") as fh:
            json.dump(docs_by_profile[profile], fh)
        return MagicMock(returncode=0)
    return fake_run


def test_analyze_key_uses_edmm_as_primary():
    docs = {
        "edmm": _fake_doc("C", "major", 0.9),
        "edma": _fake_doc("A", "minor", 0.5),
        "bgate": _fake_doc("G", "major", 0.4),
    }
    with patch("app.key.subprocess.run", side_effect=_make_fake_run(docs)):
        result = analyze_key("fake.wav")

    assert result.key == "C"
    assert result.scale == "major"
    assert result.camelot == "8B"
    assert result.open_key == "1d"
    assert result.strength == pytest.approx(0.9)


def test_analyze_key_records_alt_profiles_for_all_three():
    docs = {
        "edmm": _fake_doc("C", "major", 0.9),
        "edma": _fake_doc("A", "minor", 0.5),
        "bgate": _fake_doc("G", "major", 0.4),
    }
    with patch("app.key.subprocess.run", side_effect=_make_fake_run(docs)):
        result = analyze_key("fake.wav")

    assert set(result.alt_profiles) == set(PROFILES)
    assert result.alt_profiles["edmm"] == "8B"
    assert result.alt_profiles["edma"] == "8A"
    assert result.alt_profiles["bgate"] == "9B"


def test_analyze_key_invokes_binary_once_per_profile_with_correct_argv():
    docs = {p: _fake_doc("C", "major", 0.9) for p in PROFILES}
    fake_run = _make_fake_run(docs)
    calls = []

    def spy_run(argv, capture_output=True, check=True):
        calls.append(argv)
        return fake_run(argv, capture_output=capture_output, check=check)

    with patch("app.key.subprocess.run", side_effect=spy_run):
        analyze_key("song.wav")

    assert len(calls) == len(PROFILES)
    for argv in calls:
        assert argv[0] == "streaming_extractor_music"
        assert argv[1] == "song.wav"
        assert "--profile" in argv
    profiles_used = {argv[argv.index("--profile") + 1].rsplit("/", 1)[-1].removesuffix(".yaml")
                     for argv in calls}
    assert profiles_used == set(PROFILES)


def test_analyze_key_cleans_up_temp_files():
    import os
    docs = {p: _fake_doc("C", "major", 0.9) for p in PROFILES}
    fake_run = _make_fake_run(docs)
    written_paths = []

    def spy_run(argv, capture_output=True, check=True):
        written_paths.append(argv[2])
        return fake_run(argv, capture_output=capture_output, check=check)

    with patch("app.key.subprocess.run", side_effect=spy_run):
        analyze_key("song.wav")

    for p in written_paths:
        assert not os.path.exists(p)
