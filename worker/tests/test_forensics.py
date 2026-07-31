# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import numpy as np, pytest
from app.forensics import (measure_cutoff, classify_ancestor, quality_tier,
                           quality_score, is_upgrade, CUTOFF_TABLE)

def _band_limited(cutoff_hz, sr=44100, n=44100*10):
    """White noise brickwalled at cutoff_hz — stands in for a lossy encode."""
    rng = np.random.default_rng(0)
    spec = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    spec[freqs > cutoff_hz] = 0
    x = np.fft.irfft(spec, n).astype(np.float32)
    return np.stack([x, x], axis=1)

@pytest.mark.parametrize("cutoff", [16000, 19000, 20500])
def test_measure_cutoff_finds_a_brickwall(cutoff):
    got, cliff = measure_cutoff([_band_limited(cutoff)], 44100)
    assert abs(got - cutoff) < 700
    assert cliff >= 30

def test_full_band_noise_reports_no_brickwall():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(441000).astype(np.float32)
    got, cliff = measure_cutoff([np.stack([x, x], axis=1)], 44100)
    assert got >= 20800
    assert cliff < 15

def test_lame_tag_disagreement_confirms_transcode():
    """The cheapest, highest-value check: the bitstream says 20.5kHz,
    the audio brickwalls at 16kHz. Near-zero false positives."""
    assert classify_ancestor(cutoff_hz=16000, cliff_db=35,
                             lame_lowpass_hz=20500, usable_windows=8,
                             hf_ref_delta_db=-20) == 'confirmed'

def test_dark_master_abstains_rather_than_accusing():
    assert classify_ancestor(cutoff_hz=15000, cliff_db=35, lame_lowpass_hz=None,
                             usable_windows=8, hf_ref_delta_db=-70) == 'abstain'

def test_soft_rolloff_is_not_a_transcode():
    assert classify_ancestor(cutoff_hz=17000, cliff_db=8, lame_lowpass_hz=None,
                             usable_windows=8, hf_ref_delta_db=-20) == 'none'

def test_fake_flac_gets_its_tier_from_measured_bandwidth_not_the_container():
    """The entire anti-cheat, in one assertion."""
    assert quality_tier(container='flac', ancestor='confirmed',
                        cutoff_hz=16000, eff_bits=16) == 1
    assert quality_tier(container='flac', ancestor='none',
                        cutoff_hz=21500, eff_bits=16) == 5

def test_abstained_lossless_lands_at_tier_four():
    assert quality_tier(container='flac', ancestor='abstain',
                        cutoff_hz=15000, eff_bits=16) == 4

def _f(**kw):
    base = dict(tier=3, cutoff_hz=19500, eff_bits=16, eff_sr=44100,
                inferred_kbps=320, lame_disagrees=False, clipped_pct=0.0,
                true_peak=-1.0, mono_vs_stereo=False, decode_errors=False)
    return {**base, **kw}

def test_real_flac_beats_a_320_mp3():
    a = quality_score(**_f(tier=3, cutoff_hz=19500))
    b = quality_score(**_f(tier=5, cutoff_hz=21500, inferred_kbps=0))
    assert b > a + 8

def test_fake_320_does_not_beat_a_real_320():
    real = _f(tier=3, cutoff_hz=19500)
    fake = _f(tier=2, cutoff_hz=16000, lame_disagrees=True)
    ok, reason = is_upgrade(real, fake)
    assert ok is False
    assert 'not better' in reason or 'fake' in reason

def test_a_genuine_flac_upgrade_over_a_128_is_accepted():
    incumbent = _f(tier=1, cutoff_hz=16000, inferred_kbps=128)
    candidate = _f(tier=5, cutoff_hz=21500, inferred_kbps=0)
    ok, _ = is_upgrade(incumbent, candidate)
    assert ok is True

def test_a_clipped_candidate_is_never_an_upgrade():
    incumbent = _f(tier=3, cutoff_hz=19500)
    candidate = _f(tier=5, cutoff_hz=21500, clipped_pct=0.5)
    ok, reason = is_upgrade(incumbent, candidate)
    assert ok is False
    assert 'clip' in reason


# --- Real ffmpeg 8.0.1 / libmp3lame integration. ---
#
# The brief's own tests above only exercise measure_cutoff against a
# mathematically perfect digital brickwall (spec[freqs > cutoff] = 0, exactly
# zero energy past the edge) and classify_ancestor against hand-picked
# numbers. Neither can catch a bug that only shows up on a REAL encoder's
# output. This generates a real "fake FLAC" — white noise -> real
# `ffmpeg -c:a libmp3lame -b:a 128k` -> decoded back to WAV, i.e. exactly the
# artifact a friend hands over believing it's lossless — and a real full-band
# lossless fixture, no mocking, using app.decode.windows() (the same forensic
# sampler the real pipeline uses, not a hand-built list).
#
# This caught two real brief-vs-reality bugs, neither reachable from the
# brief's own tests:
#
# 1. classify_ancestor's CUTOFF_TABLE maps 128kbps -> 16000Hz. A real
#    128kbps ffmpeg/libmp3lame encode of white noise brickwalls cleanly
#    (>30dB cliff) at ~16850Hz, consistently, across four independent
#    encodes — ~800Hz outside the +-400Hz match window, which silently
#    downgraded a genuine 128kbps fake FLAC from 'confirmed' to 'none'.
#    Fixed by recalibrating that one table entry to 16800 (see the comment
#    on CUTOFF_TABLE in app.forensics).
# 2. measure_cutoff's spur-rejection required 5 consecutive above-threshold
#    bins. That is safe against the brief's single 10s window (~40 FFT
#    frames) but not against a real forensic sample (8 windows x 2 channels,
#    ~1600 max-held frames): max-hold over that many frames gives a real
#    encoder's stopband quantization noise thousands of chances to produce a
#    5-bin run above threshold purely by chance. 1 of 3 tested noise seeds
#    hit this and misreported a confirmed 128kbps brickwall as full-band/no
#    -cutoff. Fixed by raising the run requirement to 20 bins (still two
#    orders of magnitude below a genuine transition band or the in-band bulk
#    run) — see the comment in app.forensics.measure_cutoff.
#
# Sub-second each; not marked @pytest.mark.integration — ffmpeg is a hard
# runtime dependency of this module already (like the loudness/tags tests).

import subprocess
from app.decode import windows as decode_windows

def _run(*args: str) -> None:
    subprocess.run(list(args), check=True, capture_output=True)

def _white_noise_wav(path: str, duration: float = 60.0, seed: int | None = None) -> None:
    src = f'anoisesrc=color=white:duration={duration}:sample_rate=44100'
    if seed is not None:
        src += f':seed={seed}'
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', src, '-ac', '2', path)

def _real_128k_mp3_roundtrip(tmp_path, seed: int) -> str:
    """White noise -> real 128kbps CBR MP3 (real libmp3lame) -> decoded WAV.

    This is a genuine "fake FLAC" ancestor: a lossy encode, decoded back to
    PCM, indistinguishable at the container level from a true lossless
    master.
    """
    src = str(tmp_path / f'master_{seed}.wav')
    mp3 = str(tmp_path / f'lossy_{seed}.mp3')
    dec = str(tmp_path / f'fakeflac_{seed}.wav')
    _white_noise_wav(src, seed=seed)
    _run('ffmpeg', '-y', '-v', 'error', '-i', src, '-c:a', 'libmp3lame', '-b:a', '128k', mp3)
    _run('ffmpeg', '-y', '-v', 'error', '-i', mp3, '-c:a', 'pcm_s16le', dec)
    return dec

@pytest.mark.parametrize("seed", [1, 42, 999, 2024, 31337])
def test_real_128kbps_fake_flac_is_confirmed_near_16khz(tmp_path, seed):
    """A real 128kbps MP3 decoded back to WAV -- the actual anti-cheat target
    -- must measure a brickwall near 16kHz and be classified 'confirmed'.

    Seed 999 is the specific case that caught bug #2 above (spurious 5-bin
    run past 20800Hz on this noise realisation, pre-fix) -- kept in the
    parametrization as a regression pin, not just a smoke test.

    Seeds 2024 and 31337 are permanent regressions for the adaptive-floor
    fix: at RUN=20 (bug #2's fix) these two still false-negatived to 'none'.
    Real LAME's stopband noise floor sits ~1dB ABOVE the fixed ref-50dB
    threshold across the entire stopband (~950 consecutive bins) on these
    noise realisations -- no RUN value rejects a sustained excursion that
    size, only an adaptive threshold that measures the actual floor. See the
    comment in app.forensics.measure_cutoff.
    """
    dec = _real_128k_mp3_roundtrip(tmp_path, seed)
    w = decode_windows(dec, count=8, secs=10, duration_s=60.0)
    assert len(w) == 8
    cutoff, cliff = measure_cutoff(w, 44100)
    assert abs(cutoff - 16850) < 700, f'cutoff {cutoff}Hz not near real 128kbps lowpass'
    assert cliff >= 30
    verdict = classify_ancestor(cutoff_hz=cutoff, cliff_db=cliff, lame_lowpass_hz=None,
                                usable_windows=len(w), hf_ref_delta_db=-10.0)
    assert verdict == 'confirmed'

def test_real_untouched_lossless_noise_is_none(tmp_path):
    """A real full-band lossless WAV, never encoded lossily, must NOT be
    flagged -- the clean counterpart to the fake-FLAC case above."""
    src = str(tmp_path / 'clean.wav')
    _white_noise_wav(src, seed=7)
    w = decode_windows(src, count=8, secs=10, duration_s=60.0)
    assert len(w) == 8
    cutoff, cliff = measure_cutoff(w, 44100)
    assert cutoff >= 20800
    verdict = classify_ancestor(cutoff_hz=cutoff, cliff_db=cliff, lame_lowpass_hz=None,
                                usable_windows=len(w), hf_ref_delta_db=-10.0)
    assert verdict == 'none'


# --- Task 1 (M4): the three producers classify_ancestor and quality_tier
# --- have always needed and nothing has ever computed.
#
# measure_spectrum() is an EXTRACTION from measure_cutoff(), so the first
# test below is the regression pin: the public signature and the numbers it
# returns must survive the refactor untouched.

import os
from app import forensics


def _stereo(x: np.ndarray) -> np.ndarray:
    return np.stack([x, x], axis=1)


def _brickwall_windows(sr: int, cutoff: int) -> list[np.ndarray]:
    return [_band_limited(cutoff, sr=sr)]


def _dark_windows(sr: int) -> list[np.ndarray]:
    """A dark master: real energy through the 1-4 kHz reference band, and
    NOTHING at 14-16 kHz.

    Deviation from the brief, which built this from 220 Hz + 440 Hz tones and
    called it 'nothing above 1 kHz'. Two pure tones leave the 1-4 kHz
    REFERENCE band at the numerical noise floor as well, so the delta the
    test asserts on would be a ratio of two leakage floors — a number decided
    by float32 rounding, not by the audio. A hard 5 kHz brickwall is the
    honest fixture: the reference band is real signal, the 14-16 kHz band is
    genuinely empty, and the delta means what classify_ancestor() reads it to
    mean.
    """
    return [_band_limited(5000, sr=sr)]


def _noise_windows(sr: int, seed: int) -> list[np.ndarray]:
    rng = np.random.default_rng(seed)
    return [_stereo(rng.standard_normal(sr * 10).astype(np.float32))]


def _write_wav(tmp_path, bits: int, sr: int = 44100, dither: bool = False) -> str:
    fmt = {16: 'pcm_s16le', 24: 'pcm_s24le'}[bits]
    out = str(tmp_path / f'src{bits}.wav')
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', f'anoisesrc=color=white:duration=4:sample_rate={sr}:seed=5',
         '-ac', '2', '-c:a', fmt, out)
    return out


def test_hf_ref_delta_db_is_negative_and_large_for_a_dark_master():
    # classify_ancestor abstains below -60 dB. That gate is the difference
    # between "we could not tell" and "we accuse you", so its input has to
    # be a real measurement, not a constant.
    sr = 44100
    spec = forensics.measure_spectrum(_dark_windows(sr), sr)
    assert forensics.hf_ref_delta_db(spec) < -60


def test_hf_ref_delta_db_is_near_zero_for_full_band_noise():
    sr = 44100
    spec = forensics.measure_spectrum(_noise_windows(sr, seed=7), sr)
    assert -12 < forensics.hf_ref_delta_db(spec) < 6


def test_hf_ref_delta_db_of_nothing_abstains_rather_than_crashing():
    """measure_spectrum returns None when there are no usable windows — a
    zero-length decode, a file that is all silence. classify_ancestor must
    receive a number that lands it in 'abstain', not a TypeError."""
    assert forensics.hf_ref_delta_db(None) < -60
    assert forensics.measure_spectrum([], 44100) is None


def test_measure_cutoff_is_unchanged_by_the_refactor():
    # measure_spectrum() is extracted FROM measure_cutoff(); the public
    # signature and every existing assertion must survive untouched.
    sr = 44100
    wins = _brickwall_windows(sr, cutoff=16800)
    assert abs(forensics.measure_cutoff(wins, sr)[0] - 16800) <= 400


def test_effective_bit_depth_sees_through_a_padded_flac(tmp_path):
    # A 16-bit master rewrapped as 24-bit FLAC leaves its low 8 bits at
    # zero. This is the cheapest fake-hi-res detector there is.
    src16 = _write_wav(tmp_path, bits=16, sr=44100)
    padded = str(tmp_path / 'padded.flac')
    _run('ffmpeg', '-v', 'error', '-y', '-i', src16, '-sample_fmt', 's32', padded)
    assert forensics.effective_bit_depth(padded) == 16


def test_effective_bit_depth_reports_24_for_a_real_24_bit_source(tmp_path):
    src24 = _write_wav(tmp_path, bits=24, sr=44100, dither=True)
    assert forensics.effective_bit_depth(src24) == 24


def test_effective_bit_depth_reports_zero_for_digital_silence(tmp_path):
    """No evidence either way. Reporting 0 rather than guessing keeps it out
    of quality_tier's `eff_bits >= 16` gate instead of inventing a pass."""
    out = str(tmp_path / 'silence.wav')
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', 'anullsrc=r=44100:cl=stereo', '-t', '2', out)
    assert forensics.effective_bit_depth(out) == 0


def test_effective_sample_rate_demotes_a_96k_file_brickwalled_at_20k():
    # 96 kHz container, no content above 20.5 kHz => it was 44.1 once.
    assert forensics.effective_sample_rate(96000, 20500) == 44100


def test_effective_sample_rate_keeps_the_declared_rate_when_content_reaches_nyquist():
    assert forensics.effective_sample_rate(44100, 21800) == 44100


def test_effective_sample_rate_never_over_reports_the_container():
    """The container can over-report, never under-report: a 44.1 kHz file
    cannot secretly hold 96 kHz content."""
    assert forensics.effective_sample_rate(44100, 3000) <= 44100
    assert forensics.effective_sample_rate(0, 20000) == 0
    assert forensics.effective_sample_rate(44100, 0) == 44100


# --- ALAC hides inside an mov/m4a container.
#
# Measured on production 2026-07-29: 334 of 549 files report container
# 'mov' — ffprobe's name for the MP4/M4A family, which carries EITHER AAC
# (lossy) or ALAC (lossless). All 334 are AAC today, so nothing has been
# misjudged; the first ALAC upload would have been capped at tier 3 forever,
# silently, because 'mov' is not in LOSSLESS and nothing looked at the codec.

def test_alac_in_an_mov_container_is_lossless():
    assert forensics.is_lossless('mov', 'alac') is True
    assert forensics.is_lossless('mov', 'aac') is False
    # The container alone still answers for the formats that name themselves.
    assert forensics.is_lossless('flac', 'flac') is True
    assert forensics.is_lossless('mp3', 'mp3') is False
    # And the codec alone answers when the container is unhelpful.
    assert forensics.is_lossless('', 'flac') is True


def test_alac_in_an_mov_container_can_still_reach_tier_five():
    assert forensics.quality_tier(container='mov', ancestor='none',
                                  cutoff_hz=21500, eff_bits=16, codec='alac') == 5
    assert forensics.quality_tier(container='mov', ancestor='abstain',
                                  cutoff_hz=15000, eff_bits=16, codec='alac') == 4


def test_aac_in_the_same_container_is_still_capped_at_its_bandwidth():
    """The tier gate has to keep saying no to the lossy half of the family,
    or making it codec-aware would have handed every AAC file a tier 5."""
    assert forensics.quality_tier(container='mov', ancestor='none',
                                  cutoff_hz=21500, eff_bits=16, codec='aac') == 3
    assert forensics.quality_tier(container='mov', ancestor='abstain',
                                  cutoff_hz=15000, eff_bits=16, codec='aac') == 1


# --- A soft rolloff is not an encoder lowpass.
#
# Production, 2026-07-29: "02 GOLD.m4a", a verified iTunes purchase
# (iTunNORM/iTunSMPB atoms, ~283 kbps => iTunes Plus 256k AAC) measured
# cutoff 16387 Hz with a cliff of 2.52 dB and landed at TIER 1 — the grade a
# 128 kbps file gets. classify_ancestor refused to accuse it; the tier
# demoted it anyway. Nine of the first 35 tiered files were tier 1.

def test_the_02_gold_case_a_256k_aac_of_a_dark_master_is_not_tier_one():
    assert forensics.quality_tier(
        container='mov', ancestor='none', cutoff_hz=16387, eff_bits=0,
        codec='aac', cliff_db=2.52, declared_kbps=283) == 3


def test_a_soft_rolloff_at_a_low_bitrate_is_still_tier_one():
    """The bitrate sets the floor, so a genuinely small file still lands at
    the bottom — otherwise every dark master would be tier 3."""
    assert forensics.quality_tier(
        container='mp3', ancestor='none', cutoff_hz=16387, eff_bits=0,
        codec='mp3', cliff_db=2.5, declared_kbps=128) == 1
    assert forensics.quality_tier(
        container='mp3', ancestor='none', cutoff_hz=16387, eff_bits=0,
        codec='mp3', cliff_db=2.5, declared_kbps=192) == 2


def test_a_sharp_cliff_still_demotes_however_big_the_file_claims_to_be():
    """THE ANTI-CHEAT. A 128k source re-encoded at 320 kbps keeps its 16.8 kHz
    wall, so the wall decides — not the bitrate the re-encode declares."""
    assert forensics.quality_tier(
        container='mp3', ancestor='confirmed', cutoff_hz=16800, eff_bits=0,
        codec='mp3', cliff_db=41.0, declared_kbps=320) == 1
    # And the same for a fake FLAC, whose declared bitrate is ~900 kbps.
    assert forensics.quality_tier(
        container='flac', ancestor='confirmed', cutoff_hz=16800, eff_bits=16,
        codec='flac', cliff_db=41.0, declared_kbps=900) == 1
    # 'suspected' is treated the same way: the measured bandwidth decides and
    # the declared 320 kbps buys nothing. 17500 Hz is worth tier 2 on its own,
    # so this shows the bitrate is not consulted rather than that it agreed.
    assert forensics.quality_tier(
        container='mp3', ancestor='suspected', cutoff_hz=17500, eff_bits=0,
        codec='mp3', cliff_db=20.0, declared_kbps=320) == 2


def test_a_sharp_cliff_with_no_ancestor_verdict_still_trusts_the_bandwidth():
    """cliff >= ENCODER_CLIFF_DB is an encoder lowpass whatever
    classify_ancestor concluded, so the bitrate is not consulted."""
    assert forensics.quality_tier(
        container='mp3', ancestor='none', cutoff_hz=16000, eff_bits=0,
        codec='mp3', cliff_db=30.0, declared_kbps=320) == 1


def test_the_bitrate_may_only_raise_the_floor_never_lower_it():
    """A file that already earned tier 3 on measured bandwidth cannot be
    pushed down by a modest declared bitrate."""
    assert forensics.quality_tier(
        container='mp3', ancestor='none', cutoff_hz=20000, eff_bits=0,
        codec='mp3', cliff_db=2.0, declared_kbps=128) == 3


def test_the_bitrate_can_never_manufacture_a_lossless_tier():
    """max() is capped at 3 by construction: tiers 4 and 5 are only reachable
    through the lossless branches above, which the bitrate never touches."""
    assert forensics.quality_tier(
        container='mp3', ancestor='none', cutoff_hz=16000, eff_bits=0,
        codec='mp3', cliff_db=1.0, declared_kbps=10000) == 3


def test_the_old_four_argument_call_is_unchanged():
    """cliff_db defaults to None, so every pre-existing caller keeps the
    exact behaviour it had — including the anti-cheat tests above."""
    assert forensics.quality_tier('flac', 'confirmed', 16000, 16) == 1
    assert forensics.quality_tier('mp3', 'none', 16387, 0) == 1


# --- A wall is a wall wherever it stands.
#
# Production, 2026-07-29: file b67a6dcc, a true 128 kbps MP3 (129 kbps by
# size, correctly graded tier 1), measured a 38.03 dB cliff at 15811 Hz and
# came back ancestor 'none'. 15811 sits in an unwatched gap between
# CUTOFF_TABLE's 15000 and 16800 entries, and the 'suspected' branch only
# spanned 15 <= cliff < 30 — so a 38 dB wall got a CLEANER verdict than a
# 20 dB one.

def test_a_sharp_wall_off_the_table_is_suspected_not_none():
    """THE b67a6dcc CASE. 15811 Hz is in the 15400-16400 Hz gap."""
    assert forensics.classify_ancestor(
        cutoff_hz=15811, cliff_db=38.03, lame_lowpass_hz=None,
        usable_windows=8, hf_ref_delta_db=-20) == 'suspected'


def test_the_other_two_table_gaps_behave_the_same_way():
    """11400-14600 Hz and 17650-18350 Hz are the other unwatched bands."""
    for cutoff in (13000, 18000):
        assert forensics.classify_ancestor(
            cutoff_hz=cutoff, cliff_db=33.0, lame_lowpass_hz=None,
            usable_windows=8, hf_ref_delta_db=-20) == 'suspected', cutoff


def test_a_table_match_still_earns_the_stronger_confirmed_verdict():
    """Knowing WHICH encoder bitrate left the wall is stronger evidence than
    the wall alone, so the table has not been made redundant."""
    assert forensics.classify_ancestor(
        cutoff_hz=16800, cliff_db=38.0, lame_lowpass_hz=None,
        usable_windows=8, hf_ref_delta_db=-20) == 'confirmed'


def test_a_sharp_edge_at_the_top_of_the_band_is_still_none():
    """A lossless master's own 21 kHz ceiling must not become suspicious —
    the < 21000 guard is what keeps tier 5 reachable."""
    assert forensics.classify_ancestor(
        cutoff_hz=21500, cliff_db=40.0, lame_lowpass_hz=None,
        usable_windows=8, hf_ref_delta_db=-20) == 'none'


def test_abstention_still_comes_before_accusation():
    """The dark-master gate is checked BEFORE the cliff, so widening the
    cliff branch cannot start accusing quiet masters."""
    assert forensics.classify_ancestor(
        cutoff_hz=15811, cliff_db=38.03, lame_lowpass_hz=None,
        usable_windows=8, hf_ref_delta_db=-70) == 'abstain'
    assert forensics.classify_ancestor(
        cutoff_hz=15811, cliff_db=38.03, lame_lowpass_hz=None,
        usable_windows=2, hf_ref_delta_db=-20) == 'abstain'


def test_the_widened_verdict_keeps_the_bitrate_floor_out_of_reach():
    """WHY THIS MATTERS. A 128 kbps source re-encoded at 320 kbps carries its
    wall to a frequency the table may not list. Reaching quality_tier as
    'none' would have let the declared 320 kbps buy back two tiers; as
    'suspected' the measured bandwidth still decides."""
    verdict = forensics.classify_ancestor(
        cutoff_hz=15811, cliff_db=38.03, lame_lowpass_hz=None,
        usable_windows=8, hf_ref_delta_db=-20)
    assert forensics.quality_tier(
        container='mp3', ancestor=verdict, cutoff_hz=15811, eff_bits=0,
        codec='mp3', cliff_db=38.03, declared_kbps=320) == 1


# --- A soft rolloff is a dark master ABOVE the 20800 Hz bar as well as below.
#
# Production, 2026-07-29, owner-reported: file d468ee5c, "Paul Kalkbrenner —
# Altes Kamuffel (Special Berlin Calling Edit).flac" — 24,094,350 bytes over
# 256.2 s (752 kbps), flac/flac, 16-bit, ancestor 'none', cutoff 20090 Hz,
# cliff 4.25 dB — graded TIER 3, the same as a 256 kbps AAC. 20090 misses the
# 20800 bar, so a real lossless master was demoted by 710 Hz of missing
# ultrasonics that its own 4.25 dB rolloff already explained.
#
# The two integration tests below are the ones that matter. They differ by
# EXACTLY one step — a real 320 kbps LAME round trip — from the same soft-EQ'd
# source, so anything that let the fake through would have to let it through
# on that step alone.


def _soft_rolloff_wav(tmp_path, name: str = 'softmaster.wav') -> str:
    """White noise with a gentle 20 dB/kHz shelf above 18 kHz.

    A real firequalizer curve, not a digital brickwall: this is what a dark
    master looks like to measure_cutoff — the music fades out rather than
    hitting a wall. It puts the measured cutoff just under the 20800 Hz bar
    with a single-digit cliff, i.e. the d468ee5c shape.
    """
    dst = str(tmp_path / name)
    _run('ffmpeg', '-y', '-v', 'error', '-f', 'lavfi',
         '-i', 'anoisesrc=color=white:duration=60:sample_rate=44100:seed=11',
         '-ac', '2', '-af',
         "firequalizer=gain='if(lt(f,18000), 0, -20*(f-18000)/1000)'", dst)
    return dst


def _grade(path: str) -> tuple[int, dict]:
    """Run the REAL production path over a real file and return its tier.

    Uses app.main._declared_kbps rather than a reimplementation, so the
    bitrate the test feeds quality_tier is the one production would feed it.
    """
    import json
    from app.main import _declared_kbps

    info = json.loads(subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json',
         '-show_format', '-show_streams', path],
        capture_output=True, text=True, check=True).stdout)
    stream = next(s for s in info['streams'] if s['codec_type'] == 'audio')
    container = info['format']['format_name'].split(',')[0]
    codec = stream['codec_name']
    duration_ms = int(float(info['format']['duration']) * 1000)

    w = decode_windows(path, count=8, secs=10, duration_s=duration_ms / 1000)
    spec = forensics.measure_spectrum(w, 44100)
    cutoff, cliff = forensics.cutoff_from_spectrum(spec)
    hf = forensics.hf_ref_delta_db(spec)
    bits = forensics.effective_bit_depth(path)
    kbps = _declared_kbps(info, stream, duration_ms)
    ancestor = forensics.classify_ancestor(cutoff, cliff, None, len(w), hf)
    tier = forensics.quality_tier(container, ancestor, cutoff, bits,
                                  codec, cliff, kbps)
    return tier, dict(cutoff=cutoff, cliff=cliff, bits=bits, kbps=kbps,
                      ancestor=ancestor, container=container, codec=codec)


def test_a_real_soft_rolloff_flac_below_20800_still_reaches_tier_five(tmp_path):
    """THE d468ee5c CASE, end to end through real ffmpeg and real flac.

    A soft-EQ'd full-band source encoded by the real FLAC encoder must be
    graded a lossless master even though its measured cutoff sits under the
    20800 Hz bar.
    """
    src = _soft_rolloff_wav(tmp_path)
    dst = str(tmp_path / 'softmaster.flac')
    _run('ffmpeg', '-y', '-v', 'error', '-i', src, '-c:a', 'flac', dst)

    tier, m = _grade(dst)
    # The fixture has to actually reproduce the production shape, or the test
    # proves nothing about the production file.
    assert m['codec'] == 'flac'
    assert m['cutoff'] < 20800, f"fixture is not below the bar: {m}"
    assert m['cliff'] < forensics.ENCODER_CLIFF_DB, f"fixture rolloff is not soft: {m}"
    assert m['ancestor'] == 'none', m
    assert m['bits'] >= 16 and m['kbps'] >= forensics.LOSSLESS_KBPS_FLOOR, m
    assert tier == 5, f'real lossless soft-rolloff master graded {tier}: {m}'


def test_the_same_source_via_a_real_320k_mp3_never_reaches_tier_five(tmp_path):
    """THE ANTI-CHEAT, on the one file that could break it.

    Identical source, identical FLAC encoder, one extra step: a real
    320 kbps libmp3lame round trip. The wall that round trip leaves must
    still decide the grade, and the ~1000 kbps the FLAC then declares must
    buy nothing.
    """
    src = _soft_rolloff_wav(tmp_path, 'transcode_src.wav')
    mp3 = str(tmp_path / 'lossy320.mp3')
    dst = str(tmp_path / 'fake320.flac')
    _run('ffmpeg', '-y', '-v', 'error', '-i', src,
         '-c:a', 'libmp3lame', '-b:a', '320k', mp3)
    _run('ffmpeg', '-y', '-v', 'error', '-i', mp3, '-c:a', 'flac', dst)

    tier, m = _grade(dst)
    assert m['codec'] == 'flac'
    # It clears the bitrate floor comfortably — decoded lossy audio compresses
    # WORSE than the honest master it imitates, so the floor is no defence
    # and is not being asked to be one.
    assert m['kbps'] >= forensics.LOSSLESS_KBPS_FLOOR, m
    # Both real gates reject it independently.
    assert m['cliff'] >= forensics.ENCODER_CLIFF_DB, f'transcode cliff went soft: {m}'
    assert m['ancestor'] in ('suspected', 'confirmed'), m
    assert tier < 5, f'a real 320k transcode was graded {tier}: {m}'
    assert tier == 3, f'expected the measured 20 kHz bandwidth to decide: {tier} {m}'


def test_the_new_branch_needs_every_one_of_its_conditions(tmp_path):
    """Unit-level pins on the gate, so a later edit cannot widen it quietly."""
    base = dict(container='flac', ancestor='none', cutoff_hz=20090,
                eff_bits=16, codec='flac', cliff_db=4.25, declared_kbps=752)
    assert forensics.quality_tier(**base) == 5              # the production row
    assert forensics.quality_tier(**{**base, 'cliff_db': 15.0}) == 3   # a wall
    assert forensics.quality_tier(**{**base, 'eff_bits': 8}) == 3      # not 16-bit
    assert forensics.quality_tier(**{**base, 'declared_kbps': 499}) == 3
    assert forensics.quality_tier(**{**base, 'ancestor': 'suspected'}) == 3
    assert forensics.quality_tier(**{**base, 'container': 'mp3',
                                     'codec': 'mp3'}) == 3            # lossy
    # cliff_db unknown (the four-argument callers) keeps the old behaviour.
    assert forensics.quality_tier(**{**base, 'cliff_db': None}) == 3


def test_the_dark_lossless_master_can_now_outrank_its_own_aac(tmp_path):
    """WHY NO CUTOFF FLOOR. The lossless sibling of the '02 GOLD' case — a
    16 kHz dark master, soft rolloff — must out-tier the 256 kbps AAC of the
    same recording, or the merge this pool wants cannot happen."""
    aac = forensics.quality_tier(container='mov', ancestor='none',
                                 cutoff_hz=16387, eff_bits=0, codec='aac',
                                 cliff_db=2.52, declared_kbps=283)
    flac = forensics.quality_tier(container='flac', ancestor='none',
                                  cutoff_hz=16387, eff_bits=16, codec='flac',
                                  cliff_db=2.52, declared_kbps=640)
    assert (aac, flac) == (3, 5)


def test_abstain_still_answers_four_not_five(tmp_path):
    """The new branch is checked before the abstain branch, so prove the
    abstain path is still reachable: 'abstain' is not 'none'."""
    assert forensics.quality_tier(
        container='flac', ancestor='abstain', cutoff_hz=15000, eff_bits=16,
        codec='flac', cliff_db=1.0, declared_kbps=900) == 4
