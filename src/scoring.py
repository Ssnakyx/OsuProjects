from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

from . import mods as mods_mod
from .beatmap import compute_stack_heights, stack_offset


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
    # Time of the hit object this event judges (NaN for the sentinel), so
    # two replays can be compared note by note.
    obj_time: float = float('nan')


def compute_live_scores(replay, beatmap) -> List[ScoreEvent]:
    """Simulate hit detection for *replay* against *beatmap*.

    Follows osu!stable's rules closely enough for a viewer:

    * mod-adjusted hit windows and circle size, objects shifted by stacking;
    * **note lock** — only the earliest unjudged object can be hit; clicking
      a later one while it is still pending does nothing;
    * clicking an object *too early* (before its 50 window but within the
      400 ms miss window) is a miss;
    * the classic combo multiplier for score.

    Spinners are ignored and sliders are judged on their head only (no
    ticks / ends), so totals are an approximation of the real score.
    """
    cs, ar, od = mods_mod.adjusted_difficulty(beatmap.cs, beatmap.ar, beatmap.od, replay.mods)
    win300, win100, win50 = mods_mod.hit_windows(od, replay.mods)
    rate = mods_mod.clock_rate(replay.mods)
    win_miss = 400.0 * rate
    radius = mods_mod.circle_radius(cs)
    hard_rock = bool(replay.mods & mods_mod.HR)
    heights = compute_stack_heights(beatmap, mods_mod.preempt_ms(ar))

    # Judgeable objects (no spinners) with their stacked positions.
    targets = []
    for obj, h in zip(beatmap.hit_objects, heights):
        if obj.is_spinner:
            continue
        dx, dy = stack_offset(h, radius, hard_rock)
        targets.append((float(obj.time), obj.x + dx, obj.y + dy))

    # New-key-press events (bits 0-3 = M1/M2/K1/K2), in time order.
    presses: List[Tuple[float, float, float]] = []
    prev_keys = 0
    for frame in replay.frames:
        new = frame.keys & ~prev_keys & 0b1111
        if new:
            presses.append((frame.time, frame.x, frame.y))
        prev_keys = frame.keys

    events: List[ScoreEvent] = [
        ScoreEvent(float('-inf'), 0, 0, -1, 0.0, 0.0, 0.0, 100.0, 0, 0, 0, 0)
    ]
    score = combo = 0
    n300 = n100 = n50 = nmiss = 0
    r2 = radius * radius

    def acc() -> float:
        total = n300 + n100 + n50 + nmiss
        if total == 0:
            return 100.0
        return 100.0 * (300 * n300 + 100 * n100 + 50 * n50) / (300 * total)

    def miss(at: float, x: float, y: float, ot: float) -> None:
        nonlocal combo, nmiss
        combo = 0
        nmiss += 1
        events.append(ScoreEvent(at, score, 0, 0, x, y, 0.0, acc(),
                                 n300, n100, n50, nmiss, ot))

    cur = 0          # earliest unjudged object (note lock)
    for pt, px, py in presses:
        # Objects whose window closed before this press are misses.
        while cur < len(targets) and targets[cur][0] + win50 < pt:
            t0, ox, oy = targets[cur]
            miss(t0 + win50, ox, oy, t0)
            cur += 1
        if cur >= len(targets):
            break
        t0, ox, oy = targets[cur]
        dt = pt - t0
        if dt < -win_miss:
            continue                          # far too early: ignored
        if (px - ox) ** 2 + (py - oy) ** 2 > r2:
            continue                          # not on the note (note lock)
        if dt < -win50:
            miss(pt, ox, oy, t0)                # clicked too early
            cur += 1
            continue
        ad = abs(dt)
        hit_val = 300 if ad <= win300 else (100 if ad <= win100 else 50)
        if   hit_val == 300: n300 += 1
        elif hit_val == 100: n100 += 1
        else:                n50  += 1
        combo += 1
        score += round(hit_val * (1.0 + max(0, combo - 1) / 25.0))
        events.append(ScoreEvent(pt, score, combo, hit_val, ox, oy, dt, acc(),
                                 n300, n100, n50, nmiss, t0))
        cur += 1

    while cur < len(targets):
        t0, ox, oy = targets[cur]
        miss(t0 + win50, ox, oy, t0)
        cur += 1

    # Misses are appended at window close, hits at press time: keep the
    # timeline sorted for the binary-search lookups.
    events[1:] = sorted(events[1:], key=lambda e: e.time)
    return _recount(events)


def _recount(events: List[ScoreEvent]) -> List[ScoreEvent]:
    """Re-derive the cumulative fields after a sort (keeps them monotonic)."""
    score = combo = 0
    n = {300: 0, 100: 0, 50: 0, 0: 0}
    out = [events[0]]
    for e in events[1:]:
        n[e.judgment] += 1
        if e.judgment == 0:
            combo = 0
        else:
            combo += 1
            score += round(e.judgment * (1.0 + max(0, combo - 1) / 25.0))
        total = sum(n.values())
        acc = 100.0 * (300 * n[300] + 100 * n[100] + 50 * n[50]) / (300 * total)
        out.append(ScoreEvent(e.time, score, combo, e.judgment, e.x, e.y, e.dt,
                              acc, n[300], n[100], n[50], n[0], e.obj_time))
    return out


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
