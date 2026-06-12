# osu! Replay Viewer

Watch and compare **osu! standard** replays — in your **browser** or in a native **desktop** window.

Drop one or two `.osr` files and press play: **the beatmap is downloaded automatically** from public osu! mirrors (osu.direct / catboy.best), with live score, accuracy, combo, hit judgments, hit-error bar, key overlay and synced music.

---

## 🚀 Quick start (easiest)

### macOS — double-click

| File | What it does |
|------|--------------|
| **`start.command`** | Opens the **web version** in your browser (recommended) |
| **`start-desktop.command`** | Opens the **desktop** (pygame) window |

> First run may take a minute — it creates a Python environment and installs the two dependencies automatically.
> If macOS blocks the file: right-click → **Open** → **Open**.

### Any OS — terminal

```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python main.py --web             # browser version  (http://127.0.0.1:7270)
python main.py                   # desktop version
```

---

## ✨ Features

- **Just drop replays** — the beatmap (`.osz`) is found by MD5 and downloaded automatically, then cached in `~/.osu-replay-viewer/maps`
- **1 or 2 replays** — watch a single play, or compare two cursors **overlaid** or **side-by-side**
- **Skin support** — drop a `.osk` in the project folder and it's used automatically: cursor, hit circles, approach circles, follow circle, combo & slider colours from `skin.ini`
- **Start button** — files load first, playback starts when *you* click ▶
- **Live scoring** — score, combo, accuracy and 100/50/miss counts simulated with osu!-stable hit windows
- **Hit judgments** — 100 / 50 / ✕ popups on the playfield
- **Hit-error bar** — UR-style timing ticks (P1 above, P2 below)
- **Key overlay** — K1/K2/M1/M2 lit from the actual replay inputs
- **Mod support** — HR (flipped + adjusted CS/AR/OD), EZ, DT/NC, HT; mod badges in the HUD
- **Playback speed** — 0.5× → 2× (the web version keeps the music in sync at any speed!)
- **Music & hit sounds** — beatmap audio with volume sliders, hit sounds from real key presses
- **Background image**, skip intro button, click-to-seek progress bar, fullscreen (web), help overlay

---

## 🌐 Web vs 🖥 desktop

| | Web (`--web`) | Desktop |
|---|---|---|
| Runs in | Chrome / Firefox / Edge (local server) | pygame window |
| Music at 0.5×–2× speed | ✅ pitch-corrected | ❌ muted when speed ≠ 1× |
| DT/HT replays | plays at true speed with audio | visual 1× (slow-mo, audio synced) |
| Fullscreen | ✅ | window resize |
| Extra install | nothing | nothing |

Everything (parsing, slider curves, scoring, downloads) runs locally in Python — the browser is only the display. Nothing is uploaded anywhere.

---

## 🎮 Controls

| Key | Action |
|-----|--------|
| `SPACE` | Pause / resume |
| `R` | Restart |
| `S` | Skip intro |
| `TAB` | Overlay ↔ side-by-side (2 replays) |
| `←` `→` | Seek ± 5 s |
| `-` `+` | Playback speed |
| `[` `]` | Music volume (desktop) |
| `,` `.` | Hit-sound volume (desktop) |
| `O` | Browse files (desktop) |
| `C` | Close files / back to menu (desktop) |
| `F` | Fullscreen (web) |
| `H` | Help overlay |
| `ESC` | Quit / back |

Mouse: drag the progress bar to seek, drag the volume sliders, click the speed / view buttons.

---

## 📂 Loading files

Drag & drop anywhere (or use the buttons / `O` key):

| File | Needed? |
|------|---------|
| `.osr` replay | **1 required**, 2nd optional for comparison |
| `.osu` / `.osz` beatmap | optional — **auto-downloaded** if missing |

If the auto-download can't find the map (unranked / very old maps), drop the `.osz` manually.

---

## 🗂 Project structure

```
OsuProjects/
├── main.py               Entry point — desktop loop or --web server
├── start.command         macOS double-click launcher (web)
├── start-desktop.command macOS double-click launcher (desktop)
├── osu-hit-sound.mp3     Hit sound (optional)
├── *.osk                 Your skin (optional — first one found is used)
├── src/
│   ├── beatmap.py        .osu parser (objects, timing, metadata, background)
│   ├── curves.py         Bézier / Catmull / arc slider paths
│   ├── replay.py         .osr parser (osrparse), HR cursor flip
│   ├── scoring.py        Hit detection → score/combo/acc/judgment timeline
│   ├── mods.py           Mod bitmask helpers (HR/EZ/DT/HT windows & stats)
│   ├── mirror.py         Beatmap auto-download (osu.direct, catboy, nerinyan)
│   ├── skin.py           .osk skin loader (cursor, circles, colours)
│   ├── config.py         Colours & constants
│   └── renderer.py       Desktop UI (pygame)
└── web/
    ├── server.py         Local HTTP server + JSON API (stdlib only)
    └── static/           Browser app (canvas renderer)
```

---

## 🔧 Troubleshooting

**`command not found: pip`** — use the launchers (`start.command`) or `python3 -m pip …` inside the venv.

**Map not found online** — only maps that exist on public mirrors can be auto-downloaded; drop the `.osz` yourself otherwise.

**No music in the browser** — click once anywhere (browsers block autoplay), and prefer Chrome/Firefox; Safari can't play `.ogg` audio.

**Replays look misaligned** — make sure both replays are for the same difficulty; a warning is shown if their MD5 differ.

**Scoring isn't exact** — it's a close approximation (no note-lock, slider ticks, or spinner scoring).

---

## License

MIT
