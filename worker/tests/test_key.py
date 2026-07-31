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


# --- Production failure, 2026-07-29: five Beatport MP3s died with
# --- "JSONDecodeError: Invalid control character at: line 600 column 26".
#
# streaming_extractor_music copies the file's TAGS into its output document
# verbatim, and real tags from real stores carry raw control characters.
# Python's JSON parser rejects those by default. The extractor had already
# spent ~40 vCPU-s; the audio was fine and the key was computed; the analysis
# died formatting the answer.
#
# The bug is entirely in the PARSER, so the fixture that reproduces it is a
# document, not audio — and it is reproduced here byte for byte, including
# the numbers around it, so the assertions prove the relaxation does not
# disturb anything the key detector reads.

import json

from app.key import _load_extractor_json


def _extractor_doc(tag_value: str) -> str:
    return json.dumps({
        'metadata': {'tags': {'comment': [tag_value], 'artist': ['ANMA']}},
        'tonal': {
            'key_edma': {'key': 'C', 'scale': 'minor', 'strength': 0.7412},
            'key_temperley': {'key': 'C', 'scale': 'minor'},
            'key_krumhansl': {'key': 'Eb', 'scale': 'major'},
        },
    })


def test_a_control_character_in_a_tag_is_not_an_analysis_failure(tmp_path):
    # json.dumps ESCAPES the control character, so put a raw one back in —
    # that is what the C++ writer emits.
    doc = _extractor_doc('placeholder').replace('placeholder', 'Beatport\rRelease')
    p = tmp_path / 'out.json'
    # write_bytes, NOT write_text: text mode translates a lone \r to \n on the
    # way out and the fixture would quietly stop reproducing the bug.
    p.write_bytes(doc.encode('utf-8'))

    with pytest.raises(json.JSONDecodeError):
        json.loads(doc)                      # the production failure, exactly

    got = _load_extractor_json(str(p))
    assert got['metadata']['tags']['comment'] == ['Beatport\rRelease']
    # The numbers the key detector actually reads are untouched.
    assert got['tonal']['key_edma']['strength'] == 0.7412
    assert got['tonal']['key_edma']['key'] == 'C'


@pytest.mark.parametrize('ctrl', ['\r', '\n', '\x00', '\x1f'])
def test_every_raw_control_character_survives_the_read(tmp_path, ctrl):
    p = tmp_path / 'out.json'
    p.write_bytes(_extractor_doc('placeholder')
                  .replace('placeholder', f'a{ctrl}b').encode('utf-8'))
    assert _load_extractor_json(str(p))['metadata']['tags']['comment'] == [f'a{ctrl}b']


def test_invalid_utf8_in_a_tag_is_not_an_analysis_failure_either(tmp_path):
    """The same tags are not guaranteed to be valid UTF-8. A
    UnicodeDecodeError would fail the file just as completely, one layer
    before the JSON parser ever sees it."""
    p = tmp_path / 'out.json'
    raw = _extractor_doc('placeholder').replace('placeholder', 'LATIN1').encode()
    p.write_bytes(raw.replace(b'LATIN1', b'caf\xe9'))       # 0xE9 is not UTF-8
    assert _load_extractor_json(str(p))['tonal']['key_edma']['strength'] == 0.7412


def test_genuinely_broken_json_still_raises(tmp_path):
    """strict=False relaxes control characters, not structure. A truncated
    document is a real failure and must stay one."""
    p = tmp_path / 'out.json'
    p.write_bytes(b'{"tonal": {"key_edma": ')
    with pytest.raises(json.JSONDecodeError):
        _load_extractor_json(str(p))
