#!/bin/bash
# osu! Replay Viewer — desktop version (double-click me on macOS)
cd "$(dirname "$0")"

PY=python3
command -v python3 >/dev/null 2>&1 || PY=python

if [ ! -d .venv ]; then
    echo "First run — creating Python environment…"
    "$PY" -m venv .venv || { echo "Python 3 is required. Install it from https://www.python.org"; read -r; exit 1; }
fi

.venv/bin/python -m pip install -q -r requirements.txt

echo "Starting osu! Replay Viewer (desktop)…"
.venv/bin/python main.py
