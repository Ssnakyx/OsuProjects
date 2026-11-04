# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **osu! standard replay viewer**. Drop one or two `.osr` replays; the matching beatmap is auto-downloaded from public mirrors, then the replay is rendered with live scoring. It ships in two forms that share one Python core:

- **Desktop** — a pygame window (`python main.py`)
- **Web** — a stdlib HTTP server + browser canvas (`python main.py --web`, default http://127.0.0.1:7270)
- **Static web** — the same browser frontend with no server: the Python core runs in-browser via Pyodide. Build with `python web/build_static.py` → `web/dist/`, host anywhere static.

## Commands

```bash
# Setup (Python 3.9-era venv already present as .venv)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # pygame, osrparse only

python main.py                           # desktop (pygame)
python main.py --web                     # browser version
python main.py --web --port 8080 --no-browser

python web/build_static.py               # assemble serverless build → web/dist/
python -m http.server -d web/dist 8000   # ...then host it anywhere static

# macOS double-click launchers (create the venv + install on first run)
./start.command            # web
./start-desktop.command    # desktop

# Regenerate test fixtures (a synthetic .osu + two .osr that play it)
python tests/make_fixtures.py [outdir]   # defaults to tests/fixtures/
```

`python -m pytest tests` runs the core test suite (`tests/test_core.py`: parsing, stacking, note lock, web JSON). `tests/make_fixtures.py` generates the synthetic map + replays it uses. There is no linter; for UI changes also run the app against a real or fixture replay.

## Architecture

The pipeline is the same regardless of frontend: **parse `.osr` + `.osu` → simulate scoring → render**. All parsing, slider geometry, scoring, and downloading run locally in Python; the browser is purely a display (nothing is uploaded).

### `src/` — shared core (no pygame/web dependency)

- **`replay.py`** — parses `.osr` via `osrparse` into `Replay` (frames of `time, x, y, keys`). Critically: **HR replays are un-flipped vertically here** (`y = 384 - y`) so every replay aligns with the unflipped beatmap the renderers draw. `cursor_at` / `keys_at` do binary-search lookups by time.
- **`beatmap.py`** — hand-written `.osu` parser → `Beatmap` with `HitObject` subclasses (`Circle`/`Slider`/`Spinner`). Slider `duration` is derived from timing points + slider multiplier; slider `path` is precomputed via `curves.py`. AR→`preempt`/`fade_in` and CS→`circle_radius` are properties here. `build_combo_info` assigns per-object combo colour index + number from new-combo flags.
- **`curves.py`** — slider path sampling: Bézier (`B`), Catmull (`C`), perfect-circle arc (`P`), linear (`L`), clamped to the slider's `length`.
- **`scoring.py`** — `compute_live_scores(replay, beatmap)` simulates hit detection and returns a **cumulative timeline** of `ScoreEvent`s (score, combo, acc, judgment, hit-error `dt`, running 300/100/50/miss counts). The list starts with a `-inf` sentinel. `state_at` / `score_at` / `recent_events` do binary-search timeline lookups for the renderers. **Approximation only**: spinners ignored, sliders judged on the head, no note-lock/slider-ticks.
- **`mods.py`** — mod bitmask helpers shared everywhere: `clock_rate` (DT/NC 1.5×, HT 0.75×), `adjusted_difficulty` (HR/EZ scaling of CS/AR/OD), `hit_windows`, `mods_string`.
- **`mirror.py`** — auto-download: replay MD5 → beatmapset id (osu.direct / catboy.best) → `.osz` (those + nerinyan). Cached at `~/.osu-replay-viewer/maps/<setid>.osz`. Stdlib `urllib` only, no API key.
- **`webjson.py`** — the JSON shapes the browser receives (map / replay / events), `.osz` extraction (zip-slip safe) and case-insensitive media lookup. Used by both `web/server.py` and `web/static/webcore.py`, so the two web backends cannot drift.
- **Stacking** — `beatmap.compute_stack_heights` (osu!lazer's v6+ algorithm) + `stack_offset`. Scoring computes stacks per replay (its own AR/CS/HR); the web renderer ports the same algorithm in `render.js`; the desktop shifts objects in place after scoring.
- **`skin.py`** — (desktop only) loads the first `.osk` in the project root, extracts only the gameplay sprites we render + relevant `skin.ini` values, caches under `~/.osu-replay-viewer/skins/`. A 1×1 placeholder image is treated as *absent* (renderer falls back to vector drawing).
- **`config.py`** — colours, sizes, `SPEEDS`, timing constants for the desktop renderer.

### Frontends

- **`src/renderer.py`** (~1700 lines) — the entire desktop UI: pygame draw loop, file drop/dialog handling, HUD, hit-error bar, key overlay, sliders, seeking, volume, speed, help overlay. `main.py` owns the event loop and dispatches keys/mouse to `Renderer` methods.
- **`web/server.py`** — `ThreadingHTTPServer` with a single shared `Session` (one local user, guarded by a lock). Serves `web/static/` and a JSON API: `/api/replay` (POST), `/api/mapfile` (POST), `/api/auto` (download by md5), `/api/map`, `/api/events?slot=`, `/api/media/{audio,bg}`, `/api/skin`. `_map_json`/`_events_json` convert the Python core's objects into compact JSON; media is streamed with HTTP Range support.
- **`web/static/`** — `index.html`, `style.css`, and `js/` — the browser frontend split into ES modules (no build step; the server sends `.js` as `application/javascript`). `js/main.js` is the entry point (loaded via `<script type="module">`) and wires up the DOM + boots. The rest: `config.js` (constants/defaults), `core.js` (helpers, lookups, difficulty maths, shared `S` state, `OPT` settings, toast/chip), `skin.js`, `render.js` (canvas drawing), `stats.js` (UR/pp/histogram/HUD), `playback.js` (transport + `tick` loop), `session.js` (file intake + enter/leave player), `recent.js` (IndexedDB), `settings.js` (settings UI + particles), `screens.js` (patch notes + results). Imports use live ES-module bindings; the `session ↔ recent` cycle is safe because cross-references only fire inside functions at runtime. Asset paths in `index.html` are **relative** (`static/…`) so the page works at any deploy sub-path, not just `/`.
- **`web/static/js/api.js`** — the single backend seam. The rest of the frontend never calls `fetch("/api/…")` directly; it goes through `api.*` (`postReplay`, `uploadMap`, `getMap`, `getEvents`, `autoDownload`, `clear`, `getHitsound`, `getSkin`). The mode is auto-detected once by probing `/api/status`: **server mode** = thin wrappers over `/api/*`; **static mode** (no server) boots Pyodide lazily on first file drop and routes to `webcore.py`. In static mode auto-download is ported to JS (`mirrorDownload`, mirrors `mirror.py`) since Pyodide can't do cross-origin urllib; on CORS failure it surfaces "drop the .osz manually". Skins are handled entirely in JS (`skin.js`): a tiny zip reader (DecompressionStream), `skin.ini` parser, @2x / animated frames / 1×1-hidden detection, persisted in IndexedDB (`orv-skin`). In server mode `/api/skin/osk` additionally serves the project-folder `.osk` as a default.
- **`web/static/webcore.py`** — in-browser backend for static mode, mirroring `server.py`'s per-request helpers but holding state in memory (`ST`) and reading from Pyodide's FS instead of a `Session` + temp files. Every public fn returns a JSON **string**; media is handed back as an FS path (`media_path`) that `api.js` reads into a Blob URL — so `map_json()` here, unlike `_map_json` in server.py, omits the `audio`/`bg` URLs.
- **`web/build_static.py`** — assembles `web/dist/`: the `web/static/` tree + the core `src/*.py` Pyodide imports + `osu-hit-sound.mp3`, with `index.html` at the root. `web/dist/` is gitignored.

## Conventions and gotchas

- **Coordinate system**: osu! playfield is **512×384** (`config.OSU_WIDTH/HEIGHT`); both renderers scale/letterbox this into their viewport. All hit-object and cursor coords are in this space.
- **Time is song-file time** everywhere (replay frames, hit objects, score events). Under DT/HT the *real-time* hit windows are scaled by `clock_rate` so comparisons happen in file-time (see `mods.hit_windows`). The desktop player runs DT/HT visually at 1× (slow-mo, audio synced); the web player plays true speed with pitch-corrected audio.
- **Two replays**: slot 0 / slot 1. They should share the same beatmap MD5 — a mismatch is surfaced as a warning (`md5Match` in the web API).
- Anything shared between desktop and web belongs in `src/` (keep it pygame-free); frontend-specific logic stays in `renderer.py` or `web/`.
- `.osk` skins and `tests/fixtures/` are gitignored (skins are large — drop your own `.osk` in the project root locally).
