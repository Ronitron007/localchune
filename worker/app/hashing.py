# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""content_sha256 — PRD §6's layer 0.

The PRD calls this "free (already computed)". It is not: nothing has ever
computed it, and files.content_sha256 is NULL on every row in production.
It is nearly free HERE, because the container is the one place that already
holds the whole file on local disk: about 0.1 s for a 40 MB FLAC, against
the ~45 vCPU-s the rest of the analysis costs.

Streamed in 1 MiB chunks, never read whole: a 15-minute FLAC is ~150 MB and
the instance has 3 GiB it must not spend on a digest.
"""
import hashlib

_CHUNK = 1024 * 1024


def content_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        while chunk := fh.read(_CHUNK):
            h.update(chunk)
    return h.hexdigest()
