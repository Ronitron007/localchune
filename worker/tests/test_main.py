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


# --- Task 1 (M4): the forensic verdict, end to end through _analyze_sync.
#
# Every number under test is MEASURED from audio a real encoder produced at
# test time. Nothing here is a hand-built fixture and nothing here is mocked
# on the forensic path: decode.windows, measure_spectrum, measure_cutoff,
# hf_ref_delta_db, effective_bit_depth, effective_sample_rate,
# read_lame_tag, classify_ancestor, quality_tier, quality_score and the
# sha256 pass all run for real, in the order main.py runs them.
#
# TWO stages are stubbed, and only two: analyze_beats (a 77 MB torch model,
# ~30 s of inference that no forensic assertion here depends on) and
# key.analyze_key (Essentia's streaming_extractor_music, which exists only
# inside the container image). Both are Optional in AnalyzeResponse and both
# already have their own dedicated test files. Stubbing anything on the
# forensic path would defeat the point of the file.

import shutil
import subprocess

from app import main
from app.models import AnalyzeRequest


def _run(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True)


def _noise_wav(path: str, seconds: int, seed: int, lowpass_hz: int | None = None) -> None:
    # ffmpeg's `lowpass` is a biquad — poles is 1 or 2, nothing else, and a
    # 2-pole 12 dB/octave slope leaves 14-16 kHz only ~19 dB below the
    # 1-4 kHz reference, nowhere near the -60 dB abstain gate. Five stages
    # chained give 60 dB/octave, which puts 15 kHz ~89 dB down: a genuinely
    # dark master rather than a slightly muffled one.
    chain = ','.join(['lowpass=f=%d:poles=2' % lowpass_hz] * 5) if lowpass_hz else ''
    af = ['-af', chain] if chain else []
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', f'anoisesrc=color=white:duration={seconds}:sample_rate=44100:seed={seed}',
         '-ac', '2', *af, path)


@pytest.fixture
def staged(monkeypatch, tmp_path):
    """Put a file where PUT /file/{id} would have put it, and stub the two
    stages whose binaries live only in the container image."""
    monkeypatch.setattr(main, 'WORK', str(tmp_path / 'work'))
    monkeypatch.setattr(main, 'analyze_beats', lambda pcm, sr: None)
    monkeypatch.setattr(main.key, 'analyze_key', lambda src: None)

    def stage(file_id: str, audio_path: str):
        d, src = main._paths(file_id)
        os.makedirs(d, exist_ok=True)
        shutil.copyfile(audio_path, src)
        return main._analyze_sync(
            AnalyzeRequest(file_id=file_id, analysis_version='v2'))
    return stage


@pytest.fixture
def real_flac(tmp_path):
    """A genuine full-band lossless master. Never encoded lossily."""
    wav = str(tmp_path / 'clean.wav')
    flac = str(tmp_path / 'clean.flac')
    _noise_wav(wav, seconds=45, seed=7)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, flac)
    return flac


@pytest.fixture
def fake_flac(tmp_path):
    """THE anti-cheat target: white noise -> real `ffmpeg -c:a libmp3lame
    -b:a 128k` -> decoded back to PCM -> wrapped as FLAC. Byte for byte a
    lossless file; its audio brickwalls at ~16.8 kHz and always will."""
    wav = str(tmp_path / 'master.wav')
    mp3 = str(tmp_path / 'lossy.mp3')
    flac = str(tmp_path / 'fake.flac')
    _noise_wav(wav, seconds=45, seed=42)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k', mp3)
    _run('ffmpeg', '-y', '-v', 'error', '-i', mp3, '-c:a', 'flac', flac)
    return flac


@pytest.fixture
def dark_flac(tmp_path):
    """A legitimately dark master — a real lossless file with almost no
    energy above 5 kHz. It must be abstained on, never accused."""
    wav = str(tmp_path / 'dark.wav')
    flac = str(tmp_path / 'dark.flac')
    _noise_wav(wav, seconds=45, seed=11, lowpass_hz=5000)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, flac)
    return flac


def test_analyze_returns_a_real_forensics_verdict(staged, real_flac):
    r = staged('f1', real_flac)
    assert r.ok, r.error
    assert r.forensics is not None, \
        'forensics=None was M3s honest placeholder. Task 1 ends it.'
    assert r.forensics.meas_eff_bit_depth > 0
    assert r.forensics.lossy_ancestor in ('none', 'suspected', 'confirmed', 'abstain')
    assert 1 <= r.forensics.tier <= 5
    assert len(r.content_sha256) == 64
    assert int(r.content_sha256, 16) >= 0        # it is hex, not a placeholder


def test_content_sha256_is_the_digest_of_the_bytes_that_arrived(staged, real_flac):
    """Hashed from the ORIGINAL path, not the extension-bearing hard link.
    Same inode either way, but src is rebound partway through _analyze_sync
    and a reader should not have to prove that to themselves."""
    import hashlib
    r = staged('f1', real_flac)
    assert r.content_sha256 == hashlib.sha256(open(real_flac, 'rb').read()).hexdigest()


def test_a_clean_lossless_master_is_never_accused(staged, real_flac):
    r = staged('f1', real_flac)
    assert r.forensics.lossy_ancestor == 'none'
    assert r.forensics.tier == 5
    assert r.forensics.meas_eff_bit_depth == 16
    assert r.forensics.lame_tag_present is False


def test_a_flac_wrapping_a_128kbps_mp3_gets_its_tier_from_bandwidth(staged, fake_flac):
    # THE anti-cheat, end to end for the first time: a lossless CONTAINER
    # with a confirmed lossy ancestor must not reach tier 5.
    r = staged('f2', fake_flac)
    assert r.ok, r.error
    assert r.container == 'flac'
    assert r.forensics.lossy_ancestor == 'confirmed'
    assert r.forensics.tier == 1
    assert r.forensics.inferred_source_kbps == 128
    assert r.forensics.meas_cutoff_hz < 17000


def test_a_dark_master_abstains_and_keeps_its_lossless_tier(staged, dark_flac):
    """Abstention before accusation. A quiet master lands at tier 4, not at
    the tier its (perfectly real) 5 kHz bandwidth would otherwise buy."""
    r = staged('f3', dark_flac)
    assert r.ok, r.error
    assert r.forensics.lossy_ancestor == 'abstain'
    assert r.forensics.tier == 4


def test_the_quality_score_is_a_number_not_a_placeholder(staged, real_flac, fake_flac):
    good = staged('f1', real_flac).forensics
    bad = staged('f2', fake_flac).forensics
    assert good.quality_score > bad.quality_score + 8, \
        'is_upgrade needs an 8-point margin to be able to prefer the real one'


def test_forensics_reports_every_input_its_own_score_was_built_from(
        staged, real_flac, fake_flac):
    """M4 Task 4's concern 2, closed at the producer.

    quality_score() takes ten inputs. Three of them — lame_disagrees,
    mono_vs_stereo, decode_errors — were computed here and then dropped, so
    nothing downstream could rebuild the score or run is_upgrade() on it.
    They travel on the response now. The assertion that matters is the last
    one: the reported inputs must REPRODUCE the reported score, or they are
    decoration.
    """
    from app import forensics
    for f, src in (('f1', real_flac), ('f2', fake_flac)):
        r = staged(f, src)
        fo = r.forensics
        assert isinstance(fo.lame_disagrees, bool)
        assert isinstance(fo.mono_vs_stereo, bool)
        assert fo.decode_errors is False
        assert fo.mono_vs_stereo is (r.channels < 2)
        assert forensics.quality_score(
            tier=fo.tier, cutoff_hz=fo.meas_cutoff_hz,
            eff_bits=fo.meas_eff_bit_depth, eff_sr=fo.meas_eff_sample_rate,
            inferred_kbps=fo.inferred_source_kbps or 0,
            lame_disagrees=fo.lame_disagrees,
            clipped_pct=r.loudness.clipped_pct / 100.0,
            true_peak=r.loudness.true_peak_dbtp,
            mono_vs_stereo=fo.mono_vs_stereo,
            decode_errors=fo.decode_errors,
        ) == fo.quality_score


def test_lame_disagrees_says_the_same_thing_the_tag_and_the_spectrum_do(
        staged, real_mp3, fake_flac):
    """lame_disagrees is the -6 term in the score AND is_upgrade()'s
    fake-FLAC veto, so it has to mean one thing.

    Two cases, and the second is the one worth writing down: re-encoding an
    MP3 to FLAC does NOT carry the LAME tag across — the tag lives in the
    MP3 bitstream and the FLAC has no bitstream. So the fake FLAC is
    convicted by its cutoff alone, with lame_disagrees False, and a caller
    that read that boolean as "this is honest" would be wrong. It is
    "nothing to disagree with".
    """
    for f, src in (('f4', real_mp3), ('f2', fake_flac)):
        fo = staged(f, src).forensics
        if fo.lame_tag_present:
            assert fo.lame_disagrees is (
                abs(fo.lame_lowpass_hz - fo.meas_cutoff_hz) > 1500)
        else:
            assert fo.lame_disagrees is False, \
                'no tag means nothing to disagree with, never "it disagrees"'

    flac = staged('f2', fake_flac).forensics
    assert flac.lame_tag_present is False, \
        'ffmpeg -c:a libmp3lame writes no LAME tag (test_lametag.py), and a ' \
        'FLAC re-encode would not carry one across anyway'
    assert flac.lossy_ancestor == 'confirmed', \
        'the cutoff convicts it; the absent tag neither helps nor hurts'


@pytest.fixture
def real_mp3(tmp_path):
    wav = str(tmp_path / 'm.wav')
    mp3 = str(tmp_path / 'm.mp3')
    _noise_wav(wav, seconds=45, seed=3)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', mp3)
    return mp3


def test_a_lossy_file_is_not_credited_with_a_32_bit_master(staged, real_mp3):
    """A lossy decoder emits full-precision samples — measured, every MP3
    reads 32 significant bits. Reporting that would pay an MP3 the whole
    6-point "better than 16-bit" bonus and eat three quarters of the margin
    is_upgrade() needs before it prefers a real FLAC."""
    r = staged('f4', real_mp3)
    assert r.ok, r.error
    assert r.container == 'mp3'
    assert r.forensics.meas_eff_bit_depth == 0


def test_a_real_flac_still_outscores_a_320_mp3_on_bit_depth(staged, real_flac, real_mp3):
    flac = staged('f1', real_flac).forensics
    mp3 = staged('f4', real_mp3).forensics
    assert flac.quality_score > mp3.quality_score


@pytest.fixture
def alac_m4a(tmp_path):
    """Real ALAC in a real mov/m4a container — ffprobe calls the container
    'mov' and only the codec says it is lossless."""
    wav = str(tmp_path / 'a.wav')
    out = str(tmp_path / 'a.m4a')
    _noise_wav(wav, seconds=45, seed=21)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'alac', out)
    return out


@pytest.fixture
def aac_m4a(tmp_path):
    wav = str(tmp_path / 'b.wav')
    out = str(tmp_path / 'b.m4a')
    _noise_wav(wav, seconds=45, seed=22)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '256k', out)
    return out


def test_alac_in_an_m4a_is_judged_by_its_codec_not_its_container(staged, alac_m4a):
    """334 of production's 549 files report container 'mov'. That family
    carries AAC or ALAC, and only the codec tells them apart."""
    r = staged('f5', alac_m4a)
    assert r.ok, r.error
    assert r.container == 'mov' and r.codec == 'alac'
    assert r.forensics.meas_eff_bit_depth == 16, \
        'a lossless codec must get a MEASURED bit depth, not the lossy 0'
    assert r.forensics.tier == 5


def test_aac_in_the_same_container_is_not_promoted_by_the_same_change(staged, aac_m4a):
    r = staged('f6', aac_m4a)
    assert r.ok, r.error
    assert r.container == 'mov' and r.codec == 'aac'
    assert r.forensics.meas_eff_bit_depth == 0
    assert r.forensics.tier <= 3


@pytest.fixture
def dark_aac_256k(tmp_path):
    """The 02 GOLD case, rebuilt by real encoders: a dark master (gentle EQ
    rolloff, no wall) encoded at a real 256 kbps AAC. Two 2-pole stages give
    24 dB/octave — a genuine content rolloff, nothing like the 30+ dB/500 Hz
    wall an encoder lowpass leaves."""
    wav = str(tmp_path / 'dark.wav')
    out = str(tmp_path / 'dark256.m4a')
    _noise_wav(wav, seconds=45, seed=33)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav,
         '-af', 'lowpass=f=16000:poles=2,lowpass=f=16000:poles=2',
         '-c:a', 'aac', '-b:a', '256k', out)
    return out


@pytest.fixture
def real_128k_mp3(tmp_path):
    wav = str(tmp_path / 'c.wav')
    out = str(tmp_path / 'c128.mp3')
    _noise_wav(wav, seconds=45, seed=44)
    _run('ffmpeg', '-y', '-v', 'error', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '128k', out)
    return out


def test_a_256k_aac_of_a_dark_master_is_not_graded_as_a_128k_file(staged, dark_aac_256k):
    """PRODUCTION REGRESSION. '02 GOLD.m4a' — a verified iTunes Plus 256k
    purchase — measured cutoff 16387 Hz, cliff 2.52 dB, ancestor 'none', and
    landed at tier 1. classify_ancestor refused to accuse it; the tier
    demoted it anyway, reading a dark hip-hop master's own rolloff as
    evidence of a lossy ancestor."""
    r = staged('f7', dark_aac_256k)
    assert r.ok, r.error
    assert r.forensics.lossy_ancestor in ('none', 'abstain'), 'must not be accused'
    assert r.forensics.meas_cliff_db_500 < 15, \
        'the fixture must have a SOFT rolloff or it proves nothing'
    assert r.forensics.tier == 3


def test_a_real_128kbps_encode_still_lands_at_tier_one(staged, real_128k_mp3):
    """The other half of the same rule. A real 128 kbps file has a WALL, so
    the measured bandwidth still decides and the fix cannot rescue it."""
    r = staged('f8', real_128k_mp3)
    assert r.ok, r.error
    assert r.forensics.meas_cliff_db_500 >= 15, 'a real 128k encode leaves a wall'
    assert r.forensics.tier == 1
