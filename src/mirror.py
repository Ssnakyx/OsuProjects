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

_UA = "osu-replay-viewer/2.0 (+https://github.com/Ssnakyx/OsuProjects)"

_LOOKUP_URLS = [
    "https://osu.direct/api/v2/md5/{md5}",
    "https://catboy.best/api/v2/md5/{md5}",
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


def lookup_set_id(md5: str, status: StatusCb = None) -> Optional[int]:
    """Beatmapset id for a beatmap MD5, or None if no mirror knows it."""
    for tmpl in _LOOKUP_URLS:
        url = tmpl.format(md5=md5)
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
