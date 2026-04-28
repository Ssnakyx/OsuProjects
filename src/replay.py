from __future__ import annotations
from dataclasses import dataclass
from typing import List, Tuple

try:
    import osrparse
except ImportError:
    osrparse = None   # surfaced as error at load time


@dataclass
class ReplayFrame:
    time: float   # absolute ms
    x:    float
    y:    float
    keys: int


@dataclass
class Replay:
    beatmap_md5: str
    player_name: str
    mods:        int
    score:       int
    frames:      List[ReplayFrame]


def load_replay(path: str) -> Replay:
    if osrparse is None:
        raise ImportError("osrparse is not installed. Run: pip install osrparse")

    osr = osrparse.Replay.from_path(path)

    if osr.replay_data is None:
        raise ValueError("Replay contains no cursor data.")

    frames: List[ReplayFrame] = []
    t = 0.0
    for ev in osr.replay_data:
        if ev.time_delta == -12345:   # sentinel / life-bar marker
            continue
        t += ev.time_delta
        if t < 0:
            continue
        frames.append(ReplayFrame(t, float(ev.x), float(ev.y), int(ev.keys)))

    return Replay(
        beatmap_md5 = osr.beatmap_hash or "",
        player_name = osr.username or "Player",
        mods        = int(osr.mods),
        score       = int(osr.score),
        frames      = frames,
    )


def cursor_at(frames: List[ReplayFrame], time: float) -> Tuple[float, float]:
    """Linear interpolation of cursor position at the given absolute time (ms)."""
    if not frames:
        return (256.0, 192.0)
    if time <= frames[0].time:
        return (frames[0].x, frames[0].y)
    if time >= frames[-1].time:
        return (frames[-1].x, frames[-1].y)

    lo, hi = 0, len(frames) - 1
    while lo < hi - 1:
        mid = (lo + hi) >> 1
        if frames[mid].time <= time:
            lo = mid
        else:
            hi = mid

    f0, f1 = frames[lo], frames[hi]
    if f1.time == f0.time:
        return (f0.x, f0.y)
    s = (time - f0.time) / (f1.time - f0.time)
    return (f0.x + (f1.x - f0.x) * s, f0.y + (f1.y - f0.y) * s)
