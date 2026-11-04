"""Automatic beatmap download from public osu! mirrors.

Given a replay's beatmap MD5, looks up the beatmapset and downloads the
.osz — no API key required. Downloads are cached on disk so a map is only
fetched once. Uses only the standard library (urllib).
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Callable, Optional

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".osu-replay-viewer", "maps")

_UA = "osu-replay-viewer/2.0"

_LOOKUP_URLS = [
    "https://osu.direct/api/v2/md5/{md5}",
    "https://catboy.best/api/v2/md5/{md5}",
]

# Beatmap (difficulty) id -> its beatmap JSON, which carries the set id.
_BID_URLS = [
    "https://osu.direct/api/v2/b/{bid}",
    "https://catboy.best/api/v2/b/{bid}",
]

_DOWNLOAD_URLS = [
    "https://osu.direct/api/d/{sid}",
    "https://catboy.best/d/{sid}",
    "https://api.nerinyan.moe/d/{sid}",
]

StatusCb = Optional[Callable[[str], None]]


def _get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _extract_set_id(data) -> Optional[int]:
    """Find a beatmapset id in a mirror's JSON response, whatever its shape."""
    if isinstance(data, dict):
        for key in ("beatmapset_id", "set_id", "setId"):
            v = data.get(key)
            if isinstance(v, int) and v > 0:
                return v
        st = data.get("set") or data.get("beatmapset")
        if isinstance(st, dict):
            v = st.get("id")
            if isinstance(v, int) and v > 0:
                return v
        for v in data.values():
            found = _extract_set_id(v)
            if found:
                return found
    elif isinstance(data, list):
        for v in data:
            found = _extract_set_id(v)
            if found:
                return found
    return None


def _lookup(urls, status: StatusCb) -> Optional[int]:
    for url in urls:
        host = url.split("/")[2]
        if status:
            status(f"Searching beatmap on {host}…")
        try:
            data = json.loads(_get(url).decode("utf-8", "replace"))
        except (urllib.error.URLError, ValueError, OSError):
            continue
        sid = _extract_set_id(data)
        if sid:
            return sid
    return None


def lookup_set_id(md5: str, status: StatusCb = None) -> Optional[int]:
    """Beatmapset id for a beatmap MD5, or None if no mirror knows it."""
    return _lookup([t.format(md5=md5) for t in _LOOKUP_URLS], status)


def lookup_set_id_for_beatmap(beatmap_id: int, status: StatusCb = None) -> Optional[int]:
    """Beatmapset id for a beatmap (difficulty) id, or None."""
    return _lookup([t.format(bid=int(beatmap_id)) for t in _BID_URLS], status)


def download_osz(set_id: int, status: StatusCb = None) -> Optional[str]:
    """Download (or reuse cached) .osz for a beatmapset. Returns local path."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = os.path.join(CACHE_DIR, f"{set_id}.osz")
    if os.path.isfile(dest) and os.path.getsize(dest) > 1024:
        return dest

    for tmpl in _DOWNLOAD_URLS:
        url = tmpl.format(sid=set_id)
        host = url.split("/")[2]
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=40) as resp:
                total = int(resp.headers.get("Content-Length") or 0)
                tmp = dest + ".part"
                done = 0
                with open(tmp, "wb") as f:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                        done += len(chunk)
                        if status and total:
                            pct = 100.0 * done / total
                            status(f"Downloading from {host}… {pct:.0f}%")
                        elif status:
                            status(f"Downloading from {host}… {done // 1024} KB")
            if os.path.getsize(tmp) > 1024:
                os.replace(tmp, dest)
                return dest
            os.remove(tmp)
        except (urllib.error.URLError, OSError):
            continue
    return None


def fetch_osz_for_md5(md5: str, status: StatusCb = None) -> str:
    """Lookup + download in one call. Raises RuntimeError with a readable
    message on failure; returns the local .osz path on success."""
    if not md5:
        raise RuntimeError("Replay has no beatmap hash.")
    sid = lookup_set_id(md5, status)
    if not sid:
        raise RuntimeError("Beatmap not found on mirrors — drop the .osz manually.")
    path = download_osz(sid, status)
    if not path:
        raise RuntimeError("Beatmap download failed — drop the .osz manually.")
    if status:
        status("Download complete.")
    return path


def fetch_osz_for_link(set_id: Optional[int] = None, beatmap_id: Optional[int] = None,
                       status: StatusCb = None) -> str:
    """Download the .osz for a beatmap link (set id and/or difficulty id).
    Raises RuntimeError with a readable message on failure."""
    sid = set_id
    if not sid and beatmap_id:
        sid = lookup_set_id_for_beatmap(beatmap_id, status)
        if not sid:
            raise RuntimeError(f"Beatmap {beatmap_id} not found on mirrors.")
    if not sid:
        raise RuntimeError("No beatmap id in this link.")
    path = download_osz(int(sid), status)
    if not path:
        raise RuntimeError("Beatmap download failed — try again or drop the .osz manually.")
    if status:
        status("Download complete.")
    return path


def fetch_bytes(url: str, max_bytes: int = 32 * 1024 * 1024, timeout: float = 30.0) -> bytes:
    """GET a small file (e.g. an .osr shared by link). https only."""
    if not url.lower().startswith("https://"):
        raise RuntimeError("Only https:// links can be loaded.")
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read(max_bytes + 1)
    except (urllib.error.URLError, OSError) as exc:
        raise RuntimeError(f"Download failed: {exc}") from exc
    if len(data) > max_bytes:
        raise RuntimeError("File too large.")
    return data
