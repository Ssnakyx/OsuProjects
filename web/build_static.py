"""Assemble a static, serverless build of the web viewer into ``web/dist/``.

The browser frontend already runs without the Python HTTP server when no
``/api/*`` backend is present: ``web/static/js/api.js`` boots Pyodide and runs
``webcore.py`` + the ``src/`` core entirely in the page (see the module
docstring there). This script just gathers the files Pyodide needs to fetch
into one folder you can drop on any static host (GitHub Pages, Netlify, an S3
bucket) or even open over ``file://``.

    python web/build_static.py            # → web/dist/
    python web/build_static.py --out site # → ./site/

Layout produced (the page is served at the folder root)::

    dist/
      index.html              ← entry point (relative asset paths)
      static/
        style.css  js/*.js
        webcore.py            ← in-browser backend glue
        src/*.py             ← the shared core Pyodide imports
        osu-hit-sound.mp3
"""
from __future__ import annotations

import argparse
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_SRC = os.path.join(ROOT, "web", "static")

# Core modules webcore.py imports (transitively). Desktop-only modules
# (renderer/config) and server-side ones (mirror/skin) are intentionally left
# out — the static build does its own mirror download in JS and has no skin.
CORE_MODULES = [
    "__init__.py", "mods.py", "curves.py",
    "beatmap.py", "replay.py", "scoring.py",
]


def build(out_dir: str) -> None:
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    static_out = os.path.join(out_dir, "static")
    os.makedirs(static_out)

    # Whole web/static/ tree (index.html, style.css, js/, webcore.py).
    for name in os.listdir(STATIC_SRC):
        src = os.path.join(STATIC_SRC, name)
        dst = os.path.join(static_out, name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)

    # Entry point at the site root, with relative asset paths.
    shutil.copy2(os.path.join(STATIC_SRC, "index.html"),
                 os.path.join(out_dir, "index.html"))

    # The shared core, under static/src/ where api.js fetches it.
    src_out = os.path.join(static_out, "src")
    os.makedirs(src_out, exist_ok=True)
    for mod in CORE_MODULES:
        shutil.copy2(os.path.join(ROOT, "src", mod), os.path.join(src_out, mod))

    # Hit-sound sample (served via /api/hitsound by the live server).
    shutil.copy2(os.path.join(ROOT, "osu-hit-sound.mp3"),
                 os.path.join(static_out, "osu-hit-sound.mp3"))

    print(f"Static build written to {out_dir}/")
    print("Serve it with any static host, e.g.:")
    print(f"    python -m http.server -d {out_dir} 8000")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build the static (Pyodide) web viewer.")
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "dist"),
                    help="output directory (default: web/dist)")
    args = ap.parse_args()
    build(args.out)


if __name__ == "__main__":
    main()
