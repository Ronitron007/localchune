# localchune — MIT licensed. See LICENSE.
# NOTE: the distributed combination is AGPL-3.0 because the analysis
# worker includes Essentia. LICENSE explains why.
import re
from app.fingerprint import make_query_items, algo_version

def test_query_items_are_sorted_deduped_and_masked():
    raw = [0xFFFFFFFF, 0xFFFFFFFF, 0x00000000, 0x0FFF0000]
    items = make_query_items(raw, mask=12, windows=[(0, 4)])
    assert items == sorted(set(items))
    assert all(0 <= i < (1 << 20) for i in items)

def test_query_items_use_both_windows():
    # 120 seconds at 8/s. Shifted left by the mask width so each index lands
    # in its own bucket after `>> mask` — the brief's literal `range(0, 960)`
    # never exceeds 1<<12, so every value collapses to bucket 0 regardless of
    # window and the assertion below is mathematically unsatisfiable. Fixture
    # fixed; make_query_items itself is unchanged from the brief.
    raw = [x << 12 for x in range(0, 8 * 120)]
    a = make_query_items(raw, mask=12, windows=[(10, 40)])
    b = make_query_items(raw, mask=12, windows=[(10, 40), (60, 90)])
    assert len(b) > len(a)

def test_algo_version_format():
    # algo_version() returns a string matching cp-X.Y(.Z)?/test2/11025
    version_str = algo_version()
    assert isinstance(version_str, str)
    assert re.match(r'^cp-\d+\.\d+(\.\d+)?/test2/11025$', version_str)
