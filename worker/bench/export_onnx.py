# localchune — MIT licensed. See LICENSE.
# Export Beat This! (final0 checkpoint) to ONNX. See worker/bench/README.md
# for the decision this feeds and what happened when this was run.
#
# Static shape, not dynamic_axes: beat_this.inference.split_predict_aggregate
# (the function that actually runs the model in production, chunking a track
# into windows) always calls the model with a (1, 1500, 128) tensor -- 1500
# is beat_this's own chunk_size and every chunk is zero-padded to exactly
# that length. A first attempt exported with dynamic_axes on the frames
# dimension (matching the original brief sketch) worked and produced correct
# beats, but was 2.2x SLOWER than PyTorch: onnx.load() on that graph showed
# rotary-embedding-torch's cos/sin position tables (Cos/Sin/Gather/Shape/
# Constant nodes) couldn't be constant-folded at export time because they
# depend on the dynamic "frames" size, so ONNX Runtime recomputed them from
# scratch on every chunk. Since 1500 is always the real shape, fixing it
# lets the exporter fold those tables into constants once. See README.md
# "ONNX export" for both measurements.
import hashlib

import torch
from beat_this.inference import load_model

OUT = "../models/beat_this.onnx"


def main() -> None:
    model = load_model("final0", device="cpu").eval()
    # Beat This! consumes a log-mel spectrogram: (batch, frames, 128 mels).
    # Fixed at (1, 1500, 128) -- see module docstring above.
    dummy = torch.randn(1, 1500, 128)
    torch.onnx.export(
        model, dummy, OUT,
        input_names=["spect"], output_names=["beat", "downbeat"],
        opset_version=17,
        dynamo=False,  # torch>=2.6 defaults dynamo=True, which needs
                        # onnxscript and takes a different tracing path;
                        # the legacy TorchScript-based exporter is what the
                        # brief's numbers assume and what beat_this's rotary
                        # embeddings were historically tested against.
    )
    with open(OUT, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    print(f"exported {OUT} sha256={digest}")


if __name__ == "__main__":
    main()
