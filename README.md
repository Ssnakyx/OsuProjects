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
- **Skin support** — drop any `.osk` on the page (or use the **Skin** button). It's unpacked in your browser, remembered for next time, and works on the online/static version too. Hit circles & numbers, slider balls, follow circles, reverse arrows, follow points, judgments, cursor + trail, spinners and `skin.ini` colours are all used. A `.osk` in the project folder is still picked up by the local server and the desktop app.
- **osu!-accurate playfield** — note stacking, follow points, reverse arrows, Hidden fade-out, HR flip
- **Start button** — files load first, playback starts when *you* click ▶
- **Live scoring** — score, combo, accuracy and 100/50/miss counts simulated with osu!-stable hit windows
- **Hit judgments** — 100 / 50 / ✕ popups on the playfield
- **Hit-error bar** — UR-style timing ticks (P1 above, P2 below)
- **Key overlay** — K1/K2/M1/M2 lit from the actual replay inputs
- **Mod support** — HR (flipped + adjusted CS/AR/OD), EZ, DT/NC, HT; mod badges in the HUD
- **Playback speed** — 0.5× → 2× (the web version keeps the music in sync at any speed!)
- **Music & hit sounds** — beatmap audio with volume sliders, hit sounds from real key presses
- **Background image**, skip intro button, click-to-seek progress bar, fullscreen (web), help overlay

### ✨ New in the web viewer

- **Settings panel** (⚙) — accent themes, background dim/blur, cursor size & trail length, and toggles for the key overlay, hit-error bar, judgments, 300s, approach circles, combo numbers, snaking sliders and more. Everything is saved in your browser.
- **Live stats** (`D`) — unstable rate (UR), full 300/100/50/✕ counts, a hit-error **distribution histogram**, and a rough pp estimate per player.
- **Recent replays** — your last plays are kept locally (IndexedDB) and can be re-watched in one click.
- **Frame stepping** — pause and step one replay frame at a time with `,` / `.`.
- **Animated UI** — neon / glassmorphism theme with an animated background, plus a responsive layout that works on touch devices.

> The pp figure is a rough heuristic for comparison only — it is **not** official osu! pp (that needs the full star-rating algorithm).

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

### 🔗 Loading from a link (web)

Paste into the **link box** on the menu (or press ⌘V / Ctrl+V anywhere on it, or drag a link onto the page):

| You paste | What happens |
|-----------|--------------|
| a beatmap link — `osu.ppy.sh/beatmapsets/1#osu/75`, `/beatmaps/75`, `/b/75`, `/s/1` — or a bare beatmap ID (`75`, `s1` for a set) | the map downloads from the mirrors and that difficulty is selected; then drop the replay |
| a direct link to a `.osr` file | the replay downloads and its map follows automatically (the online version can only read hosts that allow cross-site downloads; the local version has no such limit) |
| a score link — `osu.ppy.sh/scores/…` | see below |

`?link=<anything above>` in the page URL loads it on open, so a viewer link can be shared.

**Score links and their limit.** osu! only gives replay files to a *signed-in* player, and its API needs an OAuth app secret — something a public website can't hold. So:

- **Online version:** the viewer explains this and links the score page; click *Download replay* there and drop the file.
- **Local version (`python main.py --web`):** create a free OAuth app at <https://osu.ppy.sh/home/account/edit> (section *OAuth*, any callback URL) and give its id/secret to the viewer, either as env vars `OSU_CLIENT_ID` / `OSU_CLIENT_SECRET` or in `~/.osu-replay-viewer/osu-api.json` (`{"client_id": 123, "client_secret": "…"}`). The viewer then reads the score to download its beatmap, and tries to fetch the replay; if osu! refuses the replay to an app token, the map is still loaded and you only drop the `.osr`. The secret never leaves your machine.

### ⚡ Faster start (online version)

The online version runs Python in your browser (Pyodide, ~15 MB). It now starts downloading as soon as you reach for a file, shows real progress in the **Engine** line, and is kept in a service-worker cache: on later visits it starts from the cache (nothing downloaded) and warms up in the background before you even drop a file. The last 12 downloaded beatmaps are cached too.

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
│   ├── osuapi.py         Optional osu! API v2 for score links (local server only)
│   ├── webjson.py        JSON for the browser (shared by server.py and Pyodide)
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

**Scoring isn't exact** — it follows osu!stable for circles and slider heads (note lock, early-click misses, stacking) but ignores slider ticks/ends and spinners, so totals are an approximation.

---

## 🧪 Tests

```bash
pip install pytest
python -m pytest tests          # parsing, stacking, scoring, web JSON, link maps
node tests/links.test.mjs       # the web link parser
```

---

## License

MIT
