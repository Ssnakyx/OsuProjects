"""JSON views of the core objects, shared by the web server (``web/server.py``)
and the in-browser Pyodide backend (``web/static/webcore.py``).

Keeping these in one place means the two web backends can never drift apart:
whatever the browser receives is built here.
"""
from __future__ import annotations

import hashlib
import math
import os
import shutil
import zipfile
from typing import Dict, List, Optional

from . import mods as mods_mod
from .beatmap import Beatmap, build_combo_info
from .scoring import compute_live_scores

# Default combo-colour count (the frontend owns the actual colours; a skin
# brings its own palette and simply wraps the indices).
N_COMBO_COLORS = 8

VIDEO_EXTS = {'.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v'}


def md5_of(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Files inside an extracted beatmap set
# ---------------------------------------------------------------------------

def find_file_ci(base: str, rel: str) -> Optional[str]:
    """Find *rel* under *base*, ignoring case and slash style.

    .osu files reference their audio / background by name, but mappers are
    sloppy with case ("Audio.MP3" vs "audio.mp3"). macOS doesn't care, Linux
    and the browser's virtual filesystem do — so look it up case-insensitively.
    """
    if not rel:
        return None
    rel = rel.replace("\\", "/").strip().strip('"')
    exact = os.path.join(base, rel)
    if os.path.isfile(exact):
        return exact
    cur = base
    for part in [p for p in rel.split("/") if p]:
        try:
            entries = os.listdir(cur)
        except OSError:
            return None
        match = next((e for e in entries if e.lower() == part.lower()), None)
        if match is None:
            return None
        cur = os.path.join(cur, match)
    return cur if os.path.isfile(cur) else None


def media_paths(bm: Optional[Beatmap], beatmap_path: Optional[str]) -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {"audio": None, "bg": None}
    if not (bm and beatmap_path):
        return out
    base = os.path.dirname(beatmap_path)
    out["audio"] = find_file_ci(base, bm.audio_filename)
    out["bg"] = find_file_ci(base, bm.background)
    return out


def extract_osz(path: str, dest: str) -> List[str]:
    """Extract an .osz (minus videos) into *dest*; returns the .osu paths."""
    if os.path.isdir(dest):
        shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest, exist_ok=True)
    osu_paths: List[str] = []
    root = os.path.realpath(dest)
    with zipfile.ZipFile(path, "r") as zf:
        for info in zf.infolist():
            name = info.filename
            if info.is_dir() or os.path.splitext(name)[1].lower() in VIDEO_EXTS:
                continue
            target = os.path.realpath(os.path.join(dest, name))
            if not target.startswith(root + os.sep):
                continue                      # zip-slip guard
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            if name.lower().endswith(".osu"):
                osu_paths.append(target)
    if not osu_paths:
        shutil.rmtree(dest, ignore_errors=True)
        raise ValueError("No .osu file inside the .osz archive.")
    return sorted(osu_paths)


def beatmap_id_of(path: str) -> int:
    """``BeatmapID`` from an .osu file's [Metadata], or 0 — a cheap header scan
    (no full parse) used to pick a difficulty from a set by its id."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("BeatmapID:"):
                    try:
                        return int(line[10:].strip())
                    except ValueError:
                        return 0
                if line == "[Difficulty]":      # [Metadata] is before it
                    break
    except OSError:
        pass
    return 0


def pick_candidate(candidates: List[str], target_md5: Optional[str],
                   prefer_bid: Optional[int] = None) -> Optional[str]:
    """The difficulty matching the replay's MD5; else (no replay yet, e.g. a
    map loaded from a link) the one with BeatmapID *prefer_bid*; else the
    first one."""
    if not candidates:
        return None
    if target_md5:
        for p in candidates:
            if md5_of(p) == target_md5:
                return p
    if prefer_bid:
        for p in candidates:
            if beatmap_id_of(p) == prefer_bid:
                return p
    return candidates[0]


# ---------------------------------------------------------------------------
# JSON payloads
# ---------------------------------------------------------------------------

def _decimate(pts, max_pts: int = 400, min_step: float = 1.5):
    """Thin a dense slider path: drop points closer than *min_step* osu!px
    to the last kept one (always keeping the ends), capped at *max_pts*."""
    if len(pts) <= 2:
        return list(pts)
    out = [pts[0]]
    for p in pts[1:-1]:
        q = out[-1]
        if math.hypot(p[0] - q[0], p[1] - q[1]) >= min_step:
            out.append(p)
    out.append(pts[-1])
    if len(out) > max_pts:
        step = (len(out) - 1) / (max_pts - 1)
        out = [out[round(k * step)] for k in range(max_pts)]
    return out


def map_json(bm: Beatmap, beatmap_path: str, n_candidates: int,
             target_md5: Optional[str]) -> dict:
    idxs, nums = build_combo_info(bm, N_COMBO_COLORS)
    objs = []
    for i, o in enumerate(bm.hit_objects):
        d = {"t": o.time, "x": o.x, "y": o.y, "ci": idxs[i], "cn": nums[i]}
        if o.is_slider:
            d["k"] = "s"
            d["path"] = [[round(px, 1), round(py, 1)] for px, py in _decimate(o.path)]
            d["slides"] = o.slides
            d["dur"] = round(o.duration, 1)
        elif o.is_spinner:
            d["k"] = "p"
            d["end"] = o.end_time
        else:
            d["k"] = "c"
        objs.append(d)

    md5 = md5_of(beatmap_path) if beatmap_path else ""
    return {
        "title": bm.title, "artist": bm.artist, "version": bm.version,
        "creator": bm.creator, "setId": bm.beatmapset_id,
        "beatmapId": bm.beatmap_id,
        "cs": bm.cs, "ar": bm.ar, "od": bm.od, "hp": bm.hp,
        "stackLeniency": bm.stack_leniency, "formatVersion": bm.format_version,
        "md5": md5,
        "diffCount": n_candidates,
        "md5Match": (not target_md5 or md5 == target_md5),
        "objects": objs,
    }


def replay_json(r, slot: int) -> dict:
    return {
        "slot": slot,
        "player": r.player_name,
        "mods": r.mods,
        "modsStr": mods_mod.mods_string(r.mods),
        "md5": r.beatmap_md5,
        "score": r.score,
        "frames": [[round(f.time, 1), round(f.x, 2), round(f.y, 2), f.keys]
                   for f in r.frames],
    }


def events_json(r, bm: Beatmap, slot: int) -> dict:
    evs = compute_live_scores(r, bm)
    out = []
    for e in evs[1:]:   # skip the -inf sentinel
        out.append([round(e.time, 1), e.score, e.combo, round(e.acc, 2),
                    e.judgment, round(e.x, 1), round(e.y, 1), round(e.dt, 1),
                    e.n300, e.n100, e.n50, e.nmiss, round(e.obj_time, 1)])
    _, _, od = mods_mod.adjusted_difficulty(bm.cs, bm.ar, bm.od, r.mods)
    w300, w100, w50 = mods_mod.hit_windows(od, r.mods)
    return {"slot": slot, "events": out,
            "windows": [round(w300, 1), round(w100, 1), round(w50, 1)]}
