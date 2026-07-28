# localchune analysis worker — Cloudflare Containers image.
#
# amd64 is not a preference. Cloudflare Containers runs linux/amd64 only, so
# every FROM pins it and the M1 build is an explicit cross-build, not an
# accident. It is also the lucky architecture: numpy, torch and the MTG
# Essentia image all ship mature x86_64 artifacts where arm64 is patchy.
#
# Licence posture (unchanged from the rest of M3): every third-party analysis
# engine is reached over a SUBPROCESS boundary — argv in, file/stdout out.
# Nothing here is linked into our address space, and no Essentia model file
# (.pb) is present. The distributed combination is AGPL-3.0; see LICENSE.

# ---------------------------------------------------------------------------
# Stage 1 — Essentia's streaming_extractor_music, lifted out of MTG's image.
# ---------------------------------------------------------------------------
# VERIFIED, not assumed (this is the Task 5 carry coming due):
#
#  * The binary in this image is named `essentia_streaming_extractor_music`,
#    NOT `streaming_extractor_music`. The brief's COPY line would have failed
#    at build time. It is installed below under the bare name app/key.py
#    execs.
#  * Version is `music 2.0` built with Essentia v2.1_beta5. Run on a real
#    fixture it emits the NESTED tonal shape app/key.py parses:
#        tonal.key_edma       {key, scale, strength}
#        tonal.key_temperley  {key, scale, strength}
#        tonal.key_krumhansl  {key, scale, strength}
#    Task 5 derived that shape by reading the C++ source. Confirmed against
#    the real binary — see .superpowers/sdd/m3-task-8-report.md.
#  * The OTHER published option — the static
#    essentia-extractors-v2.1_beta2-linux-x86_64 tarball — was REJECTED. It
#    predates the edma profile and emits the old FLAT shape
#    (tonal.key_key / key_scale / key_strength), which analyze_key does not
#    parse. Do not "simplify" to it.
#  * It IS linked against libfftw3f (the brief assumed a no-FFTW build). We
#    exec it, so this is the same arm's-length posture as everything else,
#    but the assumption was wrong and is recorded here rather than hidden.
FROM --platform=linux/amd64 ghcr.io/mtg/essentia:latest AS essentia

# The binary is an Ubuntu 20.04 build and needs FFmpeg 4-era sonames
# (libavformat.so.58, libavresample.so.4) that no current Debian ships. Rather
# than pin the whole image to an EOL distro — which would also drag our own
# ffmpeg back to 4.x and invalidate every measurement Tasks 6 and 7 made — its
# shared-library closure is staged here and loaded from a private directory at
# run time. glibc, libstdc++ and libgcc are deliberately EXCLUDED: those must
# come from the newer base image (old binary on new glibc is the supported
# direction; the reverse is not).
RUN set -eu; \
    mkdir -p /stage/bin /stage/lib; \
    cp -L /usr/local/bin/essentia_streaming_extractor_music \
          /stage/bin/streaming_extractor_music; \
    { ldd /usr/local/bin/essentia_streaming_extractor_music; \
      ldd /usr/local/lib/libessentia.so; } \
      | awk '{print $3}' | grep '^/' | sort -u \
      | grep -vE '/(libc|libm|libdl|libpthread|librt|libresolv|libstdc\+\+|libgcc_s|ld-linux-x86-64)\.so' \
      | while read -r p; do cp -L "$p" /stage/lib/; done; \
    ls /stage/lib | wc -l

# ---------------------------------------------------------------------------
# Stage 2 — pinned downloads. Every byte is sha256-verified before use.
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 debian:trixie-slim AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# fpcalc: the official acoustid static x86_64 build, pinned to 1.6.0 — the
# SAME version the dev machine runs. Debian trixie's libchromaprint-tools is
# 1.5.1, and app/fingerprint.py derives ALGO_VERSION from the binary at run
# time, so apt would have silently stamped every container-computed
# fingerprint `cp-1.5.1/...` while dev produced `cp-1.6.0/...` — two
# incompatible dedupe keys for identical audio. Task 4's mask calibration is
# against 1.6.0 output; this keeps that promise. 1.6.1 shipped 2026-07-28 and
# is deliberately NOT taken: matching dev exactly is the point.
ARG FPCALC_URL=https://github.com/acoustid/chromaprint/releases/download/v1.6.0/chromaprint-fpcalc-1.6.0-linux-x86_64.tar.gz
ARG FPCALC_SHA256=946dc3eade645eb835c8d163c6bb354e092239988bff190b9c42589e8d5cf00a
RUN set -eu; \
    curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 -C - \
         -o /tmp/fpcalc.tgz "$FPCALC_URL"; \
    echo "${FPCALC_SHA256}  /tmp/fpcalc.tgz" | sha256sum -c -; \
    tar -xzf /tmp/fpcalc.tgz -C /tmp; \
    mkdir -p /out/bin; \
    cp /tmp/chromaprint-fpcalc-1.6.0-linux-x86_64/fpcalc /out/bin/fpcalc; \
    chmod +x /out/bin/fpcalc

# Beat This! `final0` weights. 77 MB — fetched at build time, never committed
# (worker/models/ is gitignored for exactly this reason). The URL is CPJKU's
# own published checkpoint host, which beat_this.inference.CHECKPOINT_URL
# points at; the hash is of the file that produced every benchmark number in
# worker/bench/README.md.
ARG BEATTHIS_CKPT_URL=https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt
ARG BEATTHIS_CKPT_SHA256=8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331
# --retry/-C is not belt-and-braces here, it is the fix for an OBSERVED
# failure: the first build of this image died after 698s with
# `curl: (56) OpenSSL SSL_read: ... unexpected eof while reading` partway
# through this 77 MB file. cloud.cp.jku.at is a university Nextcloud, not a
# CDN, and it drops long transfers. `-C -` resumes rather than restarting,
# and the sha256 below is what makes a resumed download safe to trust.
RUN set -eu; \
    mkdir -p /out/models; \
    curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 -C - \
         -o /out/models/beat_this-final0.ckpt "$BEATTHIS_CKPT_URL"; \
    echo "${BEATTHIS_CKPT_SHA256}  /out/models/beat_this-final0.ckpt" | sha256sum -c -

# ---------------------------------------------------------------------------
# Stage 3 — runtime.
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.12-slim AS runtime

# ffmpeg/ffprobe are the workhorses: decode, ebur128, astats, forensic
# windows, tag read, artwork extract, opus preview. Debian trixie ships
# 7.1.5; the machine Tasks 6 and 7 were verified on runs 8.0.1. That delta is
# real and is checked, not assumed — the full pytest suite runs INSIDE this
# image (see the report). Debian's build is --enable-gpl, which the brief
# flagged; it is exec'd over a subprocess boundary exactly like Essentia, so
# it carries the same arm's-length posture the project already documents.
#
# libchromaprint-tools is deliberately NOT installed here — see the fetch
# stage for why apt's 1.5.1 was rejected in favour of the pinned 1.6.0 static
# build.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Essentia, in its own library world. LD_LIBRARY_PATH is set by the wrapper
# and NOT globally: exporting it process-wide would put Ubuntu 20.04's
# libavcodec ahead of Debian's on ffmpeg's own search path and quietly change
# what our loudness and forensics measurements see.
COPY --from=essentia /stage/lib/ /opt/essentia/lib/
COPY --from=essentia /stage/bin/streaming_extractor_music /opt/essentia/bin/
RUN set -eu; \
    printf '#!/bin/sh\nexec env LD_LIBRARY_PATH=/opt/essentia/lib /opt/essentia/bin/streaming_extractor_music "$@"\n' \
      > /usr/local/bin/streaming_extractor_music; \
    chmod +x /usr/local/bin/streaming_extractor_music

COPY --from=fetch /out/bin/fpcalc /usr/local/bin/fpcalc

# Torch CPU wheels from PyTorch's own CPU index, pinned to the exact versions
# in worker/bench/README.md's decision table. Without --index-url pip resolves
# the default CUDA build and the image grows by ~2 GB of unusable GPU
# runtime. Installed BEFORE the app so the slow layer caches across app edits.
#
# PyTorch, not ONNX Runtime — Task 2 measured ONNX 2.2x SLOWER on this model
# (unfused attention on the ORT CPU EP). onnxruntime stays in the [bench]
# extra and must never land in this image.
#
# --retries/--timeout for the same reason as the curl calls above: this layer
# pulls a 192 MB wheel and took 743s on the build that produced the numbers in
# the report. A default-retry pip turns a blip in that window into a failed
# deploy.
RUN pip install --no-cache-dir --retries 8 --timeout 120 \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.13.0 torchaudio==2.11.0

WORKDIR /app
COPY pyproject.toml ./
COPY app/ app/
# tests/ and bench/ ride along on purpose (~200 KB). The only honest way to
# answer "does the code still work against the REAL binaries" is to run the
# suite inside the artifact that ships, on the architecture that ships:
#   docker run --rm <image> python -m pytest tests/ -m "not integration"
COPY tests/ tests/
COPY bench/ bench/
RUN pip install --no-cache-dir --retries 8 --timeout 120 '.[dev]'

COPY --from=fetch /out/models/ models/

# MANDATORY, not tuning. The cgroup gives this container 1 vCPU, but OpenMP,
# OpenBLAS and MKL all read the HOST cpu_count and will happily spawn 8+
# threads to fight over that one core. Measured on the M1 baseline: 13.2s CPU
# at 1 thread vs 19.5s at 8 for identical work — and Cloudflare bills active
# CPU per 10ms, so the extra threads are ~48% more money for the same answer.
# app/beat_runtime.py also calls torch.set_num_threads(1); the env vars alone
# are not enough.
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    ORT_INTRA_OP_NUM_THREADS=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BEAT_THIS_CHECKPOINT=/app/models/beat_this-final0.ckpt

EXPOSE 8080
# --workers 1 plus the asyncio.Lock in app/main.py is what holds peak RSS at
# max(stage) ~= 1 GB. Two analyses in one instance would double it and blow
# the 3 GiB box.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
