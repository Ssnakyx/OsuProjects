# osu! Replay Viewer

A side-by-side replay comparison tool for **osu! standard** built with Python and pygame.  
Load two `.osr` replay files alongside a beatmap and watch both cursors play simultaneously — with live score, combo, hit sounds, and a clean osu! lazer-inspired UI.


---

## Features

- **Dual replay playback** — overlay both cursors on the same field, or split the screen side-by-side
- **Live score & combo** — simulated in real time using osu!-stable hit windows (300 / 100 / 50 / miss)
- **Combo numbers on hit circles** — each note shows its combo number, fades with the approach circle
- **Hit sounds** — plays `osu-hit-sound.mp3` in sync with the player's actual key presses
- **Background music** — audio from the beatmap's `.osz` or `.osu` folder plays automatically
- **Volume controls** — adjust music and SFX volume independently with keyboard shortcuts
- **Seek & pause** — jump anywhere in the replay, restart instantly
- **osu! lazer UI** — dark theme, pink accent colour, rounded panels, smooth cursor trail

---

## Requirements

| Requirement | Version |
|-------------|---------|
| Python | 3.9 or newer |
| pygame | 2.1.0 or newer |
| osrparse | 6.0.0 or newer |

---

## Installation

### 1 — Clone the repository

```bash
git clone https://github.com/Ssnakyx/OsuProjects.git
cd OsuProject
```

### 2 — Create a virtual environment (recommended)

```bash
python3 -m venv .venv
source .venv/bin/activate      # macOS / Linux
.venv\Scripts\activate         # Windows
```

### 3 — Install dependencies

```bash
pip install -r requirements.txt
```

### 4 — Add a hit sound (optional)

Place an MP3 file named **`osu-hit-sound.mp3`** in the project root (next to `main.py`).  
Any short percussion sound works. If the file is absent the viewer runs silently.

```
OsuProject/
├── main.py
├── osu-hit-sound.mp3   ← put it here
├── requirements.txt
└── src/
```

### 5 — Run

```bash
python3 main.py
```

---

## How to use

### Loading files

Drag and drop files **anywhere** onto the window:

| File | Description |
|------|-------------|
| `.osr` × 2 | The two replay files to compare |
| `.osu` or `.osz` | The beatmap (difficulty file or full map archive) |

Drop them in any order. Playback starts automatically once both replays and the beatmap are loaded.

> **Tip:** If you drag in an `.osz` archive the viewer will extract it automatically and match the correct difficulty using the replay's beatmap MD5 hash.

---

## Controls

| Key | Action |
|-----|--------|
| `SPACE` | Pause / resume |
| `R` | Restart from the beginning |
| `TAB` | Toggle **Overlay** ↔ **Side-by-side** view |
| `← →` | Seek backward / forward 5 seconds |
| `[` `]` | Music volume − / + 10 % |
| `,` `.` | SFX (hit sound) volume − / + 10 % |
| `ESC` | Quit |

---

## Project structure

```
OsuProject/
├── main.py              Entry point — pygame event loop
├── requirements.txt
├── osu-hit-sound.mp3    Hit sound (user-supplied, optional)
└── src/
    ├── beatmap.py       .osu file parser (circles, sliders, spinners, timing)
    ├── config.py        Colour palette, player colours, game constants
    ├── curves.py        Bézier / catmull-rom slider path computation
    ├── renderer.py      All drawing logic and game state (HUD, playfield, cursor)
    ├── replay.py        .osr file parser via osrparse
    └── scoring.py       Real-time hit detection, score & combo simulation
```
test
---

## How the scoring works

`scoring.py` simulates osu! hit detection against the replay data:

1. Extracts every new key press (M1 / M2 / K1 / K2) from the replay frames.
2. For each hit object, finds the closest key press within the OD-based hit window (±win300 / win100 / win50 ms) while the cursor is within `1.5 × circle_radius`.
3. Assigns 300 / 100 / 50 based on ttiming accuracy and accumulates score with the standard combo multiplier.
4. Emits a **miss event** (combo = 0) when no key press is found in the hit window.

The result is a timeline of `(time_ms, cumulative_score, current_combo)` events. The HUD does a binary search into this list every frame to display the current values.

> This is an approximation — it does not replicate osu!'s note-lock, slider tick scoring, or spinner mechanics exactly, but it is close enough for visual comparison.

---

## Troubleshooting

**No audio / hit sounds not playing**  
Make sure `pygame >= 2.1.0` is installed. The hit sound requires `osu-hit-sound.mp3` in the project root. Check the error message shown in the HUD if something goes wrong.

**Wrong difficulty loaded from .osz**  
The viewer matches the replay's beatmap MD5 against the files in the archive. If it cannot find a match it falls back to the first `.osu` file and shows a warning in the HUD..

**Replay loads but cursors look wrong**  
Verify that both `.osr` files are for the same beatmap. A warning is shown in the HUD if the MD5 hashes differ.

**`ModuleNotFoundError: No module named 'osrparse'`**  
Run `pip install -r requirements.txt` inside your virtual environment.

---

## License

MIT
