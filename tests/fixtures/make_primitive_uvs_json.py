#!/usr/bin/env python3
"""Generate tests/fixtures/primitive-uvs.json (PR15, correctness audit C-08).

The Python generators' positions, normals and UVs for every primitive at its
defaults and at a few awkward parameter sets (odd segment counts, a tapered
cylinder, a non-cubic box). tests/node/primitive-uv.test.ts compares them with
what three.js's own geometry gives the viewport, after the v flip between the
two conventions, so a texture lands the same way in the editor and in the
exported file.

Deterministic, stdlib only. Regenerate with:
    python3 tests/fixtures/make_primitive_uvs_json.py
tests/python/test_textures.py requires the checked-in file to match a fresh run.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))

from plastis3d_scene import primitives  # noqa: E402

PATH = HERE / "primitive-uvs.json"

CASES = [
    {"type": "box"},
    {"type": "box", "width": 2.0, "height": 0.5, "depth": 1.5},
    {"type": "sphere"},
    {"type": "sphere", "radius": 1.0, "widthSegments": 7, "heightSegments": 5},
    {"type": "cylinder"},
    {"type": "cylinder", "radiusTop": 0.25, "radiusBottom": 0.75, "height": 2.0, "radialSegments": 7},
    {"type": "cone"},
    {"type": "cone", "radius": 1.0, "height": 2.0, "radialSegments": 5},
    {"type": "torus"},
    {"type": "torus", "radius": 1.0, "tube": 0.3, "radialSegments": 5, "tubularSegments": 7},
    {"type": "plane"},
    {"type": "plane", "width": 3.0, "height": 1.0},
    {"type": "capsule"},
    {"type": "capsule", "radius": 0.4, "length": 1.5, "capSegments": 3, "radialSegments": 6},
]


def build() -> dict:
    cases = []
    for primitive in CASES:
        mesh = primitives.generate(primitive)
        cases.append(
            {
                "primitive": primitive,
                "positions": [round(v, 7) for v in mesh["positions"]],
                "normals": [round(v, 7) for v in mesh["normals"]],
                "uvs": [round(v, 7) for v in mesh["uvs"]],
            }
        )
    return {
        "convention": "uvs are glTF (origin top-left, v down); three.js geometry uvs are v up, so v_three = 1 - v",
        "cases": cases,
    }


def main() -> None:
    PATH.write_text(json.dumps(build(), indent=0, sort_keys=True) + "\n", encoding="utf-8")
    print("wrote %s (%d bytes)" % (PATH.name, PATH.stat().st_size))


if __name__ == "__main__":
    main()
