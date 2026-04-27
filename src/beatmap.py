from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

from .curves import compute_slider_path


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class TimingPoint:
    offset:     float
    beat_length: float   # >0 uninherited (ms/beat), <0 inherited (velocity %)
    inherited:  bool


@dataclass
class HitObject:
    x:          float
    y:          float
    time:       int      # ms
    type_flags: int

    @property
    def is_circle(self) -> bool:  return bool(self.type_flags & 1)
    @property
    def is_slider(self) -> bool:  return bool(self.type_flags & 2)
    @property
    def is_spinner(self) -> bool: return bool(self.type_flags & 8)
    @property
    def is_new_combo(self) -> bool: return bool(self.type_flags & 4)


@dataclass
class Circle(HitObject):
    pass


@dataclass
class Slider(HitObject):
    curve_type:     str = 'B'
    control_points: List[Tuple[float, float]] = field(default_factory=list)
    slides:         int   = 1
    length:         float = 100.0
    duration:       float = 0.0    # ms, computed
    path:           List[Tuple[float, float]] = field(default_factory=list)


@dataclass
class Spinner(HitObject):
    end_time: int = 0


@dataclass
class Beatmap:
    title:          str = ""
    artist:         str = ""
    version:        str = ""
    audio_filename: str = ""   # from [General] AudioFilename

    hp:    float = 5.0
    cs:    float = 5.0
    od:    float = 5.0
    ar:    float = 5.0
    sm:    float = 1.4   # slider multiplier
    str_:  float = 1.0   # slider tick rate

    timing_points: List[TimingPoint]  = field(default_factory=list)
    hit_objects:   List[HitObject]    = field(default_factory=list)

    @property
    def preempt(self) -> float:
        """Approach circle preempt time in ms."""
        if self.ar < 5:
            return 1200 + 600 * (5 - self.ar) / 5
        if self.ar == 5:
            return 1200.0
        return 1200 - 750 * (self.ar - 5) / 5

    @property
    def fade_in(self) -> float:
        if self.ar < 5:
            return 800 + 400 * (5 - self.ar) / 5
        if self.ar == 5:
            return 800.0
        return 800 - 500 * (self.ar - 5) / 5

    @property
    def circle_radius(self) -> float:
        return 54.4 - 4.48 * self.cs


# ---------------------------------------------------------------------------
# Timing helpers
# ---------------------------------------------------------------------------

def _beat_and_velocity(tps: List[TimingPoint], t: float) -> Tuple[float, float]:
    """Return (uninherited_beat_ms, velocity_multiplier) at time t."""
    beat = 500.0
    vel  = 1.0
    for tp in tps:
        if tp.offset > t:
            break
        if not tp.inherited:
            beat = tp.beat_length
            vel  = 1.0
        else:
            vel = -100.0 / tp.beat_length
    return beat, vel


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def load_beatmap(path: str) -> Beatmap:
    bm = Beatmap()

    with open(path, encoding='utf-8', errors='ignore') as f:
        text = f.read()

    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('//'):
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            continue

        if section == 'General':
            if line.startswith('AudioFilename:'):
                bm.audio_filename = line[14:].strip()

        elif section == 'Metadata':
            if   line.startswith('Title:'):   bm.title   = line[6:].strip()
            elif line.startswith('Artist:'):  bm.artist  = line[7:].strip()
            elif line.startswith('Version:'): bm.version = line[8:].strip()

        elif section == 'Difficulty':
            if ':' not in line:
                continue
            k, v = line.split(':', 1)
            try:
                fv = float(v.strip())
                if   k == 'HPDrainRate':       bm.hp  = fv
                elif k == 'CircleSize':         bm.cs  = fv
                elif k == 'OverallDifficulty':  bm.od  = fv
                elif k == 'ApproachRate':       bm.ar  = fv
                elif k == 'SliderMultiplier':   bm.sm  = fv
                elif k == 'SliderTickRate':     bm.str_ = fv
            except ValueError:
                pass

        elif section == 'TimingPoints':
            parts = line.split(',')
            if len(parts) < 2:
                continue
            try:
                offset = float(parts[0])
                bl     = float(parts[1])
                inherited = bl < 0
                bm.timing_points.append(TimingPoint(offset, bl, inherited))
            except ValueError:
                pass

        elif section == 'HitObjects':
            parts = line.split(',')
            if len(parts) < 5:
                continue
            try:
                x, y   = float(parts[0]), float(parts[1])
                t      = int(parts[2])
                flags  = int(parts[3])

                if flags & 2:   # Slider
                    if len(parts) < 8:
                        continue
                    curve_info  = parts[5]
                    slides      = int(parts[6])
                    length      = float(parts[7])

                    cparts     = curve_info.split('|')
                    ctype      = cparts[0] if cparts else 'B'
                    ctrl: List[Tuple[float, float]] = [(x, y)]
                    for cp in cparts[1:]:
                        coords = cp.split(':')
                        if len(coords) == 2:
                            ctrl.append((float(coords[0]), float(coords[1])))

                    beat, vel = _beat_and_velocity(bm.timing_points, t)
                    duration  = (length / (bm.sm * 100.0 * vel)) * beat * slides
                    path      = compute_slider_path(ctype, ctrl, length)

                    bm.hit_objects.append(
                        Slider(x, y, t, flags, ctype, ctrl, slides, length, duration, path)
                    )

                elif flags & 8:  # Spinner
                    end = int(parts[5]) if len(parts) > 5 else t + 1000
                    bm.hit_objects.append(Spinner(x, y, t, flags, end))

                else:            # Circle (flag & 1)
                    bm.hit_objects.append(Circle(x, y, t, flags))

            except (ValueError, IndexError):
                pass

    return bm
