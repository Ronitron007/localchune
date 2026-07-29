# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""Quality forensics — the anti-cheat from PRD §7.2.

Scope note (per the task brief): this implements the two high-value checks
and the abstain path, not the full 20-signal stack. The threat model is ten
friends, one of whom might innocently upload a fake FLAC they were given,
not a determined adversary — a determined adversary defeats all of this by
injecting shaped noise above 16kHz.

Two moral commitments, both enforced by the tests in test_forensics.py:
1. A fake FLAC gets its tier from measured bandwidth, not its container —
   see quality_tier: a lossless container with a CONFIRMED lossy ancestor
   falls straight through to the cutoff-derived tier. That single rule is
   the entire anti-cheat.
2. Abstention before accusation — see classify_ancestor: a dark master
   (little natural HF energy, or too few usable windows) lands in
   'abstain', never in 'suspected'/'confirmed'. Getting this wrong means
   accusing a friend's legitimately quiet master of being a fake.
"""
import subprocess
from dataclasses import dataclass

import numpy as np

# The 128kbps entry is 16800, not the textbook 16000: verified against four
# independent real `ffmpeg -c:a libmp3lame -b:a 128k` encodes of white noise
# (different noise realisations), which landed a clean, sharp (>30dB) brickwall
# at 16834-16877Hz every time -- consistently ~800Hz above the commonly-cited
# 16000Hz figure and outside classify_ancestor's +-400Hz match window, which
# would silently downgrade a real 128kbps fake FLAC from 'confirmed' to 'none'.
# The other entries were left as published; only 128kbps was end-to-end
# verified against a real encoder for this task.
CUTOFF_TABLE = {11000: 64, 15000: 96, 16800: 128, 17250: 160,
                18750: 192, 19000: 192, 19500: 256, 20000: 256, 20500: 320}
LOSSLESS = {'flac', 'wav', 'aiff', 'alac'}


@dataclass(frozen=True)
class Spectrum:
    """One max-hold power spectrum in dB, plus its bin frequencies.

    MAX-HOLD across every window and every channel, never a mean: the
    encoder lowpass is a hard ceiling on the WHOLE file, and averaging drags
    the apparent cutoff down during quiet passages, manufacturing false
    positives. Channels are never downmixed — MP3 intensity stereo folds HF
    into a shared channel and a downmix destroys that evidence.
    """
    db: np.ndarray
    freqs: np.ndarray
    ref_db: float
    windows: int


def measure_spectrum(windows: list[np.ndarray], sr: int) -> Spectrum | None:
    """The single FFT pass that cutoff, cliff and the abstain gate share.

    Extracted from measure_cutoff() rather than added beside it: the pass is
    the expensive part (~1600 max-held frames on a real forensic sample), and
    computing it twice to get one more number off it would double the only
    part of this module that costs anything.
    """
    n_fft = 8192
    maxhold = None
    for w in windows:
        for ch in range(w.shape[1]):
            x = w[:, ch]
            for off in range(0, max(1, len(x) - n_fft), n_fft // 2):
                seg = x[off:off + n_fft]
                if len(seg) < n_fft:
                    break
                p = np.abs(np.fft.rfft(seg * np.hanning(n_fft))) ** 2
                maxhold = p if maxhold is None else np.maximum(maxhold, p)
    if maxhold is None:
        return None
    freqs = np.fft.rfftfreq(n_fft, 1 / sr)
    db = 10 * np.log10(maxhold + 1e-20)
    ref = float(db[(freqs >= 1000) & (freqs <= 4000)].mean())
    return Spectrum(db=db, freqs=freqs, ref_db=ref, windows=len(windows))


def hf_ref_delta_db(spec: Spectrum | None) -> float:
    """14-16 kHz energy relative to the 1-4 kHz reference.

    PRD §7.2's abstain gate: below -60 dB the track is dark or sparse and the
    detector has nothing to work with. Returning a fixed number here instead
    of measuring it is how a legitimately quiet master gets called a fake —
    which is the one error this module is tuned to avoid, because a false
    accept costs one wrongly-awarded credit and a false reject costs a
    contributor.
    """
    if spec is None:
        return -200.0
    hf = spec.db[(spec.freqs >= 14000) & (spec.freqs <= 16000)]
    if hf.size == 0:
        return -200.0
    return round(float(hf.mean() - spec.ref_db), 2)


def measure_cutoff(windows: list[np.ndarray], sr: int) -> tuple[int, float]:
    """Highest frequency with real energy, plus cliff sharpness in dB/500Hz.

    MAX-HOLD across windows, never mean: the encoder lowpass is a hard ceiling
    on the whole file, and averaging drags the apparent cutoff down during quiet
    passages, manufacturing false positives.

    Channels are analysed separately and NOT downmixed: MP3 intensity stereo
    folds HF into a shared mono channel, and a downmix destroys that evidence.
    """
    return cutoff_from_spectrum(measure_spectrum(windows, sr))


def cutoff_from_spectrum(spec: Spectrum | None) -> tuple[int, float]:
    """measure_cutoff()'s threshold and cliff logic, off an existing pass.

    main.py calls measure_spectrum() once and reads cutoff, cliff and the
    abstain gate off the same Spectrum. measure_cutoff() above is kept as-is
    for every existing caller and test.
    """
    if spec is None:
        return 0, 0.0
    freqs, S, ref = spec.freqs, spec.db, spec.ref_db
    thresh = ref - 50.0

    # Adaptive noise-floor threshold. The fixed ref-50dB threshold above is a
    # FLOOR ON the threshold, not the whole story: on real 128kbps LAME
    # encodes of white noise, some noise realisations leave a stopband floor
    # that sits ~1dB ABOVE ref-50 across the entire stopband (~950
    # consecutive bins) -- no RUN value can reject a sustained excursion that
    # size, and it reads as a full-band 'none' instead of 'confirmed', a
    # false negative in the anti-cheat this module exists to prevent
    # (verified on seeds 2024 and 31337; see test_forensics.py).
    #
    # Fix: measure the actual floor from the top octave (15kHz-Nyquist) and
    # raise the threshold above it. FLOOR_GATE=20dB guards the one case this
    # can break: genuinely full-band content (a lossless master, or any
    # brief brickwall test whose cutoff sits AT/ABOVE ~19-20kHz) has no
    # floor at all in that window -- percentile(top, 10) there sits within
    # ~1dB of ref (verified: full-band synthetic noise, ref=41.84,
    # p10=40.74; brickwall@20500, ref=41.97 with its true floor correctly
    # isolated by p10 at -90.51 despite median being contaminated at 41.60).
    # A genuine LAME stopband floor sits ~48-50dB below ref on these same
    # seeds -- FLOOR_GATE=20 sits with a wide margin inside that ~47dB gap
    # between the two clusters, so "floor" only fires when there really is
    # one, and never overrides ref-50 for full-band/near-Nyquist content.
    #
    # MARGIN=8dB: modest per the brief (6-10dB), picked as the midpoint --
    # floor+MARGIN lands at the tail of the real transition band on the
    # failing seeds (~-5.5 to -5.8dB, verified against the real per-bin
    # spectrum), comfortably below the ~21dB transition-band level and the
    # ~35dB passband, so the highest bin with genuine signal is still found
    # rather than the floor being mistaken for signal.
    FLOOR_GATE = 20.0
    MARGIN = 8.0
    top = S[freqs >= 15000]
    if top.size:
        floor = float(np.percentile(top, 10))
        if floor <= ref - FLOOR_GATE:
            thresh = max(thresh, floor + MARGIN)

    above = np.where(S >= thresh)[0]
    if above.size == 0:
        return 0, 0.0
    # highest bin over threshold, requiring RUN consecutive bins to reject spurs.
    #
    # RUN=20 (~108Hz at n_fft=8192/44100Hz), not the brief's 5: verified on a
    # real 128kbps MP3 (white noise -> ffmpeg libmp3lame -> decoded WAV, 8
    # windows x 2 channels, ~1600 max-held FFT frames total) that a 5-bin
    # spur-rejection window is not statistically safe at this many frames.
    # Max-hold over ~1600 independent frames gives quantization-noise
    # excursions in the stopband thousands of chances to exceed a fixed
    # threshold; 1 of 3 tested noise seeds produced a spurious 5-consecutive
    # -bin run above 20800Hz purely from encoder noise floor, misreporting a
    # confirmed 128kbps brickwall (measured cleanly at ~16850Hz on the other
    # seeds and via band-averaging on this same file) as full-band/no-cutoff.
    # The genuine cutoff's run length is thousands of bins (everything below
    # it clears the threshold); the observed spurious runs topped out at 5
    # bins. RUN=20 is a 4x margin above the observed spurious maximum while
    # staying two orders of magnitude below a genuine transition band or the
    # in-band bulk run, and does not change any brief unit test's result.
    RUN = 20
    idx = above[-1]
    for i in range(above.size - 1, RUN - 2, -1):
        if np.all(np.diff(above[i - (RUN - 1):i + 1]) == 1):
            idx = above[i]
            break
    f_c = float(freqs[idx])

    def band(a: float, b: float) -> float:
        sel = (freqs >= a) & (freqs < b)
        return float(S[sel].mean()) if sel.any() else -200.0

    cliff = band(f_c - 500, f_c) - band(f_c, f_c + 500)
    return int(round(f_c)), round(float(cliff), 2)


# Standard rates, ascending. A file is demoted to the LOWEST rate whose
# Nyquist still comfortably contains the measured content.
_STANDARD_RATES = (22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000)

# Fraction of Nyquist the measured content must fit inside before a file is
# demoted to that rate.
#
# 0.93, NOT the brief's 0.90: the brief's own test asserts that a 96 kHz
# container brickwalled at 20500 Hz is really 44.1 kHz, and 0.90 puts 44.1's
# bar at 19845 Hz — below 20500 — so it would answer 48000 and fail. 0.93
# puts the bar at 20506 Hz, which clears a real CD master's ~20.5 kHz
# rolloff by 6 Hz and clears 48 kHz's bar (22320 Hz) by a wide margin. Any
# value in [0.930, 0.988] satisfies both published tests; 0.93 is the low
# end, i.e. the most reluctant to demote.
_NYQUIST_FRACTION = 0.93


def effective_sample_rate(declared_sr: int, cutoff_hz: int) -> int:
    """The rate this audio was really at, whatever the container claims.

    A 96 kHz FLAC brickwalled at 20.5 kHz is a 44.1 kHz master upsampled.
    Never returns MORE than the declared rate: the container cannot
    under-report, only over-report.

    KNOWN CEILING, and it is structural: decode.windows() resamples to
    44.1 kHz, so cutoff_hz can never exceed ~22 kHz and this function can
    never CONFIRM a rate above 48 kHz — a genuine 96 kHz master is reported
    as 44100 or 48000. That costs at most the 4 points quality_score gives
    for a high rate, out of ~500, and it costs them equally to every file, so
    it cannot change a merge decision between two candidates. Measuring the
    cutoff a second time at the native rate would cost another full decode
    pass to buy those 4 points back, which is not a trade this pool needs.
    """
    if declared_sr <= 0 or cutoff_hz <= 0:
        return max(declared_sr, 0)
    for rate in _STANDARD_RATES:
        if rate > declared_sr:
            break
        if cutoff_hz <= rate * 0.5 * _NYQUIST_FRACTION:
            return rate
    return declared_sr


def effective_bit_depth(path: str) -> int:
    """Significant bits actually used, measured from decoded samples.

    Decode to s32, OR every sample together, and count the trailing zeros:
    a 16-bit master rewrapped as 24- or 32-bit leaves its low bits
    permanently zero. This is the only honest reading — ffprobe reports
    what the CONTAINER declares, which is precisely the claim being tested.

    A dithered or noise-shaped upconversion defeats it and reports the
    higher depth. That is correct behaviour, not a gap: dither is real
    signal, and PRD §7.2 already states the honest limit that a motivated
    cheat defeats this in minutes.
    """
    raw = subprocess.run(
        ['ffmpeg', '-v', 'error', '-i', path, '-f', 's32le', '-ac', '1', '-'],
        capture_output=True, check=True).stdout
    if not raw:
        return 0
    samples = np.frombuffer(raw, dtype=np.int32)
    if samples.size == 0:
        return 0
    # Bitwise-OR the magnitudes. np.bitwise_or.reduce over int32 keeps the
    # sign bit, so take the unsigned view first.
    acc = int(np.bitwise_or.reduce(samples.view(np.uint32)))
    if acc == 0:
        return 0                      # digital silence: no evidence either way
    trailing = (acc & -acc).bit_length() - 1
    return max(1, 32 - trailing)


def classify_ancestor(cutoff_hz: int, cliff_db: float, lame_lowpass_hz: int | None,
                      usable_windows: int, hf_ref_delta_db: float) -> str:
    # 1. cheapest kill: the bitstream disagrees with the PCM
    if lame_lowpass_hz is not None and abs(lame_lowpass_hz - cutoff_hz) > 1500:
        return 'confirmed'
    # 2. abstain BEFORE deciding — this is what makes it fair
    if usable_windows < 4 or hf_ref_delta_db < -60:
        return 'abstain'
    # 3. cliff-based
    if cliff_db >= 30 and cutoff_hz < 21000 and \
       any(abs(cutoff_hz - t) <= 400 for t in CUTOFF_TABLE):
        return 'confirmed'
    if 15 <= cliff_db < 30:
        return 'suspected'
    return 'none'


def quality_tier(container: str, ancestor: str, cutoff_hz: int, eff_bits: int) -> int:
    lossless = container.lower() in LOSSLESS
    if lossless and ancestor == 'none' and cutoff_hz >= 20800 and eff_bits >= 16:
        return 5
    if lossless and ancestor == 'abstain':
        return 4
    # A lossless container with a CONFIRMED lossy ancestor falls through to its
    # MEASURED bandwidth. That single rule is the entire anti-cheat.
    if cutoff_hz >= 19500: return 3
    if cutoff_hz >= 17000: return 2
    return 1


def quality_score(tier: int, cutoff_hz: int, eff_bits: int, eff_sr: int,
                  inferred_kbps: int, lame_disagrees: bool, clipped_pct: float,
                  true_peak: float, mono_vs_stereo: bool, decode_errors: bool) -> float:
    s = 100.0 * tier
    s += 0.8 * min(cutoff_hz, 22050) / 1000
    s += 6.0 * min(max((eff_bits - 16) / 8, 0.0), 1.0)
    s += 4.0 * min(max((eff_sr - 44100) / 51900, 0.0), 1.0)
    s += 10.0 * min(1.0, inferred_kbps / 320) if inferred_kbps else 0.0
    s -= 6.0 if lame_disagrees else 0.0
    # clipped_pct is a peak-recurrence proxy, not a literal clip count (Task 6;
    # see Loudness.clipped_pct's Field description) — ffmpeg 8's astats has no
    # "Number of clipped samples" field, so this reads "Abs Peak count"
    # recurrence instead. The penalty below is therefore deliberately coarse:
    # it only matters once clipped_pct clears the 1% threshold that separates
    # clean material (~1%, naturally touching full scale) from genuinely
    # clipped material (~33%+ in Task 6's verification) — treat it as a
    # threshold signal, not a precise clip count.
    s -= 12.0 * min(1.0, clipped_pct / 0.01)
    s -= 4.0 if true_peak > 0.0 else 0.0
    s -= 15.0 if mono_vs_stereo else 0.0
    s -= 25.0 if decode_errors else 0.0
    # NOTE: the published formula also penalised low DR. Deliberately omitted —
    # a loud DR5 remaster may be exactly the club-ready copy a DJ wants, and that
    # term encodes an audiophile preference this pool does not share. DR is
    # informational only; only hard clipping is penalised.
    return round(s, 2)


def is_upgrade(a: dict, b: dict) -> tuple[bool, str]:
    """Does candidate b beat incumbent a? Requires a margin AND a hard win."""
    if b.get('clipped_pct', 0) > 0.001 >= a.get('clipped_pct', 0):
        return False, 'candidate is newly clipped'
    sa, sb = quality_score(**a), quality_score(**b)
    if sb - sa < 8:
        return False, f'not better by enough ({sb - sa:.1f} < 8)'
    hard = (b['tier'] > a['tier']
            or b['cutoff_hz'] >= a['cutoff_hz'] + 1500
            or (a.get('inferred_kbps') and b['tier'] == 5))
    if not hard:
        return False, 'no hard monotone improvement'
    if b.get('lame_disagrees') and b['cutoff_hz'] <= a['cutoff_hz']:
        return False, 'fake: confirmed lossy ancestor at no better bandwidth'
    return True, f'upgrade (+{sb - sa:.1f})'
