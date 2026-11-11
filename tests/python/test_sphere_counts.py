"""PR5 sphere tri-count test (Tier 1, stage-5 §4: PR4 owed item).

PR4 found the analytic sphere count overcounted by 2*widthSegments:
count_primitive said 384 tris for a 16x12 sphere while three.js
SphereGeometry emits 352 — it skips the two pole-row triangles per
column, which are degenerate (zero area: every vertex of a pole row
coincides). The fix is in both places so the counter and the generator
agree with each other and with three.js:

* generate_sphere emits one triangle per column in the pole rows
  (top row: b,c,d; bottom row: a,b,d — the three.js pattern),
* count_primitive reports 2*ws*(hs-1) tris.

Run: pytest tests/python
"""

import math

import pytest

from plastis3d_scene import primitives


def _triangle_area(p, q, r):
    """Area of the triangle with vertices p, q, r (3-vectors)."""
    ux, uy, uz = q[0] - p[0], q[1] - p[1], q[2] - p[2]
    vx, vy, vz = r[0] - p[0], r[1] - p[1], r[2] - p[2]
    cx = uy * vz - uz * vy
    cy = uz * vx - ux * vz
    cz = ux * vy - uy * vx
    return 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)


@pytest.mark.parametrize(
    "ws,hs,expected_tris",
    [
        (3, 3, 12),  # smallest valid segments
        (16, 12, 352),  # the PR4 case: three.js emits 352, not 384
        (32, 16, 960),
        (64, 32, 3968),
    ],
)
def test_sphere_tri_count_matches_threejs(ws, hs, expected_tris):
    primitive = {
        "type": "sphere",
        "radius": 0.5,
        "widthSegments": ws,
        "heightSegments": hs,
    }
    counts = primitives.count_primitive(primitive)
    assert counts["verts"] == (ws + 1) * (hs + 1)
    assert counts["tris"] == expected_tris
    generated = primitives.generate(primitive)
    assert len(generated["positions"]) // 3 == counts["verts"]
    assert len(generated["indices"]) // 3 == counts["tris"]


@pytest.mark.parametrize("ws,hs", [(3, 3), (16, 12), (32, 16)])
def test_sphere_has_no_degenerate_triangles(ws, hs):
    """Every generated sphere triangle has nonzero area (no pole junk)."""
    generated = primitives.generate(
        {"type": "sphere", "radius": 0.5, "widthSegments": ws, "heightSegments": hs}
    )
    positions = generated["positions"]
    indices = generated["indices"]
    assert len(indices) % 3 == 0
    for i in range(0, len(indices), 3):
        p = positions[3 * indices[i] : 3 * indices[i] + 3]
        q = positions[3 * indices[i + 1] : 3 * indices[i + 1] + 3]
        r = positions[3 * indices[i + 2] : 3 * indices[i + 2] + 3]
        assert _triangle_area(p, q, r) > 0.0
