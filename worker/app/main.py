# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
"""FastAPI skeleton for the analysis worker.

Plain FastAPI on port 8080. No platform awareness here — this container
runs on Cloudflare Containers, but that is Task 8's problem, not this
module's. The Durable Object in front of it streams bytes in and pulls
derived artifacts back out; this app just implements the HTTP surface.
"""
from fastapi import FastAPI

from app.models import AnalyzeRequest, AnalyzeResponse

app = FastAPI(title="localchune-analysis")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    # Placeholder — later tasks (M3.2-M3.7) fill in decode, fingerprint,
    # beats, key, loudness, tags and forensics. For now this proves the
    # contract wires up end to end.
    return AnalyzeResponse(
        file_id=req.file_id,
        analysis_version=req.analysis_version,
        ok=False,
        error="not implemented",
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
