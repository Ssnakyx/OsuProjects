"""osu! mod bitmask helpers shared by the desktop and web viewers."""
from __future__ import annotations

from typing import Tuple

NF = 1 << 0
EZ = 1 << 1
TD = 1 << 2
HD = 1 << 3
HR = 1 << 4
SD = 1 << 5
DT = 1 << 6
RX = 1 << 7
HT = 1 << 8
NC = 1 << 9   # always set together with DT
FL = 1 << 10
SO = 1 << 12
PF = 1 << 14

_NAMES = [
    (EZ, "EZ"), (NF, "NF"), (HT, "HT"),
    (HR, "HR"), (SD, "SD"), (PF, "PF"), (DT, "DT"), (NC, "NC"),
    (HD, "HD"), (FL, "FL"), (RX, "RX"), (SO, "SO"), (TD, "TD"),
]


def mods_string(mods: int) -> str:
    """Short human-readable mod string, e.g. ``HDDT``. Empty for nomod."""
    out = []
    for bit, name in _NAMES:
        if mods & bit:
            if name == "DT" and mods & NC:
                continue   # NC implies DT — show only NC
            out.append(name)
    return "".join(out)


def clock_rate(mods: int) -> float:
    """Playback rate of the song under these mods (1.5 DT/NC, 0.75 HT)."""
    if mods & (DT | NC):
        return 1.5
    if mods & HT:
        return 0.75
    return 1.0


def adjusted_difficulty(cs: float, ar: float, od: float, mods: int) -> Tuple[float, float, float]:
    """Apply EZ/HR multipliers to (CS, AR, OD). DT/HT are handled via clock_rate."""
    if mods & HR:
        cs = min(10.0, cs * 1.3)
        ar = min(10.0, ar * 1.4)
        od = min(10.0, od * 1.4)
    elif mods & EZ:
        cs *= 0.5
        ar *= 0.5
        od *= 0.5
    return cs, ar, od


def preempt_ms(ar: float) -> float:
    if ar < 5:
        return 1200 + 600 * (5 - ar) / 5
    if ar == 5:
        return 1200.0
    return 1200 - 750 * (ar - 5) / 5


def circle_radius(cs: float) -> float:
    return 54.4 - 4.48 * cs


def hit_windows(od: float, mods: int) -> Tuple[float, float, float]:
    """(win300, win100, win50) in beatmap-time ms.

    Replay frames and hit-object times are stored in song-file time, so under
    DT/HT the real-time windows are scaled by the clock rate to compare in
    file-time.
    """
    rate = clock_rate(mods)
    win300 = max(1.0, 80.0 - 6.0 * od) * rate
    win100 = max(win300 + 1.0, (140.0 - 8.0 * od) * rate)
    win50 = max(win100 + 1.0, (200.0 - 10.0 * od) * rate)
    return win300, win100, win50
