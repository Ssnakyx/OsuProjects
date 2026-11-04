"""In-browser backend glue for the static (Pyodide) build.

Mirrors the per-request handlers in ``web/server.py``, but holds all state in
memory and reads files from Pyodide's virtual filesystem instead of using a
``Session`` + temp files on disk. The JSON shapes come from
``src/webjson.py``, shared with the server, so both backends stay identical.

Every public function returns a JSON *string* (parsed on the JS side) so we
never hand Python objects across the FFI boundary. Media (audio / background)
is handed back as an FS path that JS reads via ``Pyodide.FS.readFile``.
"""
from __future__ import annotations

import json
import os
import shutil

from src import webjson
from src.beatmap import load_beatmap
from src.replay import load_replay

WORK = "/work"
os.makedirs(WORK, exist_ok=True)


class _State:
    def __init__(self) -> None:
        self.replays = [None, None]
        self.candidates = []          # candidate .osu paths
        self.beatmap_path = None
        self.beatmap = None
        self.extract_dir = None
        self.prefer_bid = None        # difficulty asked for by a link


ST = _State()


def _target_md5():
    for r in ST.replays:
        if r is not None and r.beatmap_md5:
            return r.beatmap_md5
    return None


def _resolve_beatmap() -> None:
    pick = webjson.pick_candidate(ST.candidates, _target_md5(), ST.prefer_bid)
    if pick and (pick != ST.beatmap_path or ST.beatmap is None):
        ST.beatmap_path = pick
        ST.beatmap = load_beatmap(pick)


def clear() -> str:
    ST.replays = [None, None]
    ST.candidates = []
    ST.beatmap_path = None
    ST.beatmap = None
    if ST.extract_dir and os.path.isdir(ST.extract_dir):
        shutil.rmtree(ST.extract_dir, ignore_errors=True)
    ST.extract_dir = None
    ST.prefer_bid = None
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
    ST.replays[slot] = load_replay(path)
    if ST.candidates:
        _resolve_beatmap()
    return json.dumps(webjson.replay_json(ST.replays[slot], slot))


def ingest_osz_path(path: str, prefer_bid=None) -> str:
    """*prefer_bid*: difficulty id from a beatmap link, used until a replay
    tells us the exact difficulty (by MD5)."""
    dest = os.path.join(WORK, "map")
    ST.candidates = webjson.extract_osz(path, dest)
    ST.extract_dir = dest
    ST.prefer_bid = int(prefer_bid) if prefer_bid else None
    ST.beatmap_path = None
    ST.beatmap = None
    _resolve_beatmap()
    return json.dumps({"ok": True, "diffs": len(ST.candidates)})


def ingest_osu_path(path: str) -> str:
    ST.candidates = [path]
    ST.prefer_bid = None
    ST.beatmap_path = None
    ST.beatmap = None
    _resolve_beatmap()
    return json.dumps({"ok": True, "diffs": 1})


def media_path(kind: str) -> str:
    """FS path for the map's audio / bg, or '' — read back via FS on the JS side."""
    return webjson.media_paths(ST.beatmap, ST.beatmap_path).get(kind) or ""


def map_json() -> str:
    _resolve_beatmap()
    if ST.beatmap is None:
        raise ValueError("no beatmap loaded")
    return json.dumps(webjson.map_json(ST.beatmap, ST.beatmap_path,
                                       len(ST.candidates), _target_md5()))


def events_json(slot: int) -> str:
    slot = int(slot)
    r = ST.replays[slot]
    if r is None or ST.beatmap is None:
        raise ValueError("replay or beatmap missing")
    return json.dumps(webjson.events_json(r, ST.beatmap, slot))
