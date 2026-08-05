# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""Undecodable input diagnosis. A REGRESSION GUARD for the 2026-07-29 incident.

28 upload attempts (14 FLACs, each uploaded twice) whose source files were
partially-downloaded — full length pre-allocated, data present only in the
final 2 MiB-aligned piece, zeros everywhere else — landed in
files.state='failed' with ingest_jobs.last_error set to a raw
CalledProcessError string: exit status, full ffprobe argv, and a /tmp path.
Nothing the uploader could act on. The stored error must be short and human;
the technical detail belongs in the worker log only.

These tests run the real ffprobe binary against fixtures built at test time —
no mocks, no checked-in binaries.
"""
import os
import subprocess

from app import main
from app.models import AnalyzeRequest


def _real_flac_bytes(tmp_path) -> bytearray:
    """A genuine FLAC, encoded at test time — no checked-in binary fixture.

    White noise, not a sine: noise is incompressible, so the file is
    guaranteed to outgrow the 64 KiB window _leading_zeros() inspects.
    """
    out = tmp_path / "fixture.flac"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi",
         "-i", "anoisesrc=duration=3:colour=white:sample_rate=44100",
         "-c:a", "flac", str(out)],
        check=True)
    return bytearray(out.read_bytes())


def _put_upload(tmp_path, monkeypatch, file_id: str, data: bytes) -> None:
    """What PUT /file/{id} would have left on disk, under a private WORK dir."""
    monkeypatch.setattr(main, "WORK", str(tmp_path / "work"))
    d, src = main._paths(file_id)
    os.makedirs(d, exist_ok=True)
    with open(src, "wb") as fh:
        fh.write(data)


def _analyze(file_id: str):
    return main._analyze_sync(
        AnalyzeRequest(file_id=file_id, analysis_version="vtest"))


def test_zero_prefixed_file_reports_incomplete_download(tmp_path, monkeypatch, caplog):
    """The production signature: real FLAC tail, all-zero leading bytes."""
    data = _real_flac_bytes(tmp_path)
    keep = 4096
    # The zeroed prefix must cover the whole 64 KiB window _leading_zeros()
    # inspects, or the intact tail leaks into it and defeats the test.
    assert len(data) - keep > 65536, "fixture too small to zero-prefix meaningfully"
    data[:-keep] = b"\x00" * (len(data) - keep)

    _put_upload(tmp_path, monkeypatch, "zeroed", bytes(data))
    with caplog.at_level("ERROR", logger="analysis"):
        resp = _analyze("zeroed")

    assert resp.ok is False
    assert "could not be decoded" in resp.error
    assert "all zero" in resp.error          # the incomplete-download hint
    # The raw traceback string must never reach the stored error again.
    assert "CalledProcessError" not in resp.error
    assert "ffprobe" not in resp.error
    assert "/tmp" not in resp.error and "in.audio" not in resp.error
    # ...but the real diagnosis still lands in the worker log.
    assert "ffprobe" in caplog.text


def test_garbage_file_reports_corrupt_without_zero_hint(tmp_path, monkeypatch):
    """Undecodable but NOT zero-prefixed: generic message, no download hint."""
    data = bytes(range(1, 256)) * 512      # nonzero garbage, no valid header
    _put_upload(tmp_path, monkeypatch, "garbage", data)

    resp = _analyze("garbage")

    assert resp.ok is False
    assert "could not be decoded" in resp.error
    assert "incomplete or corrupt" in resp.error
    assert "all zero" not in resp.error
    assert "CalledProcessError" not in resp.error


def test_empty_file_gets_generic_message_not_zero_hint(tmp_path, monkeypatch):
    """Zero bytes on disk is not 'leading bytes are all zero' — no false hint."""
    _put_upload(tmp_path, monkeypatch, "empty", b"")

    resp = _analyze("empty")

    assert resp.ok is False
    assert "could not be decoded" in resp.error
    assert "all zero" not in resp.error
