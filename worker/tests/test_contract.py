# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
from app.models import AnalyzeResponse


def test_response_serialises_with_only_required_fields():
    r = AnalyzeResponse(file_id="f1", analysis_version="v1", ok=False, error="boom")
    d = r.model_dump()
    assert d["ok"] is False
    assert d["duration_ms"] == 0
    assert d["fingerprint"] is None


def test_tier_is_bounded():
    from pydantic import ValidationError
    from app.models import Forensics
    import pytest
    with pytest.raises(ValidationError):
        Forensics(meas_cutoff_hz=1, meas_cliff_db_500=1, meas_eff_bit_depth=16,
                  meas_eff_sample_rate=44100, lame_tag_present=False,
                  lossy_ancestor='none', tier=9, quality_score=1)
