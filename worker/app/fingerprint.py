# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import base64, hashlib, struct, subprocess, re
from .models import Fingerprint

FPCALC = 'fpcalc'

def algo_version() -> str:
    """Derive chromaprint algorithm version from fpcalc at runtime.

    Returns a string like 'cp-1.6.0/test2/11025'. Falls back to
    'cp-unknown/test2/11025' if fpcalc version cannot be determined.
    Result is cached at module level (one subprocess call per process).
    """
    try:
        result = subprocess.run([FPCALC, '-version'],
                                capture_output=True, text=True, check=True)
        # Parse version from output like "fpcalc version 1.6.0"
        match = re.search(r'(\d+\.\d+(?:\.\d+)?)', result.stdout)
        if match:
            version = match.group(1)
            return f'cp-{version}/test2/11025'
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        pass
    return 'cp-unknown/test2/11025'

# Cache the version at module load time
_ALGO_VERSION = algo_version()

def make_query_items(raw: list[int], mask: int = 12,
                     windows: list[tuple[int, int]] | None = None) -> list[int]:
    """Masked, deduped subfingerprints for GIN candidate retrieval.

    Two windows because a single one can land in an intro that differs between a
    club rip and a radio edit. `mask` MUST be calibrated (plan 04): transcode 200
    files to 128kbps and require median(|a & b|)/|a| >= 0.35.
    """
    windows = windows or [(10, 40), (60, 90)]
    items: set[int] = set()
    for start_s, end_s in windows:
        for x in raw[8 * start_s: 8 * end_s]:
            items.add((x >> mask) & 0xFFFFF)
    return sorted(items)

def fingerprint(path: str) -> Fingerprint:
    out = subprocess.run([FPCALC, '-raw', '-length', '0', path],
                         capture_output=True, text=True, check=True).stdout
    fields = dict(line.split('=', 1) for line in out.strip().splitlines())
    # Normalize to unsigned 32-bit: fpcalc builds differ on whether raw ints
    # print as signed int32 (can be negative) or unsigned (chromaprint 1.6.x,
    # the installed build, always prints unsigned — e.g. 3846200607, which
    # overflows a signed 'i' pack). `& 0xFFFFFFFF` is a no-op on values already
    # in range and correctly wraps negatives, so downstream (masking in
    # make_query_items, and the pack below) sees one consistent convention.
    raw = [int(v) & 0xFFFFFFFF for v in fields['FINGERPRINT'].split(',')]
    packed = struct.pack(f'<{len(raw)}I', *raw)
    return Fingerprint(
        algo_version=_ALGO_VERSION,
        duration_s=int(float(fields['DURATION'])),
        frame_count=len(raw),
        fp_compressed_b64=base64.b64encode(packed).decode(),
        fp_sha256=hashlib.sha256(packed).hexdigest(),
        query_items=make_query_items(raw),
    )
