import math
from typing import List, Tuple

Point = Tuple[float, float]


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------

def _lerp(a: Point, b: Point, t: float) -> Point:
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _dist(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


# ---------------------------------------------------------------------------
# Bezier
# ---------------------------------------------------------------------------

def _bezier_point(pts: List[Point], t: float) -> Point:
    p = list(pts)
    for i in range(1, len(p)):
        for j in range(len(p) - i):
            p[j] = _lerp(p[j], p[j + 1], t)
    return p[0]


def _bezier_segment(pts: List[Point], steps: int) -> List[Point]:
    if len(pts) == 1:
        return [pts[0]]
    return [_bezier_point(pts, k / steps) for k in range(steps + 1)]


def _piecewise_bezier(ctrl: List[Point], steps: int) -> List[Point]:
    """osu! piecewise bezier — duplicate points mark segment breaks."""
    result: List[Point] = []
    seg: List[Point] = []
    for i, pt in enumerate(ctrl):
        seg.append(pt)
        is_anchor = i < len(ctrl) - 1 and ctrl[i] == ctrl[i + 1]
        if is_anchor:
            result.extend(_bezier_segment(seg, steps))
            seg = []
    if seg:
        result.extend(_bezier_segment(seg, steps))
    return result


# ---------------------------------------------------------------------------
# Catmull-Rom
# ---------------------------------------------------------------------------

def _catmull_rom(pts: List[Point], steps: int) -> List[Point]:
    if len(pts) < 2:
        return list(pts)
    ext = [pts[0]] + list(pts) + [pts[-1]]
    result: List[Point] = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        for k in range(steps + 1):
            t = k / steps
            t2, t3 = t * t, t * t * t
            x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t
                       + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t
                       + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            result.append((x, y))
    return result


# ---------------------------------------------------------------------------
# Perfect circle (3-point arc)
# ---------------------------------------------------------------------------

def _circumcircle(a: Point, b: Point, c: Point):
    ax, ay = a
    bx, by = b
    cx, cy = c
    D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(D) < 1e-8:
        return None, None
    ux = ((ax**2 + ay**2) * (by - cy) + (bx**2 + by**2) * (cy - ay)
          + (cx**2 + cy**2) * (ay - by)) / D
    uy = ((ax**2 + ay**2) * (cx - bx) + (bx**2 + by**2) * (ax - cx)
          + (cx**2 + cy**2) * (bx - ax)) / D
    return (ux, uy), math.hypot(ax - ux, ay - uy)


def _perfect_circle_arc(pts: List[Point], length: float, steps: int) -> List[Point]:
    if len(pts) < 3:
        return _linear(pts, steps)
    center, radius = _circumcircle(pts[0], pts[1], pts[2])
    if center is None or radius < 1e-4:
        return _piecewise_bezier(pts, steps)
    cx, cy = center

    def angle(p: Point) -> float:
        return math.atan2(p[1] - cy, p[0] - cx)

    start = angle(pts[0])
    end   = angle(pts[2])
    # Determine winding from the middle point
    v1 = (pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
    v2 = (pts[2][0] - pts[0][0], pts[2][1] - pts[0][1])
    clockwise = (v1[0] * v2[1] - v1[1] * v2[0]) < 0
    if clockwise:
        while end > start:
            end -= 2 * math.pi
    else:
        while end < start:
            end += 2 * math.pi

    arc_angle = length / radius
    if abs(end - start) > arc_angle:
        end = start + math.copysign(arc_angle, end - start)

    result: List[Point] = []
    for k in range(steps + 1):
        a = start + (end - start) * k / steps
        result.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    return result


# ---------------------------------------------------------------------------
# Linear
# ---------------------------------------------------------------------------

def _linear(pts: List[Point], steps: int) -> List[Point]:
    if len(pts) < 2:
        return list(pts)
    segs, total = [], 0.0
    for i in range(len(pts) - 1):
        d = _dist(pts[i], pts[i + 1])
        segs.append(d)
        total += d
    if total < 1e-8:
        return [pts[0]] * (steps + 1)
    result: List[Point] = []
    for k in range(steps + 1):
        target = k / steps * total
        acc = 0.0
        for i, seg in enumerate(segs):
            if acc + seg >= target or i == len(segs) - 1:
                t = min((target - acc) / seg, 1.0) if seg > 1e-8 else 0.0
                result.append(_lerp(pts[i], pts[i + 1], t))
                break
            acc += seg
    return result


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

def compute_slider_path(curve_type: str, ctrl: List[Point], length: float) -> List[Point]:
    steps = max(20, int(length / 4))
    if curve_type == 'L':
        raw = _linear(ctrl, steps)
    elif curve_type == 'P' and len(ctrl) == 3:
        raw = _perfect_circle_arc(ctrl, length, steps)
    elif curve_type == 'C':
        raw = _catmull_rom(ctrl, steps)
    else:
        raw = _piecewise_bezier(ctrl, steps)
    return _trim(raw, length)


def _trim(path: List[Point], length: float) -> List[Point]:
    if len(path) <= 1:
        return path
    result = [path[0]]
    acc = 0.0
    for i in range(1, len(path)):
        d = _dist(path[i - 1], path[i])
        if acc + d >= length:
            rem = length - acc
            t = rem / d if d > 1e-8 else 0.0
            result.append(_lerp(path[i - 1], path[i], t))
            return result
        acc += d
        result.append(path[i])
    return result


def path_at_t(path: List[Point], t: float) -> Point:
    """Return the position along the path at parameter t ∈ [0, 1]."""
    if not path:
        return (0.0, 0.0)
    if t <= 0:
        return path[0]
    if t >= 1:
        return path[-1]
    total = sum(_dist(path[i], path[i + 1]) for i in range(len(path) - 1))
    if total < 1e-8:
        return path[0]
    target = t * total
    acc = 0.0
    for i in range(len(path) - 1):
        d = _dist(path[i], path[i + 1])
        if acc + d >= target:
            s = (target - acc) / d if d > 1e-8 else 0.0
            return _lerp(path[i], path[i + 1], s)
        acc += d
    return path[-1]
