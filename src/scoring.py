from __future__ import annotations
from typing import List, Tuple


def compute_live_scores(replay, beatmap) -> List[Tuple[float, int, int]]:
    """
    Simulate hit detection for *replay* against *beatmap*.

    Returns [(time_ms, cumulative_score, current_combo), ...] sorted by time.
    Uses osu!-stable hit windows and a basic combo multiplier.
    Spinners are ignored; sliders are treated as circles (head-hit only).
    """
    od = beatmap.od
    cr = beatmap.circle_radius

    win300 = max(1.0,           80.0 -  6.0 * od)
    win100 = max(win300 + 1.0, 140.0 -  8.0 * od)
    win50  = max(win100 + 1.0, 200.0 - 10.0 * od)

    # Collect new-key-press events (bits 0-3 = M1/M2/K1/K2)
    key_presses: List[Tuple[float, float, float]] = []
    prev_keys = 0
    for frame in replay.frames:
        new = frame.keys & ~prev_keys & 0b1111
        if new:
            key_presses.append((frame.time, frame.x, frame.y))
        prev_keys = frame.keys

    events: List[Tuple[float, int, int]] = [(float('-inf'), 0, 0)]
    score = 0
    combo = 0
    used: set[int] = set()

    for obj in beatmap.hit_objects:
        if obj.is_spinner:
            combo = 0
            continue

        t0      = float(obj.time)
        best_i  = -1
        best_dt = float('inf')

        for i, (t, px, py) in enumerate(key_presses):
            if i in used:
                continue
            dt = t - t0
            if not (-win50 <= dt <= win50):
                continue
            dx, dy = px - obj.x, py - obj.y
            if dx * dx + dy * dy <= (cr * 1.5) ** 2:
                if abs(dt) < best_dt:
                    best_dt = abs(dt)
                    best_i  = i

        if best_i >= 0:
            t_hit   = key_presses[best_i][0]
            used.add(best_i)
            combo  += 1
            hit_val = 300 if best_dt <= win300 else (100 if best_dt <= win100 else 50)
            score  += round(hit_val * (1.0 + max(0, combo - 1) / 25.0))
            events.append((t_hit, score, combo))
        else:
            combo = 0

    return events


def _lookup(events: List[Tuple[float, int, int]], time: float) -> Tuple[int, int]:
    """Binary search — returns (score, combo) at *time*."""
    lo, hi = 0, len(events)
    while lo < hi:
        mid = (lo + hi) >> 1
        if events[mid][0] <= time:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0:
        return events[lo - 1][1], events[lo - 1][2]
    return 0, 0


def score_at(events: List[Tuple[float, int, int]], time: float) -> int:
    return _lookup(events, time)[0]


def combo_at(events: List[Tuple[float, int, int]], time: float) -> int:
    return _lookup(events, time)[1]
