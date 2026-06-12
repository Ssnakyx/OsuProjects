"""osu! skin (.osk) support.

Loads the first .osk found in the project root, extracts only the gameplay
elements we render, and parses the relevant skin.ini values. Extraction is
cached in ~/.osu-replay-viewer/skins/<key>/ so it happens once.

An element whose image is a 1×1 placeholder (skins hide things that way)
is treated as absent so the renderer falls back to its vector style.
"""
from __future__ import annotations

import os
import re
import struct
import zipfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

CACHE_ROOT = os.path.join(os.path.expanduser("~"), ".osu-replay-viewer", "skins")

# Logical element names we can render (without extension / @2x suffix)
ELEMENTS = [
    "cursor", "cursormiddle", "cursortrail",
    "hitcircle", "hitcircleoverlay", "approachcircle",
    "sliderb0", "sliderball", "sliderfollowcircle", "reversearrow",
    "hit0", "hit50", "hit100", "hit300",
]

Color = Tuple[int, int, int]


@dataclass
class Skin:
    name: str = "skin"
    path: str = ""                                   # extraction dir
    elements: Dict[str, str] = field(default_factory=dict)   # name -> abs path
    scales:   Dict[str, int] = field(default_factory=dict)   # name -> 1 | 2
    sizes:    Dict[str, Tuple[int, int]] = field(default_factory=dict)
    combo_colors: List[Color] = field(default_factory=list)
    slider_border: Optional[Color] = None
    slider_track:  Optional[Color] = None

    def has(self, name: str) -> bool:
        return name in self.elements


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if len(data) > 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", data[16:24])
    return None


def _parse_color(value: str) -> Optional[Color]:
    nums = re.findall(r"\d+", value.split("//")[0])
    if len(nums) >= 3:
        return (min(255, int(nums[0])), min(255, int(nums[1])), min(255, int(nums[2])))
    return None


def _parse_ini(text: str) -> dict:
    out: dict = {"combo": {}, "slider_border": None, "slider_track": None, "name": ""}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("//") or ":" not in line:
            continue
        key, val = (s.strip() for s in line.split(":", 1))
        kl = key.lower()
        if kl == "name" and not out["name"]:
            out["name"] = val
        elif re.fullmatch(r"combo[1-8]", kl):
            c = _parse_color(val)
            if c:
                out["combo"][int(kl[5])] = c
        elif kl == "sliderborder":
            out["slider_border"] = out["slider_border"] or _parse_color(val)
        elif kl == "slidertrackoverride":
            out["slider_track"] = out["slider_track"] or _parse_color(val)
    return out


def find_default_osk(root: str) -> Optional[str]:
    try:
        osks = sorted(f for f in os.listdir(root) if f.lower().endswith(".osk"))
    except OSError:
        return None
    return os.path.join(root, osks[0]) if osks else None


def load_skin(osk_path: str) -> Optional[Skin]:
    try:
        st = os.stat(osk_path)
        key = f"{st.st_size}_{int(st.st_mtime)}"
        dest = os.path.join(CACHE_ROOT, key)
        marker = os.path.join(dest, ".done")
        if not os.path.isfile(marker):
            _extract(osk_path, dest)
            open(marker, "w").close()
        return _build(dest)
    except Exception:
        return None


def _extract(osk_path: str, dest: str) -> None:
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(osk_path, "r") as zf:
        names = zf.namelist()
        lower = {n.lower(): n for n in names}

        # The skin root is wherever skin.ini lives (usually the archive root)
        ini_key = None
        for cand in sorted(lower, key=lambda n: n.count("/")):
            if cand.endswith("skin.ini"):
                ini_key = cand
                break
        prefix = ini_key[: -len("skin.ini")] if ini_key else ""

        def grab(rel: str, out_name: str) -> bool:
            actual = lower.get((prefix + rel).lower())
            if not actual:
                return False
            data = zf.read(actual)
            with open(os.path.join(dest, out_name), "wb") as f:
                f.write(data)
            return True

        if ini_key:
            grab("skin.ini", "skin.ini")
        for el in ELEMENTS:
            grab(f"{el}@2x.png", f"{el}@2x.png")
            grab(f"{el}.png", f"{el}.png")


def _build(dest: str) -> Skin:
    sk = Skin(path=dest)

    ini_path = os.path.join(dest, "skin.ini")
    if os.path.isfile(ini_path):
        with open(ini_path, encoding="utf-8", errors="replace") as f:
            ini = _parse_ini(f.read())
        sk.name = ini["name"] or "skin"
        sk.combo_colors = [ini["combo"][k] for k in sorted(ini["combo"])]
        sk.slider_border = ini["slider_border"]
        sk.slider_track = ini["slider_track"]

    for el in ELEMENTS:
        for suffix, scale in (("@2x.png", 2), (".png", 1)):
            p = os.path.join(dest, el + suffix)
            if not os.path.isfile(p):
                continue
            with open(p, "rb") as f:
                size = _png_size(f.read(64))
            if size and (size[0] <= 2 or size[1] <= 2):
                continue           # 1×1 placeholder → element hidden by skin
            sk.elements[el] = p
            sk.scales[el] = scale
            if size:
                sk.sizes[el] = size
            break

    return sk


def load_default(root: str) -> Optional[Skin]:
    osk = find_default_osk(root)
    return load_skin(osk) if osk else None
