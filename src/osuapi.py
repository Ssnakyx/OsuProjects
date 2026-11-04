"""Optional osu! API v2 access for score links (local server only).

The official API needs an OAuth application. Anyone can create one for free
at https://osu.ppy.sh/home/account/edit (section "OAuth"); its client id +
secret are read from, in order:

  * env vars ``OSU_CLIENT_ID`` / ``OSU_CLIENT_SECRET``
  * ``~/.osu-replay-viewer/osu-api.json``  →  {"client_id": 123, "client_secret": "…"}

They are **never** sent to the browser, which is why this only exists in the
local server: a public static site cannot hold a secret.

With an app token (client-credentials grant) we can read a score's metadata,
which gives its beatmap, so the map downloads by itself. The ``.osr`` itself
(``/scores/{id}/download``) may be refused for app tokens — osu! ties replay
downloads to a signed-in user. That case is reported as ``ReplayRefused`` so
the caller can still load the map and ask for the file.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional, Tuple

_CONF = os.path.join(os.path.expanduser("~"), ".osu-replay-viewer", "osu-api.json")
_BASE = "https://osu.ppy.sh"
_UA = "osu-replay-viewer/3.0"

_token: Optional[str] = None
_token_exp: float = 0.0


class ApiError(RuntimeError):
    pass


class ReplayRefused(ApiError):
    """The score exists but osu! won't hand its replay to this token."""


def credentials() -> Optional[Tuple[str, str]]:
    cid, sec = os.environ.get("OSU_CLIENT_ID"), os.environ.get("OSU_CLIENT_SECRET")
    if cid and sec:
        return str(cid), str(sec)
    try:
        with open(_CONF, "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("client_id") and d.get("client_secret"):
            return str(d["client_id"]), str(d["client_secret"])
    except (OSError, ValueError, AttributeError):
        pass
    return None


def configured() -> bool:
    return credentials() is not None


def _get_token() -> str:
    global _token, _token_exp
    if _token and time.time() < _token_exp - 60:
        return _token
    cred = credentials()
    if not cred:
        raise ApiError("osu! API not configured.")
    body = json.dumps({
        "client_id": cred[0], "client_secret": cred[1],
        "grant_type": "client_credentials", "scope": "public",
    }).encode()
    req = urllib.request.Request(
        _BASE + "/oauth/token", data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            d = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise ApiError(f"osu! API login failed (HTTP {exc.code}) — check the client id/secret.") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ApiError(f"osu! API unreachable: {exc}") from exc
    _token = d["access_token"]
    _token_exp = time.time() + float(d.get("expires_in", 3600))
    return _token


def _request(path: str) -> bytes:
    req = urllib.request.Request(_BASE + "/api/v2" + path, headers={
        "Authorization": "Bearer " + _get_token(),
        "Accept": "application/json",
        "x-api-version": "20240529",
        "User-Agent": _UA,
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _score_path(score_id: int, ruleset: Optional[str]) -> str:
    sid = int(score_id)
    return f"/scores/{urllib.parse.quote(ruleset)}/{sid}" if ruleset else f"/scores/{sid}"


def score_info(score_id: int, ruleset: Optional[str] = None) -> dict:
    """Score metadata → {beatmapId, setId, md5, player}."""
    try:
        d = json.loads(_request(_score_path(score_id, ruleset)).decode())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ApiError("Score not found on osu!.") from exc
        raise ApiError(f"osu! API error (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise ApiError(f"osu! API unreachable: {exc}") from exc
    bm = d.get("beatmap") or {}
    user = d.get("user") or {}
    return {
        "beatmapId": bm.get("id") or d.get("beatmap_id"),
        "setId": bm.get("beatmapset_id") or (d.get("beatmapset") or {}).get("id"),
        "md5": bm.get("checksum"),
        "player": user.get("username", ""),
        "hasReplay": bool(d.get("has_replay", d.get("replay", True))),
    }


def download_replay(score_id: int, ruleset: Optional[str] = None) -> bytes:
    """The score's .osr bytes; ReplayRefused when osu! says no."""
    try:
        data = _request(_score_path(score_id, ruleset) + "/download")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ReplayRefused("osu! only gives this replay to a signed-in player.") from exc
        if exc.code == 404:
            raise ReplayRefused("This score has no replay available.") from exc
        raise ApiError(f"osu! API error (HTTP {exc.code}).") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError(f"osu! API unreachable: {exc}") from exc
    if len(data) < 100:
        raise ReplayRefused("This score has no replay available.")
    return data
