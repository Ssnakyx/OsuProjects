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
    creator:        str = ""
    audio_filename: str = ""   # from [General] AudioFilename
    background:     str = ""   # from [Events] — image filename, may be empty
    beatmapset_id:  int = 0
    stack_leniency: float = 0.7
    format_version: int = 14

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


def end_time(obj: HitObject) -> float:
    """Time (ms) at which a hit object ends."""
    if isinstance(obj, Slider):
        return obj.time + obj.duration
    if isinstance(obj, Spinner):
        return float(obj.end_time)
    return float(obj.time)


def end_position(obj: HitObject) -> Tuple[float, float]:
    """Where the object ends (slider tail after its last repeat)."""
    if isinstance(obj, Slider) and obj.path:
        return obj.path[-1] if obj.slides % 2 == 1 else obj.path[0]
    return (obj.x, obj.y)


def compute_stack_heights(bm: "Beatmap", preempt: float) -> List[int]:
    """osu! stacking (file format v6+), as in osu!lazer's OsuBeatmapProcessor.

    Objects placed on (almost) the same spot shortly after each other are
    drawn — and must be clicked — slightly up-left of each other. Returns the
    stack height of every object; the on-screen offset of an object is
    ``-height * radius / 10`` on both axes (y is mirrored under Hard Rock).
    """
    objs = bm.hit_objects
    n_obj = len(objs)
    heights = [0] * n_obj
    if n_obj == 0:
        return heights
    threshold = preempt * bm.stack_leniency
    stack_dist = 3.0

    def dist(a, b) -> float:
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5

    if bm.format_version < 6:
        return heights   # old maps use a different (rare) algorithm

    for i in range(n_obj - 1, 0, -1):
        n = i
        ii = i
        if heights[ii] != 0 or isinstance(objs[ii], Spinner):
            continue
        if isinstance(objs[ii], Slider):
            while n - 1 >= 0:
                n -= 1
                on = objs[n]
                if isinstance(on, Spinner):
                    continue
                if objs[ii].time - on.time > threshold:
                    break
                if dist(end_position(on), (objs[ii].x, objs[ii].y)) < stack_dist:
                    heights[n] = heights[ii] + 1
                    ii = n
        else:
            while n - 1 >= 0:
                n -= 1
                on = objs[n]
                if isinstance(on, Spinner):
                    continue
                if objs[ii].time - end_time(on) > threshold:
                    break
                if isinstance(on, Slider) and dist(end_position(on), (objs[ii].x, objs[ii].y)) < stack_dist:
                    offset = heights[ii] - heights[n] + 1
                    for j in range(n + 1, i + 1):
                        if dist(end_position(on), (objs[j].x, objs[j].y)) < stack_dist:
                            heights[j] -= offset
                    break
                if dist((on.x, on.y), (objs[ii].x, objs[ii].y)) < stack_dist:
                    heights[n] = heights[ii] + 1
                    ii = n
    return heights


def stack_offset(height: int, radius: float, hard_rock: bool = False) -> Tuple[float, float]:
    """(dx, dy) to add to an object's position for its stack height.

    Positions here are in the *unflipped* playfield (Hard Rock replays are
    un-flipped when loaded), so under HR the vertical offset is mirrored."""
    o = -height * radius / 10.0
    return (o, -o if hard_rock else o)


def build_combo_info(bm: "Beatmap", palette_size: int) -> Tuple[List[int], List[int]]:
    """Per-object (colour_index, combo_number) following new-combo flags."""
    color_idx: List[int] = []
    combo_num: List[int] = []
    ci = -1
    n = 0
    for obj in bm.hit_objects:
        if obj.is_new_combo or ci == -1:
            ci = (ci + 1) % palette_size
            n = 1
        else:
            n += 1
        color_idx.append(ci)
        combo_num.append(n)
    return color_idx, combo_num


# ---------------------------------------------------------------------------
# Timing helpers
# ---------------------------------------------------------------------------

def _beat_and_velocity(tps: List[TimingPoint], t: float) -> Tuple[float, float]:
    """Return (uninherited_beat_ms, velocity_multiplier) at time t.

    Before the first red line, osu! uses that first red line's BPM."""
    beat = next((tp.beat_length for tp in tps if not tp.inherited and tp.beat_length > 0), 500.0)
    vel  = 1.0
    for tp in tps:
        if tp.offset > t:
            break
        if not tp.inherited:
            if tp.beat_length > 0:
                beat = tp.beat_length
            vel  = 1.0
        elif tp.beat_length < 0:
            # osu! clamps slider velocity to 0.1x … 10x
            vel = min(10.0, max(0.1, -100.0 / tp.beat_length))
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
        line = raw.strip().lstrip('\ufeff')
        if not line or line.startswith('//'):
            continue
        if section is None and line.startswith('osu file format v'):
            try:
                bm.format_version = int(line[len('osu file format v'):].strip())
            except ValueError:
                pass
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            if section == 'HitObjects':
                # stable sort: a green line on the same ms as a red line wins
                bm.timing_points.sort(key=lambda tp: tp.offset)
            continue

        if section == 'General':
            if line.startswith('AudioFilename:'):
                bm.audio_filename = line[14:].strip()
            elif line.startswith('StackLeniency:'):
                try:
                    bm.stack_leniency = float(line[14:].strip())
                except ValueError:
                    pass

        elif section == 'Metadata':
            if   line.startswith('Title:'):   bm.title   = line[6:].strip()
            elif line.startswith('Artist:'):  bm.artist  = line[7:].strip()
            elif line.startswith('Version:'): bm.version = line[8:].strip()
            elif line.startswith('Creator:'): bm.creator = line[8:].strip()
            elif line.startswith('BeatmapSetID:'):
                try:
                    bm.beatmapset_id = int(line[13:].strip())
                except ValueError:
                    pass

        elif section == 'Events':
            # Background line: 0,0,"bg.jpg",0,0  (or "Background,0,...")
            parts = line.split(',')
            if (not bm.background and len(parts) >= 3
                    and parts[0].strip() in ('0', 'Background')):
                name = parts[2].strip().strip('"')
                if name and not name.lower().endswith(
                        ('.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v')):
                    bm.background = name

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
                # Column 7 ("uninherited") is authoritative; old maps lack it.
                if len(parts) >= 7 and parts[6].strip() in ('0', '1'):
                    inherited = parts[6].strip() == '0'
                else:
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

                    slides = max(1, slides)
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

    bm.hit_objects.sort(key=lambda o: o.time)
    return bm
