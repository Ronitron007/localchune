# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
from typing import Literal, Optional
from pydantic import BaseModel, Field


class AnalyzeRequest(BaseModel):
    """Metadata only. The audio bytes arrive out of band, via PUT /file/{file_id}.

    There is no `get_url` and no `put_prefix_url`. The Durable Object in front of
    this container holds the R2 binding and streams the bytes in; derived
    artifacts are pulled back out over GET /artifact/… and written to R2 by the
    DO. See Task 9 for why a binding beats a presigned URL now that we are on
    Cloudflare: the presigned URL was itself a credential, and this design has
    none anywhere.
    """
    file_id: str
    container_hint: Optional[str] = None
    analysis_version: str


class Fingerprint(BaseModel):
    algo_version: str
    duration_s: int
    frame_count: int
    fp_compressed_b64: str
    fp_sha256: str
    query_items: list[int]


class Beats(BaseModel):
    bpm: float                        # least-squares fit, NOT median IBI
    bpm_median_ibi: float             # kept for comparison; do not display
    beat_count: int
    ibi_std_ms: float
    beat_grid: list[float]
    downbeat_grid: list[float]
    confidence: float


class Key(BaseModel):
    key: str
    scale: Literal['major', 'minor']
    camelot: str
    open_key: str
    strength: float
    alt_profiles: dict[str, str]


class Loudness(BaseModel):
    integrated_lufs: float
    lra_lu: float
    true_peak_dbtp: float
    replaygain_db: float
    clipped_pct: float = Field(description="Proxy for clipping suspicion based on Abs Peak count recurrence, not a literal clipped-sample count. Use as a threshold signal; do not report as an exact percentage.")


class Forensics(BaseModel):
    meas_cutoff_hz: int
    meas_cliff_db_500: float
    meas_eff_bit_depth: int
    meas_eff_sample_rate: int
    lame_tag_present: bool
    lame_lowpass_hz: Optional[int] = None
    lame_vbr_method: Optional[str] = None
    encoder_string: Optional[str] = None
    lossy_ancestor: Literal['none', 'suspected', 'confirmed', 'abstain']
    inferred_source_kbps: Optional[int] = None
    tier: int = Field(ge=1, le=5)
    quality_score: float
    spectrogram_key: Optional[str] = None   # only written on a suspect verdict


class AnalyzeResponse(BaseModel):
    file_id: str
    analysis_version: str
    ok: bool
    error: Optional[str] = None
    duration_ms: int = 0              # DECODED, authoritative
    container: str = ''
    codec: str = ''
    sample_rate: int = 0
    bit_depth: int = 0
    channels: int = 0
    fingerprint: Optional[Fingerprint] = None
    beats: Optional[Beats] = None
    key: Optional[Key] = None
    loudness: Optional[Loudness] = None
    forensics: Optional[Forensics] = None
    tags: dict = {}
    peaks_key: Optional[str] = None
    preview_key: Optional[str] = None
    artwork_key: Optional[str] = None
    thumb_key: Optional[str] = None
    cpu_seconds: float = 0.0
