# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""The LAME/Xing/Info tag, in pure Python.

PRD §7.2 names mp3guessenc for this. We do not use it: it is a new GPL
binary, a new pinned sha256 and a new failure mode in an image that already
stages a 109-library Ubuntu-20.04 closure for Essentia, and the one field
classify_ancestor() actually consumes is 36 bytes at a computable offset.

The check this feeds is the cheapest kill in the whole forensics pass:
a transcoder running `lame -b 320` over a 128 kbps decode writes a tag
honestly claiming a 20.5 kHz lowpass while the audio brickwalls at 16.8 kHz.
The container lies; the audio does not.

EVERY parse failure returns None. A pool of files from other people contains
malformed MP3s, and a malformed MP3 is not an analysis failure. A missing or
unreadable tag is also not evidence of anything: classify_ancestor() treats
None as "fall through to the spectral path", which is correct, because most
MP3s in a DJ pool were not written by LAME at all.
"""
from dataclasses import dataclass

_BITRATES_V1_L3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224,
                   256, 320, 0)
_RATES_V1 = (44100, 48000, 32000, 0)

# Offsets INSIDE the LAME extension, counted from its 9-byte version string.
#
# CORRECTED FROM THE BRIEF, which put the lowpass at byte 21. Byte 21 is the
# first of the three encoder-delay bytes. Verified against real LAME 3.100
# output (see tests/test_lametag.py): byte 10 reads 170 -> 17000 Hz at
# 128 kbps and 205 -> 20500 Hz at 320 kbps, exactly the published figures;
# byte 21 reads 36 on BOTH, a constant 3600 Hz that would put
# |lame_lowpass_hz - cutoff_hz| over 1500 for every MP3 in the pool and
# return 'confirmed' for all of them. That is the worst failure this module
# has: it accuses everyone.
_OFF_VBR_METHOD = 9      # low nibble; high nibble is the Info-tag revision
_OFF_LOWPASS = 10        # in units of 100 Hz
_LAME_EXT_LEN = 36

# The LAME extension begins 120 bytes after the 'Xing'/'Info' magic:
# 4 magic + 4 flags + 4 frames + 4 bytes + 100 TOC + 4 quality. LAME always
# writes all four optional fields, so the offset is fixed for the tags this
# reader exists to read. A tag that omits one lands elsewhere, the 'LAME'
# check below fails, and the answer is None — which is the same answer as
# "no tag", and is safe.
_LAME_EXT_AT = 120


@dataclass(frozen=True)
class LameTag:
    lowpass_hz: int
    encoder_string: str
    vbr_method: str | None


def _id3v2_size(head: bytes) -> int:
    """Bytes to skip past an ID3v2 tag. Zero when there is none.

    The size is a 28-bit SYNCHSAFE integer: seven bits per byte, high bit
    always clear. Reading it as a plain big-endian int is the classic bug
    and lands the reader in the middle of the audio on any tag over 128 KB
    — which is every file carrying embedded cover art.
    """
    if len(head) < 10 or head[:3] != b'ID3':
        return 0
    b = head[6:10]
    if any(x & 0x80 for x in b):
        return 0
    size = (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]
    footer = 10 if (head[5] & 0x10) else 0
    return 10 + size + footer


def _frame_geometry(hdr: bytes) -> tuple[int, int] | None:
    """(side_info_bytes, sample_rate) for an MPEG-1 Layer III frame header."""
    if len(hdr) < 4 or hdr[0] != 0xFF or (hdr[1] & 0xE0) != 0xE0:
        return None
    version = (hdr[1] >> 3) & 0x03      # 3 = MPEG-1
    layer = (hdr[1] >> 1) & 0x03        # 1 = Layer III
    if version != 3 or layer != 1:
        return None                     # MPEG-2/2.5 use different offsets
    rate = _RATES_V1[(hdr[2] >> 2) & 0x03]
    if rate == 0 or _BITRATES_V1_L3[(hdr[2] >> 4) & 0x0F] == 0:
        return None
    mono = ((hdr[3] >> 6) & 0x03) == 3
    return (17 if mono else 32), rate


def read_lame_tag(path: str) -> LameTag | None:
    try:
        with open(path, 'rb') as fh:
            head = fh.read(10)
            fh.seek(_id3v2_size(head))
            # 8 KB is generous: the first frame follows the ID3v2 tag
            # immediately in every file a real encoder writes. Scanning
            # further would risk syncing on audio data that merely looks
            # like a frame header.
            buf = fh.read(8192)
    except OSError:
        return None

    for i in range(max(0, len(buf) - 4)):
        geom = _frame_geometry(buf[i:i + 4])
        if geom is None:
            continue
        side, _rate = geom
        x = i + 4 + side
        if buf[x:x + 4] not in (b'Xing', b'Info'):
            continue
        lame = buf[x + _LAME_EXT_AT:x + _LAME_EXT_AT + _LAME_EXT_LEN]
        # ffmpeg's mp3 muxer writes this frame ITSELF and stamps 'Lavc<ver>'
        # here, with the lowpass byte left at zero — libmp3lame never gets
        # to write its own tag. So "there is a Xing frame" is not "there is
        # a LAME tag", and only the latter carries a lowpass worth reading.
        if len(lame) < _LAME_EXT_LEN or not lame.startswith(b'LAME'):
            return None
        lowpass = lame[_OFF_LOWPASS] * 100
        if lowpass <= 0:
            return None
        vbr_code = lame[_OFF_VBR_METHOD] & 0x0F
        return LameTag(
            lowpass_hz=lowpass,
            encoder_string=lame[:9].decode('ascii', 'replace').strip(),
            vbr_method={1: 'cbr', 2: 'abr'}.get(vbr_code, 'vbr'),
        )
    return None
