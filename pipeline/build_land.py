# /// script
# requires-python = ">=3.11"
# ///
"""Decode world-atlas land-110m TopoJSON into flat coordinate rings.

Doing this at build time means the browser needs no TopoJSON decoder and no map tiles:
the map panel is a canvas drawing over a 30-40 KB static asset, so it works offline and
cannot stall a live demo on somebody else's tile server.

Source: https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json
Derived from Natural Earth, which is in the public domain.
"""

import json
import sys
from pathlib import Path


def decode_arcs(topology: dict) -> list[list[tuple[float, float]]]:
    scale = topology["transform"]["scale"]
    translate = topology["transform"]["translate"]
    decoded = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale[0] + translate[0], y * scale[1] + translate[1]))
        decoded.append(points)
    return decoded


def resolve(ring: list[int], arcs: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for index in ring:
        arc = arcs[~index][::-1] if index < 0 else arcs[index]
        out.extend(arc[1:] if out else arc)
    return out


def unwrap(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Remove antimeridian wraps so an equirectangular fill does not smear across the map.

    world-atlas stores a few rings — an island at 71 degrees north, Antarctica, Eurasia — with
    consecutive vertices that jump a full 360 degrees of longitude. Drawn straight onto a linear
    projection each jump becomes a band right across the canvas. Accumulating an offset keeps
    each ring continuous; the parts that then sit beyond +/-180 simply fall outside the view.
    """
    if not points:
        return points
    out = [points[0]]
    offset = 0.0
    for lon, lat in points[1:]:
        delta = lon + offset - out[-1][0]
        if delta > 180:
            offset -= 360
        elif delta < -180:
            offset += 360
        out.append((lon + offset, lat))
    return out


def main() -> int:
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    topology = json.loads(source.read_text())
    arcs = decode_arcs(topology)

    rings: list[list[float]] = []
    for geometry in topology["objects"]["land"]["geometries"]:
        polygons = (
            [geometry["arcs"]] if geometry["type"] == "Polygon" else geometry["arcs"]
        )
        for polygon in polygons:
            for ring in polygon:
                points = unwrap(resolve(ring, arcs))
                if len(points) < 4:
                    continue
                flat: list[float] = []
                for lon, lat in points:
                    flat.append(round(lon, 2))
                    flat.append(round(lat, 2))
                rings.append(flat)

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"rings": rings}, separators=(",", ":")))
    total = sum(len(r) // 2 for r in rings)
    print(f"wrote {target} ({target.stat().st_size / 1000:.0f} KB, {len(rings)} rings, {total} points)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
