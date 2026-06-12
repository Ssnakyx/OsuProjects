from __future__ import annotations

import bisect
from dataclasses import dataclass
from typing import List, Tuple

from . import mods as mods_mod


@dataclass
class ScoreEvent:
    """One judged hit object (or the initial sentinel).

    ``judgment`` is 300 / 100 / 50 for hits, 0 for a miss, -1 for the
    sentinel placed at t = -inf. ``dt`` is the signed hit error in ms
    (press_time - object_time); 0.0 for misses.
    Counts are cumulative so any point of the timeline knows its totals.
    """
    time:     float
    score:    int
    combo:    int
    judgment: int
    x:        float
    y:        float
    dt:       float
    acc:      float
    n300:     int
    n100:     int
    n50:      int
    nmiss:    int


def compute_live_scores(replay, beatmap) -> List[ScoreEvent]:
    """Simulate hit detection for *replay* against *beatmap*.

    Uses osu!-stable hit windows (mod-adjusted) and the classic combo
    multiplier. Spinners are ignored; sliders are judged on the head only.
    """
    cs, _, od = mods_mod.adjusted_difficulty(beatmap.cs, beatmap.ar, beatmap.od, replay.mods)
    win300, win100, win50 = mods_mod.hit_windows(od, replay.mods)
    cr = mods_mod.circle_radius(cs)

    # New-key-press events (bits 0-3 = M1/M2/K1/K2), sorted by time.
    press_t:  List[float] = []
    presses:  List[Tuple[float, float, float]] = []
    prev_keys = 0
    for frame in replay.frames:
        new = frame.keys & ~prev_keys & 0b1111
        if new:
            press_t.append(frame.time)
            presses.append((frame.time, frame.x, frame.y))
        prev_keys = frame.keys

    events: List[ScoreEvent] = [
        ScoreEvent(float('-inf'), 0, 0, -1, 0.0, 0.0, 0.0, 100.0, 0, 0, 0, 0)
    ]
    score = combo = 0
    n300 = n100 = n50 = nmiss = 0
    used: set[int] = set()
    r2 = (cr * 1.5) ** 2

    def acc() -> float:
        total = n300 + n100 + n50 + nmiss
        if total == 0:
            return 100.0
        return 100.0 * (300 * n300 + 100 * n100 + 50 * n50) / (300 * total)

    for obj in beatmap.hit_objects:
        if obj.is_spinner:
            continue

        t0 = float(obj.time)
        lo = bisect.bisect_left(press_t, t0 - win50)
        hi = bisect.bisect_right(press_t, t0 + win50)

        best_i  = -1
        best_dt = float('inf')
        for i in range(lo, hi):
            if i in used:
                continue
            t, px, py = presses[i]
            dx, dy = px - obj.x, py - obj.y
            if dx * dx + dy * dy <= r2 and abs(t - t0) < abs(best_dt):
                best_dt = t - t0
                best_i  = i

        if best_i >= 0:
            used.add(best_i)
            combo += 1
            ad = abs(best_dt)
            hit_val = 300 if ad <= win300 else (100 if ad <= win100 else 50)
            if   hit_val == 300: n300 += 1
            elif hit_val == 100: n100 += 1
            else:                n50  += 1
            score += round(hit_val * (1.0 + max(0, combo - 1) / 25.0))
            events.append(ScoreEvent(
                presses[best_i][0], score, combo, hit_val,
                obj.x, obj.y, best_dt, acc(), n300, n100, n50, nmiss,
            ))
        else:
            combo = 0
            nmiss += 1
            events.append(ScoreEvent(
                t0 + win50, score, 0, 0,
                obj.x, obj.y, 0.0, acc(), n300, n100, n50, nmiss,
            ))

    return events


# ---------------------------------------------------------------------------
# Timeline lookups
# ---------------------------------------------------------------------------

def _index_at(events: List[ScoreEvent], time: float) -> int:
    """Index of the last event with event.time <= time (>= 0, sentinel)."""
    lo, hi = 0, len(events)
    while lo < hi:
        mid = (lo + hi) >> 1
        if events[mid].time <= time:
            lo = mid + 1
        else:
            hi = mid
    return max(0, lo - 1)


def state_at(events: List[ScoreEvent], time: float) -> ScoreEvent:
    if not events:
        return ScoreEvent(float('-inf'), 0, 0, -1, 0.0, 0.0, 0.0, 100.0, 0, 0, 0, 0)
    return events[_index_at(events, time)]


def score_at(events: List[ScoreEvent], time: float) -> int:
    return state_at(events, time).score


def combo_at(events: List[ScoreEvent], time: float) -> int:
    return state_at(events, time).combo


def acc_at(events: List[ScoreEvent], time: float) -> float:
    return state_at(events, time).acc


def recent_events(
    events: List[ScoreEvent], time: float, window_ms: float,
) -> List[ScoreEvent]:
    """Judged events with time in (time - window_ms, time] — for popups
    and the hit-error bar."""
    if not events:
        return []
    hi = _index_at(events, time) + 1
    lo = hi
    floor = time - window_ms
    while lo > 1 and events[lo - 1].time > floor:
        lo -= 1
    return [e for e in events[lo:hi] if e.judgment >= 0]
