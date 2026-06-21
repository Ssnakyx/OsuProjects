"""In-browser backend glue for the static (Pyodide) build.

Mirrors the per-request helpers in ``web/server.py``, but holds all state in
memory and reads files from Pyodide's virtual filesystem instead of using a
``Session`` + temp files on disk. The desktop and the local ``--web`` server
are unaffected; this module is only imported inside Pyodide.

Every public function returns a JSON *string* (parsed on the JS side) so we
never hand Python objects across the FFI boundary. Media (audio / background)
is handed back as an FS path that JS reads via ``Pyodide.FS.readFile``.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import zipfile

from src import mods as mods_mod
from src.beatmap import load_beatmap, build_combo_info
from src.replay import load_replay
from src.scoring import compute_live_scores

# Combo colour palette count, mirrored in the frontend (no .osk skin on web).
N_COMBO_COLORS = 6
_VIDEO_EXTS = {'.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v'}

WORK = "/work"
os.makedirs(WORK, exist_ok=True)


class _State:
    def __init__(self) -> None:
        self.replays = [None, None]
        self.candidates = []          # candidate .osu paths
        self.beatmap_path = None
        self.beatmap = None
        self.extract_dir = None


ST = _State()


def _md5_of(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def clear() -> str:
    ST.replays = [None, None]
    ST.candidates = []
    ST.beatmap_path = None
    ST.beatmap = None
    if ST.extract_dir and os.path.isdir(ST.extract_dir):
        shutil.rmtree(ST.extract_dir, ignore_errors=True)
    ST.extract_dir = None
    return "{}"


def load_replay_path(path: str, slot_hint: str) -> str:
    if slot_hint in ("0", "1"):
        slot = int(slot_hint)
    elif ST.replays[0] is None:
        slot = 0
    elif ST.replays[1] is None:
        slot = 1
    else:
        slot = 1
    r = load_replay(path)
    ST.replays[slot] = r
    return json.dumps({
        "slot": slot,
        "player": r.player_name,
        "mods": r.mods,
        "modsStr": mods_mod.mods_string(r.mods),
        "md5": r.beatmap_md5,
        "frames": [[round(f.time, 1), round(f.x, 2), round(f.y, 2), f.keys]
                   for f in r.frames],
    })


def _ingest_osz(path: str) -> int:
    new_dir = os.path.join(WORK, "map")
    if os.path.isdir(new_dir):
        shutil.rmtree(new_dir, ignore_errors=True)
    os.makedirs(new_dir)
    osu_paths = []
    with zipfile.ZipFile(path, "r") as zf:
        for name in zf.namelist():
            if os.path.splitext(name)[1].lower() in _VIDEO_EXTS:
                continue
            zf.extract(name, new_dir)
            if name.lower().endswith(".osu"):
                osu_paths.append(os.path.join(new_dir, name))
    if not osu_paths:
        shutil.rmtree(new_dir, ignore_errors=True)
        raise ValueError("No .osu file inside the .osz archive.")
    ST.extract_dir = new_dir
    ST.candidates = osu_paths
    ST.beatmap_path = None
    ST.beatmap = None
    return len(osu_paths)


def ingest_osz_path(path: str) -> str:
    n = _ingest_osz(path)
    _resolve_beatmap()
    return json.dumps({"ok": True, "diffs": n})


def ingest_osu_path(path: str) -> str:
    ST.candidates = [path]
    ST.beatmap_path = None
    ST.beatmap = None
    _resolve_beatmap()
    return json.dumps({"ok": True, "diffs": 1})


def _resolve_beatmap() -> None:
    """Pick the candidate matching replay 1's MD5 (else first) and parse it."""
    if not ST.candidates:
        return
    target = ST.replays[0].beatmap_md5 if ST.replays[0] else None
    pick = None
    if target:
        pick = next((p for p in ST.candidates if _md5_of(p) == target), None)
    pick = pick or ST.candidates[0]
    if pick != ST.beatmap_path or ST.beatmap is None:
        ST.beatmap_path = pick
        ST.beatmap = load_beatmap(pick)


def _media_paths() -> dict:
    out = {"audio": None, "bg": None}
    if not (ST.beatmap and ST.beatmap_path):
        return out
    base = os.path.dirname(ST.beatmap_path)
    if ST.beatmap.audio_filename:
        p = os.path.join(base, ST.beatmap.audio_filename)
        if os.path.isfile(p):
            out["audio"] = p
    if ST.beatmap.background:
        p = os.path.join(base, ST.beatmap.background)
        if os.path.isfile(p):
            out["bg"] = p
    return out


def media_path(kind: str) -> str:
    """FS path for the map's audio / bg, or '' — read back via FS on the JS side."""
    return _media_paths().get(kind) or ""


def map_json() -> str:
    bm = ST.beatmap
    if bm is None:
        raise ValueError("no beatmap loaded")
    idxs, nums = build_combo_info(bm, N_COMBO_COLORS)
    objs = []
    for i, o in enumerate(bm.hit_objects):
        d = {"t": o.time, "x": o.x, "y": o.y, "ci": idxs[i], "cn": nums[i]}
        if o.is_slider:
            pts = o.path
            if len(pts) > 64:
                step = (len(pts) - 1) / 63.0
                pts = [pts[round(k * step)] for k in range(64)]
            d["k"] = "s"
            d["path"] = [[round(px, 1), round(py, 1)] for px, py in pts]
            d["slides"] = o.slides
            d["dur"] = round(o.duration, 1)
        elif o.is_spinner:
            d["k"] = "p"
            d["end"] = o.end_time
        else:
            d["k"] = "c"
        objs.append(d)

    md5 = _md5_of(ST.beatmap_path) if ST.beatmap_path else ""
    target = ST.replays[0].beatmap_md5 if ST.replays[0] else None
    return json.dumps({
        "title": bm.title, "artist": bm.artist, "version": bm.version,
        "creator": bm.creator, "setId": bm.beatmapset_id,
        "cs": bm.cs, "ar": bm.ar, "od": bm.od,
        "diffCount": len(ST.candidates),
        "md5Match": (target is None or md5 == target),
        "objects": objs,
    })


def events_json(slot: int) -> str:
    slot = int(slot)
    r = ST.replays[slot]
    if r is None or ST.beatmap is None:
        raise ValueError("replay or beatmap missing")
    evs = compute_live_scores(r, ST.beatmap)
    out = []
    for e in evs[1:]:   # skip the -inf sentinel
        out.append([round(e.time, 1), e.score, e.combo, round(e.acc, 2),
                    e.judgment, round(e.x, 1), round(e.y, 1), round(e.dt, 1),
                    e.n300, e.n100, e.n50, e.nmiss])
    cs, ar, od = mods_mod.adjusted_difficulty(
        ST.beatmap.cs, ST.beatmap.ar, ST.beatmap.od, r.mods)
    w300, w100, w50 = mods_mod.hit_windows(od, r.mods)
    return json.dumps({"slot": slot, "events": out,
                       "windows": [round(w300, 1), round(w100, 1), round(w50, 1)]})
