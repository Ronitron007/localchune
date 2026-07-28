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
