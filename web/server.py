"""Browser version of the osu! Replay Viewer.

A small standard-library HTTP server: the existing Python parsers do the
heavy lifting (.osr / .osu / .osz parsing, slider paths, scoring) and the
browser renders the result on a canvas. No extra dependencies.

Run with:  python main.py --web
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src import mirror
from src import mods as mods_mod
from src import skin as skin_mod
from src.beatmap import load_beatmap, build_combo_info
from src.replay import load_replay, Replay
from src.scoring import compute_live_scores

SKIN = skin_mod.load_default(ROOT)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

_VIDEO_EXTS = {'.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v'}
_CTYPES = {
    ".html": "text/html; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".mp3":  "audio/mpeg",
    ".ogg":  "audio/ogg",
    ".wav":  "audio/wav",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
}

# Combo colour palette mirrored in the frontend
N_COMBO_COLORS = 6


class Session:
    """Single local user — one shared session, guarded by a lock."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.tmp = tempfile.mkdtemp(prefix="osu_rv_web_")
        self.replays: List[Optional[Replay]] = [None, None]
        self.replay_paths: List[Optional[str]] = [None, None]
        self.candidates: List[str] = []      # candidate .osu paths
        self.beatmap_path: Optional[str] = None
        self.beatmap = None
        self.extract_dir: Optional[str] = None
        self.status: str = ""
        self.dl_busy = False

    def set_status(self, msg: str) -> None:
        self.status = msg

    def clear(self) -> None:
        with self.lock:
            self.replays = [None, None]
            self.replay_paths = [None, None]
            self.candidates = []
            self.beatmap_path = None
            self.beatmap = None
            if self.extract_dir and os.path.isdir(self.extract_dir):
                shutil.rmtree(self.extract_dir, ignore_errors=True)
            self.extract_dir = None
            self.status = ""


S = Session()


# ---------------------------------------------------------------------------
# Beatmap handling
# ---------------------------------------------------------------------------

def _md5_of(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def _ingest_osz(path: str) -> int:
    """Extract an .osz, register candidate .osu files. Returns diff count."""
    new_dir = tempfile.mkdtemp(prefix="osu_rv_map_")
    osu_paths: List[str] = []
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
    if S.extract_dir and os.path.isdir(S.extract_dir):
        shutil.rmtree(S.extract_dir, ignore_errors=True)
    S.extract_dir = new_dir
    S.candidates = osu_paths
    S.beatmap_path = None
    S.beatmap = None
    return len(osu_paths)


def _resolve_beatmap() -> None:
    """Pick the candidate matching replay 1's MD5 (else first) and parse it."""
    if not S.candidates:
        return
    target = S.replays[0].beatmap_md5 if S.replays[0] else None
    pick = None
    if target:
        pick = next((p for p in S.candidates if _md5_of(p) == target), None)
    pick = pick or S.candidates[0]
    if pick != S.beatmap_path or S.beatmap is None:
        S.beatmap_path = pick
        S.beatmap = load_beatmap(pick)


def _media_paths() -> dict:
    out = {"audio": None, "bg": None}
    if not (S.beatmap and S.beatmap_path):
        return out
    base = os.path.dirname(S.beatmap_path)
    if S.beatmap.audio_filename:
        p = os.path.join(base, S.beatmap.audio_filename)
        if os.path.isfile(p):
            out["audio"] = p
    if S.beatmap.background:
        p = os.path.join(base, S.beatmap.background)
        if os.path.isfile(p):
            out["bg"] = p
    return out


def _map_json() -> dict:
    bm = S.beatmap
    assert bm is not None
    n_colors = (len(SKIN.combo_colors)
                if SKIN and SKIN.combo_colors else N_COMBO_COLORS)
    idxs, nums = build_combo_info(bm, n_colors)
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

    media = _media_paths()
    md5 = _md5_of(S.beatmap_path) if S.beatmap_path else ""
    target = S.replays[0].beatmap_md5 if S.replays[0] else None
    # Cache-bust the media URLs per map: they are served with a long
    # max-age, and the path is constant, so without a unique token the
    # browser would replay the *previous* map's cached audio/background.
    v = md5 or str(int(time.time()))
    return {
        "title": bm.title, "artist": bm.artist, "version": bm.version,
        "creator": bm.creator, "setId": bm.beatmapset_id,
        "cs": bm.cs, "ar": bm.ar, "od": bm.od,
        "audio": (f"/api/media/audio?v={v}" if media["audio"] else None),
        "bg": (f"/api/media/bg?v={v}" if media["bg"] else None),
        "diffCount": len(S.candidates),
        "md5Match": (target is None or md5 == target),
        "objects": objs,
    }


def _replay_json(slot: int) -> dict:
    r = S.replays[slot]
    assert r is not None
    return {
        "slot": slot,
        "player": r.player_name,
        "mods": r.mods,
        "modsStr": mods_mod.mods_string(r.mods),
        "md5": r.beatmap_md5,
        "frames": [[round(f.time, 1), round(f.x, 2), round(f.y, 2), f.keys]
                   for f in r.frames],
    }


def _events_json(slot: int) -> dict:
    r = S.replays[slot]
    if r is None or S.beatmap is None:
        raise ValueError("replay or beatmap missing")
    evs = compute_live_scores(r, S.beatmap)
    out = []
    for e in evs[1:]:   # skip the -inf sentinel
        out.append([round(e.time, 1), e.score, e.combo, round(e.acc, 2),
                    e.judgment, round(e.x, 1), round(e.y, 1), round(e.dt, 1),
                    e.n300, e.n100, e.n50, e.nmiss])
    cs, ar, od = mods_mod.adjusted_difficulty(
        S.beatmap.cs, S.beatmap.ar, S.beatmap.od, r.mods)
    w300, w100, w50 = mods_mod.hit_windows(od, r.mods)
    return {"slot": slot, "events": out,
            "windows": [round(w300, 1), round(w100, 1), round(w50, 1)]}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "osu-replay-viewer/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        pass   # keep the console clean

    # ---- helpers ----

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg: str, code: int = 400) -> None:
        self._json({"error": msg}, code)

    def _file(self, path: str, cache: bool = False) -> None:
        if not os.path.isfile(path):
            self._error("not found", 404)
            return
        ctype = _CTYPES.get(os.path.splitext(path)[1].lower(),
                            "application/octet-stream")
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        partial = False
        if rng and rng.startswith("bytes="):
            try:
                spec = rng[6:].split(",")[0].strip()
                s, _, e = spec.partition("-")
                if s:
                    start = int(s)
                    end = int(e) if e else size - 1
                elif e:                      # suffix range: last N bytes
                    start = max(0, size - int(e))
                end = min(end, size - 1)
                partial = start > 0 or end < size - 1
            except ValueError:
                start, end, partial = 0, size - 1, False
        if start >= size:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if cache:
            self.send_header("Cache-Control", "max-age=3600")
        else:
            # App files (HTML/CSS/JS) must never be served stale — without an
            # explicit directive browsers heuristic-cache them, so a redesign
            # shows up half-applied (mixed old CSS + new HTML).
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 256 * 1024 * 1024:
            raise ValueError("bad content length")
        return self.rfile.read(length)

    # ---- GET ----

    def do_GET(self) -> None:   # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            path = url.path

            if path == "/":
                self._file(os.path.join(STATIC_DIR, "index.html"))
            elif path.startswith("/static/"):
                name = os.path.normpath(path[len("/static/"):])
                if name.startswith(("..", "/")):
                    self._error("forbidden", 403)
                    return
                self._file(os.path.join(STATIC_DIR, name), cache=False)
            elif path == "/api/status":
                self._json({"status": S.status, "busy": S.dl_busy})
            elif path == "/api/auto":
                self._auto_download(q.get("md5", [""])[0])
            elif path == "/api/map":
                with S.lock:
                    if not S.candidates:
                        self._error("no beatmap loaded", 404)
                        return
                    _resolve_beatmap()
                    self._json(_map_json())
            elif path == "/api/events":
                slot = int(q.get("slot", ["0"])[0])
                with S.lock:
                    if not (0 <= slot < 2) or S.replays[slot] is None:
                        self._error("no replay in slot", 404)
                        return
                    if S.beatmap is None:
                        _resolve_beatmap()
                    if S.beatmap is None:
                        self._error("no beatmap loaded", 404)
                        return
                    self._json(_events_json(slot))
            elif path == "/api/media/audio":
                p = _media_paths()["audio"]
                if p:
                    self._file(p, cache=True)
                else:
                    self._error("no audio", 404)
            elif path == "/api/media/bg":
                p = _media_paths()["bg"]
                if p:
                    self._file(p, cache=True)
                else:
                    self._error("no background", 404)
            elif path == "/api/hitsound":
                self._file(os.path.join(ROOT, "osu-hit-sound.mp3"), cache=True)
            elif path == "/api/skin":
                if SKIN is None:
                    self._json({"present": False})
                else:
                    self._json({
                        "present": True,
                        "name": SKIN.name,
                        "comboColors": SKIN.combo_colors,
                        "sliderBorder": SKIN.slider_border,
                        "sliderTrack": SKIN.slider_track,
                        "elements": {
                            name: {
                                "url": f"/api/skin/el/{name}",
                                "scale": SKIN.scales.get(name, 1),
                                "w": SKIN.sizes.get(name, (0, 0))[0],
                                "h": SKIN.sizes.get(name, (0, 0))[1],
                            }
                            for name in SKIN.elements
                        },
                    })
            elif path.startswith("/api/skin/el/"):
                name = path[len("/api/skin/el/"):]
                if SKIN and name in SKIN.elements:
                    self._file(SKIN.elements[name], cache=True)
                else:
                    self._error("no such element", 404)
            else:
                self._error("not found", 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._error(f"server error: {exc}", 500)
            except Exception:
                pass

    def _auto_download(self, md5: str) -> None:
        if not md5:
            self._error("missing md5")
            return
        if S.dl_busy:
            self._json({"busy": True}, 409)
            return
        S.dl_busy = True
        try:
            osz = mirror.fetch_osz_for_md5(md5, S.set_status)
            with S.lock:
                n = _ingest_osz(osz)
                _resolve_beatmap()
            S.set_status("")
            self._json({"ok": True, "diffs": n})
        except Exception as exc:
            S.set_status("")
            self._error(str(exc), 502)
        finally:
            S.dl_busy = False

    # ---- POST ----

    def do_POST(self) -> None:   # noqa: N802
        try:
            url = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(url.query)
            path = url.path

            if path == "/api/replay":
                data = self._body()
                slot_q = q.get("slot", ["auto"])[0]
                with S.lock:
                    if slot_q in ("0", "1"):
                        slot = int(slot_q)
                    elif S.replays[0] is None:
                        slot = 0
                    elif S.replays[1] is None:
                        slot = 1
                    else:
                        slot = 1
                    tmp_path = os.path.join(S.tmp, f"replay{slot}.osr")
                    with open(tmp_path, "wb") as f:
                        f.write(data)
                    S.replays[slot] = load_replay(tmp_path)
                    S.replay_paths[slot] = tmp_path
                    self._json(_replay_json(slot))
            elif path == "/api/mapfile":
                data = self._body()
                name = self.headers.get("X-Filename", "map.osz")
                ext = os.path.splitext(name)[1].lower()
                with S.lock:
                    if ext == ".osu":
                        p = os.path.join(S.tmp, "uploaded.osu")
                        with open(p, "wb") as f:
                            f.write(data)
                        S.candidates = [p]
                        S.beatmap_path = None
                        S.beatmap = None
                        n = 1
                    elif ext == ".osz":
                        p = os.path.join(S.tmp, "uploaded.osz")
                        with open(p, "wb") as f:
                            f.write(data)
                        n = _ingest_osz(p)
                    else:
                        self._error(f"unsupported file type: {ext}")
                        return
                    _resolve_beatmap()
                    self._json({"ok": True, "diffs": n})
            elif path == "/api/clear":
                S.clear()
                self._json({"ok": True})
            else:
                self._error("not found", 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            try:
                self._error(f"server error: {exc}", 500)
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _lan_ip() -> str:
    """Best-effort guess of this machine's LAN IP address."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't actually send anything; just picks the outbound interface.
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def run_server(port: int = 7270, open_browser: bool = True,
               host: str = "127.0.0.1") -> None:
    httpd = ThreadingHTTPServer((host, port), Handler)
    local_url = f"http://127.0.0.1:{port}"
    print()
    print("  osu! Replay Viewer — web mode")
    print(f"  Open  {local_url}  in your browser")
    if host not in ("127.0.0.1", "localhost"):
        lan_url = f"http://{_lan_ip()}:{port}"
        print(f"  From another device on this Wi-Fi:  {lan_url}")
    print("  Press Ctrl+C to stop.")
    print()
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(local_url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Bye!")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    run_server()
