"""Browser version of the osu! Replay Viewer.

A small standard-library HTTP server: the existing Python parsers do the
heavy lifting (.osr / .osu / .osz parsing, slider paths, scoring) and the
browser renders the result on a canvas. No extra dependencies.

Run with:  python main.py --web
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List, Optional

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src import mirror
from src import osuapi
from src import webjson
from src.beatmap import load_beatmap
from src.replay import load_replay, Replay
from src.skin import find_default_osk

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
    ".py":   "text/plain; charset=utf-8",
    ".osk":  "application/zip",
}


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
        self.prefer_bid: Optional[int] = None   # difficulty asked for by a link
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
            self.prefer_bid = None
            self.status = ""


S = Session()


# ---------------------------------------------------------------------------
# Beatmap handling (JSON shapes live in src/webjson.py, shared with Pyodide)
# ---------------------------------------------------------------------------

def _ingest_osz(path: str) -> int:
    """Extract an .osz, register candidate .osu files. Returns diff count."""
    new_dir = tempfile.mkdtemp(prefix="osu_rv_map_")
    osu_paths = webjson.extract_osz(path, new_dir)
    if S.extract_dir and os.path.isdir(S.extract_dir):
        shutil.rmtree(S.extract_dir, ignore_errors=True)
    S.extract_dir = new_dir
    S.candidates = osu_paths
    S.beatmap_path = None
    S.beatmap = None
    S.prefer_bid = None
    return len(osu_paths)


def _resolve_beatmap() -> None:
    """Pick the candidate matching the replays' MD5 (else first) and parse it."""
    target = _target_md5()
    pick = webjson.pick_candidate(S.candidates, target, S.prefer_bid)
    if pick and (pick != S.beatmap_path or S.beatmap is None):
        S.beatmap_path = pick
        S.beatmap = load_beatmap(pick)


def _target_md5() -> Optional[str]:
    for r in S.replays:
        if r is not None and r.beatmap_md5:
            return r.beatmap_md5
    return None


def _media_paths() -> dict:
    return webjson.media_paths(S.beatmap, S.beatmap_path)


def _map_json() -> dict:
    assert S.beatmap is not None and S.beatmap_path
    d = webjson.map_json(S.beatmap, S.beatmap_path, len(S.candidates), _target_md5())
    media = _media_paths()
    # Cache-bust the media URLs per map: they are served with a long
    # max-age, and the path is constant, so without a unique token the
    # browser would replay the *previous* map's cached audio/background.
    v = d["md5"] or str(int(time.time()))
    d["audio"] = f"/api/media/audio?v={v}" if media["audio"] else None
    d["bg"] = f"/api/media/bg?v={v}" if media["bg"] else None
    return d


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "osu-replay-viewer/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        pass   # keep the console clean

    def handle_one_request(self) -> None:   # noqa: N802
        # Browsers routinely abort in-flight requests (cancelled Range
        # fetches for audio/bg, navigating away). That surfaces here as a
        # reset/broken pipe *before* do_GET/do_POST run, so their own
        # try/except can't catch it. Swallow it to keep the console clean.
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            self.close_connection = True

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
                self._json({"status": S.status, "busy": S.dl_busy,
                            "osuApi": osuapi.configured()})
            elif path == "/api/auto":
                self._auto_download(q.get("md5", [""])[0])
            elif path == "/api/link/map":
                self._link_map(_int(q, "sid"), _int(q, "bid"))
            elif path == "/api/link/osr":
                self._link_osr(q.get("url", [""])[0])
            elif path == "/api/link/score":
                self._link_score(_int(q, "id"), q.get("ruleset", [""])[0] or None)
            elif path == "/api/link/score/osr":
                self._link_score_osr(_int(q, "id"), q.get("ruleset", [""])[0] or None)
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
                    self._json(webjson.events_json(S.replays[slot], S.beatmap, slot))
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
                # The browser unpacks the skin itself (same code as the static
                # build); we only offer the .osk sitting in the project folder.
                osk = find_default_osk(ROOT)
                self._json({"present": bool(osk),
                            "name": os.path.splitext(os.path.basename(osk))[0] if osk else "",
                            "url": "/api/skin/osk" if osk else None})
            elif path == "/api/skin/osk":
                osk = find_default_osk(ROOT)
                if osk:
                    self._file(osk, cache=False)
                else:
                    self._error("no skin", 404)
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
        self._download_map(lambda: mirror.fetch_osz_for_md5(md5, S.set_status))

    def _link_map(self, sid: Optional[int], bid: Optional[int]) -> None:
        if not (sid or bid):
            self._error("missing beatmap id")
            return
        self._download_map(lambda: mirror.fetch_osz_for_link(sid, bid, S.set_status),
                           prefer_bid=bid)

    def _bytes(self, data: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _link_osr(self, url: str) -> None:
        # Server-side fetch: sidesteps CORS on hosts that share .osr files.
        try:
            self._bytes(mirror.fetch_bytes(url))
        except RuntimeError as exc:
            self._error(str(exc), 502)

    def _link_score(self, score_id: Optional[int], ruleset: Optional[str]) -> None:
        if not score_id:
            self._error("missing score id")
            return
        if not osuapi.configured():
            self._error("osu! API not configured", 501)
            return
        try:
            self._json(osuapi.score_info(score_id, ruleset))
        except osuapi.ApiError as exc:
            self._error(str(exc), 502)

    def _link_score_osr(self, score_id: Optional[int], ruleset: Optional[str]) -> None:
        if not score_id or not osuapi.configured():
            self._error("osu! API not configured", 501)
            return
        try:
            self._bytes(osuapi.download_replay(score_id, ruleset))
        except osuapi.ReplayRefused as exc:
            self._error(str(exc), 403)
        except osuapi.ApiError as exc:
            self._error(str(exc), 502)

    def _download_map(self, fetch, prefer_bid: Optional[int] = None) -> None:
        if S.dl_busy:
            self._json({"busy": True}, 409)
            return
        S.dl_busy = True
        try:
            osz = fetch()
            with S.lock:
                n = _ingest_osz(osz)
                S.prefer_bid = prefer_bid
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
                    if S.candidates:
                        _resolve_beatmap()
                    self._json(webjson.replay_json(S.replays[slot], slot))
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
                        S.prefer_bid = None
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

def _int(q: dict, key: str) -> Optional[int]:
    try:
        v = int(q.get(key, [""])[0])
        return v if v > 0 else None
    except ValueError:
        return None


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
