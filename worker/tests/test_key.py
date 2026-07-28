# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import json
import os
import subprocess
from unittest.mock import patch, MagicMock

import pytest

from app.key import to_camelot, to_open_key, analyze_key, CAMELOT


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


# --- analyze_key: mocked subprocess. ---
#
# The real streaming_extractor_music binary is not installed on this
# machine -- it ships in the Task 8 Docker image. subprocess.run is patched
# to write a canned Essentia JSON document to the out_path argv element
# instead of actually invoking the binary.
#
# The canned doc mirrors the REAL output shape of the stock binary, verified
# against src/examples/streaming_extractor_music.cpp, MusicTonalDescriptors.cpp
# and musicextractor.cpp in the upstream MTG/essentia source: the extractor
# computes three FIXED key profiles -- temperley, krumhansl, edma -- together
# in a single run, each nested under its own key
# (tonal.key_edma / tonal.key_temperley / tonal.key_krumhansl), each an
# object with key/scale/strength fields. There is no keyProfile knob on this
# binary and no flat tonal.key_key/key_scale/key_strength. edmm and bgate are
# not reachable through streaming_extractor_music at all.
#
# These tests exercise argv construction (the real usage is
# `streaming_extractor_music input output` -- a bare positional 3rd-arg
# profile-YAML slot exists but we don't pass one), nested JSON parsing, and
# the edma-primary / alt_profiles assembly logic, without ever touching
# essentia. Real-binary execution against real audio is Task 8's integration
# concern.

def _profile_doc(key: str, scale: str, strength: float) -> dict:
    return {"key": key, "scale": scale, "strength": strength}


def _fake_doc(edma: tuple, temperley: tuple, krumhansl: tuple) -> dict:
    return {
        "tonal": {
            "key_edma": _profile_doc(*edma),
            "key_temperley": _profile_doc(*temperley),
            "key_krumhansl": _profile_doc(*krumhansl),
        }
    }


def _make_fake_run(doc: dict):
    """Return a fake for subprocess.run that writes the canned nested JSON
    doc to the out_path argv element (argv[2]), mimicking
    streaming_extractor_music's real positional argv: input, output."""
    def fake_run(argv, capture_output=True, check=True):
        out_path = argv[2]
        with open(out_path, "w") as fh:
            json.dump(doc, fh)
        return MagicMock(returncode=0)
    return fake_run


def test_analyze_key_uses_edma_as_primary():
    doc = _fake_doc(
        edma=("C", "major", 0.9),
        temperley=("A", "minor", 0.5),
        krumhansl=("G", "major", 0.4),
    )
    with patch("app.key.subprocess.run", side_effect=_make_fake_run(doc)):
        result = analyze_key("fake.wav")

    assert result.key == "C"
    assert result.scale == "major"
    assert result.camelot == "8B"
    assert result.open_key == "1d"
    assert result.strength == pytest.approx(0.9)


def test_analyze_key_records_alt_profiles_for_edma_temperley_krumhansl():
    doc = _fake_doc(
        edma=("C", "major", 0.9),
        temperley=("A", "minor", 0.5),
        krumhansl=("G", "major", 0.4),
    )
    with patch("app.key.subprocess.run", side_effect=_make_fake_run(doc)):
        result = analyze_key("fake.wav")

    assert set(result.alt_profiles) == {"edma", "temperley", "krumhansl"}
    assert result.alt_profiles["edma"] == "8B"
    assert result.alt_profiles["temperley"] == "8A"
    assert result.alt_profiles["krumhansl"] == "9B"


def test_analyze_key_invokes_binary_once_with_bare_positional_argv():
    """The real usage is `streaming_extractor_music input output [profile]`
    -- a bare positional 3rd argument, not a --profile flag. We pass no
    profile, so argv must be exactly [binary, input, output_tempfile]."""
    doc = _fake_doc(
        edma=("C", "major", 0.9),
        temperley=("C", "major", 0.9),
        krumhansl=("C", "major", 0.9),
    )
    fake_run = _make_fake_run(doc)
    calls = []

    def spy_run(argv, capture_output=True, check=True):
        calls.append(argv)
        return fake_run(argv, capture_output=capture_output, check=check)

    with patch("app.key.subprocess.run", side_effect=spy_run):
        analyze_key("song.wav")

    assert len(calls) == 1
    argv = calls[0]
    assert argv == ["streaming_extractor_music", "song.wav", argv[2]]
    assert len(argv) == 3
    assert "--profile" not in argv


def test_analyze_key_cleans_up_temp_file():
    doc = _fake_doc(
        edma=("C", "major", 0.9),
        temperley=("C", "major", 0.9),
        krumhansl=("C", "major", 0.9),
    )
    fake_run = _make_fake_run(doc)
    written_paths = []

    def spy_run(argv, capture_output=True, check=True):
        written_paths.append(argv[2])
        return fake_run(argv, capture_output=capture_output, check=check)

    with patch("app.key.subprocess.run", side_effect=spy_run):
        analyze_key("song.wav")

    assert len(written_paths) == 1
    assert not os.path.exists(written_paths[0])


def test_analyze_key_subprocess_failure_does_not_leak_temp_file():
    """If the binary exits non-zero, check=True raises CalledProcessError --
    the temp output file must still be cleaned up (finally), not left
    behind."""
    captured = {}

    def raise_run(argv, capture_output=True, check=True):
        captured["out_path"] = argv[2]
        raise subprocess.CalledProcessError(1, argv)

    with patch("app.key.subprocess.run", side_effect=raise_run):
        with pytest.raises(subprocess.CalledProcessError):
            analyze_key("song.wav")

    assert "out_path" in captured
    assert not os.path.exists(captured["out_path"])
