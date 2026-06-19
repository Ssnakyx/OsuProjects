from __future__ import annotations

import bisect
import hashlib
import math
import os
import queue
import tempfile
import threading
import zipfile
from typing import Dict, List, Optional, Tuple

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

import pygame

from . import config
from . import mirror
from . import mods as mods_mod
from . import skin as skin_mod
from .beatmap  import load_beatmap, Beatmap, Circle, Slider, Spinner, build_combo_info
from .replay   import load_replay, Replay, cursor_at, keys_at
from .curves   import path_at_t
from .scoring  import (ScoreEvent, compute_live_scores, state_at,
                       recent_events)

Rect = Tuple[int, int, int, int]   # x, y, w, h

_VIDEO_EXTS = {'.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v'}
_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.bmp'}


# ---------------------------------------------------------------------------
# Surface helpers
# ---------------------------------------------------------------------------

def _alpha_surface(w: int, h: int) -> pygame.Surface:
    s = pygame.Surface((w, h), pygame.SRCALPHA)
    s.fill((0, 0, 0, 0))
    return s


def _tinted(color: Tuple[int, int, int], factor: float) -> Tuple[int, int, int]:
    return (int(color[0] * factor), int(color[1] * factor), int(color[2] * factor))


def _rounded_box(
    surf: pygame.Surface,
    rect: Tuple[int, int, int, int],
    color: Tuple[int, int, int, int],
    radius: int = 10,
) -> None:
    x, y, w, h = rect
    if w <= 0 or h <= 0:
        return
    tmp = _alpha_surface(w, h)
    pygame.draw.rect(tmp, color, (0, 0, w, h), border_radius=radius)
    surf.blit(tmp, (x, y))


def _dashed_rect(
    surf: pygame.Surface, rect: Rect,
    color: Tuple[int, int, int], dash: int = 9, gap: int = 7, width: int = 2,
    radius: int = 14,
) -> None:
    """Approximate dashed rounded rectangle (dashes on straight edges)."""
    x, y, w, h = rect
    for sx in range(x + radius, x + w - radius, dash + gap):
        ex = min(sx + dash, x + w - radius)
        pygame.draw.line(surf, color, (sx, y), (ex, y), width)
        pygame.draw.line(surf, color, (sx, y + h), (ex, y + h), width)
    for sy in range(y + radius, y + h - radius, dash + gap):
        ey = min(sy + dash, y + h - radius)
        pygame.draw.line(surf, color, (x, sy), (x, ey), width)
        pygame.draw.line(surf, color, (x + w, sy), (x + w, ey), width)
    for cx, cy, a0 in ((x + radius, y + radius, 180), (x + w - radius, y + radius, 270),
                       (x + w - radius, y + h - radius, 0), (x + radius, y + h - radius, 90)):
        r = pygame.Rect(cx - radius, cy - radius, radius * 2, radius * 2)
        pygame.draw.arc(surf, color, r, math.radians(a0), math.radians(a0 + 90), width)


# ---------------------------------------------------------------------------
# Renderer
# ---------------------------------------------------------------------------

class Renderer:

    def __init__(self, screen: pygame.Surface):
        self.screen = screen

        pygame.font.init()
        pygame.mixer.set_num_channels(32)

        def _lf(size: int, bold: bool = False) -> pygame.font.Font:
            for name in ("Helvetica Neue", "Helvetica", "Segoe UI", "Tahoma", "Verdana"):
                path = pygame.font.match_font(name, bold=bold)
                if path:
                    try:
                        return pygame.font.Font(path, size)
                    except Exception:
                        pass
            return pygame.font.SysFont("Arial", size, bold=bold)

        self.font_xl    = _lf(46, bold=True)   # "osu!" title
        self.font_score = _lf(30, bold=True)   # live score digits
        self.font_lg    = _lf(22, bold=True)   # PAUSED / section headers
        self.font_time  = _lf(18)              # clock
        self.font_md    = _lf(14)              # player names / labels
        self.font_sm    = _lf(12)              # small info
        self.font_xs    = _lf(10)              # tiny labels

        self.state: str = "WAITING"

        self.osr_paths: List[str]     = []
        self.osu_path:  Optional[str] = None

        self.replays: List[Replay]      = []
        self.beatmap: Optional[Beatmap] = None

        self.mode: str = "OVERLAY"

        self.current_time:    float = 0.0
        self.playback_origin: float = 0.0
        self.last_ticks:      int   = 0
        self.paused:          bool  = False
        self.speed:           float = 1.0
        self.show_help:       bool  = False
        self._start_pending:  bool  = False

        # Skin (.osk dropped in the project root, loaded automatically)
        self.skin = skin_mod.load_default(_PROJECT_ROOT)
        self.palette: List[Tuple[int, int, int]] = (
            self.skin.combo_colors if self.skin and self.skin.combo_colors
            else config.COMBO_COLORS
        )
        self._skin_raw:   Dict[str, pygame.Surface] = {}
        self._skin_cache: Dict[Tuple, pygame.Surface] = {}

        self.combo_colors:         List[Tuple[int, int, int]] = []
        self.combo_numbers:        List[int]                 = []
        self.error_msg:            Optional[str]             = None
        self._candidate_osu_paths: List[str]                 = []
        self._tmpdir:              Optional[str]             = None

        # Rendering difficulty (replay 1's mods applied)
        self.render_radius:  float = 32.0
        self.render_preempt: float = 1200.0
        self.mods_strings:   List[str] = []

        # Background image
        self._bg_raw:    Optional[pygame.Surface] = None
        self._bg_scaled: Optional[pygame.Surface] = None
        self._bg_size:   Tuple[int, int]          = (0, 0)

        # Auto-download
        self._dl_queue:  "queue.Queue" = queue.Queue()
        self._dl_thread: Optional[threading.Thread] = None
        self._dl_status: str = ""
        self._dl_failed: bool = False

        # Audio
        self._audio_path:    Optional[str]               = None
        self._audio_started: bool                         = False
        self._hit_sound:       Optional[pygame.mixer.Sound] = None
        self._hit_sound_times: List[float]                 = []
        self._hit_snd_idx:     int                         = 0
        self._music_volume:    float                       = 0.7
        self._sfx_volume:      float                       = 1.0

        # Live score timeline — one entry per loaded replay
        self._score_events: List[List[ScoreEvent]] = []

        # Interactive UI state
        self._dragging:      Optional[str]        = None
        self._hover:         Optional[str]        = None
        self._music_bar_x:   int                  = 0
        self._music_bar_w:   int                  = 0
        self._sfx_bar_x:     int                  = 0
        self._sfx_bar_w:     int                  = 0
        self._bar_y:          int                  = 0
        self._prog_bar_x:    int                  = 0
        self._prog_bar_w:    int                  = 0
        self._prog_bar_y:    int                  = 0
        self._mode_btn_rect:   Optional[pygame.Rect] = None
        self._speed_btn_rect:  Optional[pygame.Rect] = None
        self._skip_btn_rect:   Optional[pygame.Rect] = None
        self._browse_btn_rect: Optional[pygame.Rect] = None
        self._help_btn_rect:   Optional[pygame.Rect] = None
        self._start_btn_rect:  Optional[pygame.Rect] = None
        self._cursor_hand:   bool                  = False

        # Font cache for combo numbers (keyed by pixel size)
        self._font_cache: Dict[int, pygame.font.Font] = {}

        self._load_hit_sound()

    # ------------------------------------------------------------------
    # File loading
    # ------------------------------------------------------------------

    def handle_drop(self, path: str) -> None:
        ext = os.path.splitext(path)[1].lower()
        if ext == ".osr":
            try:
                rp = load_replay(path)
            except Exception as exc:
                self.error_msg = f"Replay error: {exc}"
                return
            if path in self.osr_paths:
                self.replays[self.osr_paths.index(path)] = rp
            elif self.replays and rp.beatmap_md5 != self.replays[0].beatmap_md5:
                # Replay of a *different* beatmap → start a fresh session
                # (keep a just-dropped map if it matches the new replay).
                keep_cands  = self._candidate_osu_paths
                keep_tmpdir = self._tmpdir
                self.reset()
                if keep_cands and any(self._md5(p) == rp.beatmap_md5
                                      for p in keep_cands):
                    self._candidate_osu_paths = keep_cands
                    self._tmpdir = keep_tmpdir
                self.replays   = [rp]
                self.osr_paths = [path]
            elif len(self.replays) < 2:
                self.replays.append(rp)
                self.osr_paths.append(path)
            else:
                self.replays[1]   = rp
                self.osr_paths[1] = path
        elif ext == ".osu":
            self.osu_path = path
            self._candidate_osu_paths = [path]
        elif ext == ".osz":
            self._handle_osz(path)
        else:
            self.error_msg = f"Unsupported file type: {ext}"
            return

        self.error_msg = None
        self._dl_failed = False
        self._try_load()

        # No beatmap yet? Fetch it automatically from a mirror.
        if (self.replays and not self.osu_path
                and not self._candidate_osu_paths):
            self._start_auto_download(self.replays[0].beatmap_md5)

    def open_file_dialog(self) -> None:
        """Native file picker (best effort — drag & drop always works)."""
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.update()
            paths = filedialog.askopenfilenames(
                title="Open replays / beatmap",
                filetypes=[("osu! files", "*.osr *.osu *.osz"), ("All files", "*.*")],
            )
            root.destroy()
        except Exception as exc:
            self.error_msg = f"File dialog unavailable ({exc}) — drag & drop instead."
            return
        for p in paths:
            self.handle_drop(p)

    # ---- .osz -----------------------------------------------------------

    def _handle_osz(self, path: str) -> None:
        try:
            tmpdir = tempfile.mkdtemp(prefix="osu_rv_map_")
            self._tmpdir = tmpdir
            osu_paths: List[str] = []
            with zipfile.ZipFile(path, "r") as zf:
                for name in zf.namelist():
                    if os.path.splitext(name)[1].lower() in _VIDEO_EXTS:
                        continue
                    zf.extract(name, tmpdir)
                    if name.lower().endswith(".osu"):
                        osu_paths.append(os.path.join(tmpdir, name))
            if not osu_paths:
                self.error_msg = "No .osu file found inside the .osz archive."
                return
            self._candidate_osu_paths = osu_paths
            # Forget the previous map so this archive's difficulties are
            # resolved (by replay MD5) instead of keeping the old .osu.
            self.osu_path = osu_paths[0] if len(osu_paths) == 1 else None
        except zipfile.BadZipFile:
            self.error_msg = "Could not open .osz — file may be corrupted."

    # ---- auto-download --------------------------------------------------

    def _start_auto_download(self, md5: str) -> None:
        if self._dl_thread and self._dl_thread.is_alive():
            return
        if self._dl_failed:
            return
        self._dl_status = "Searching beatmap online…"

        def work() -> None:
            try:
                osz = mirror.fetch_osz_for_md5(md5, self._set_dl_status)
                self._dl_queue.put(("ok", osz))
            except Exception as exc:
                self._dl_queue.put(("err", str(exc)))

        self._dl_thread = threading.Thread(target=work, daemon=True)
        self._dl_thread.start()

    def _set_dl_status(self, msg: str) -> None:
        self._dl_status = msg

    def poll_async(self) -> None:
        """Apply finished background work (called every frame)."""
        try:
            kind, payload = self._dl_queue.get_nowait()
        except queue.Empty:
            return
        self._dl_status = ""
        if kind == "ok":
            if not self.osu_path and not self._candidate_osu_paths:
                self._handle_osz(payload)
                self._try_load()
        else:
            self._dl_failed = True
            self.error_msg = payload

    # ---- trigger --------------------------------------------------------

    def _try_load(self) -> None:
        if not self.replays:
            return
        if not self.osu_path and not self._candidate_osu_paths:
            return
        self._load()

    def _md5(self, path: str) -> str:
        h = hashlib.md5()
        with open(path, "rb") as f:
            h.update(f.read())
        return h.hexdigest()

    def _load(self) -> None:
        try:
            if not self.osu_path and self._candidate_osu_paths:
                target = self.replays[0].beatmap_md5
                match  = next(
                    (p for p in self._candidate_osu_paths if self._md5(p) == target),
                    None,
                )
                self.osu_path = match or self._candidate_osu_paths[0]
                if not match:
                    self.error_msg = (
                        f"MD5 mismatch — using first difficulty. "
                        f"({len(self._candidate_osu_paths)} found)"
                    )

            self.beatmap = load_beatmap(self.osu_path)   # type: ignore[arg-type]

            # Difficulty as seen by replay 1 (CS/AR for rendering)
            mods0 = self.replays[0].mods
            cs, ar, _ = mods_mod.adjusted_difficulty(
                self.beatmap.cs, self.beatmap.ar, self.beatmap.od, mods0)
            self.render_radius  = mods_mod.circle_radius(cs)
            self.render_preempt = mods_mod.preempt_ms(ar)
            self.mods_strings   = [mods_mod.mods_string(r.mods) for r in self.replays]

            self._build_combo_colors()
            self._score_events = [
                compute_live_scores(r, self.beatmap) for r in self.replays
            ]

            # Hit-sound timeline from P1's actual hits (judgment > 0).
            self._hit_sound_times = sorted(
                ev.time for ev in self._score_events[0] if ev.judgment > 0
            ) if self._score_events else []
            self._hit_snd_idx = 0

            if self.beatmap.hit_objects:
                first_t = self.beatmap.hit_objects[0].time
                self.playback_origin = first_t - self.render_preempt - 1500
            else:
                self.playback_origin = -2000.0

            self.current_time = self.playback_origin
            self.last_ticks   = pygame.time.get_ticks()
            # Wait on the start button instead of auto-playing
            self.paused          = True
            self._start_pending  = True
            self.state        = "PLAYING"
            if len(self.replays) < 2:
                self.mode = "OVERLAY"

            self._load_background()
            self._init_audio()

            if (len(self.replays) >= 2
                    and self.replays[0].beatmap_md5 != self.replays[1].beatmap_md5):
                self.error_msg = "Warning: replays are from different beatmaps!"

        except Exception as exc:
            self.error_msg = f"Load error: {exc}"
            self.state = "WAITING"

    def reset(self) -> None:
        """Back to the waiting screen, dropping all loaded files."""
        self._audio_stop()
        self.state = "WAITING"
        self.osr_paths = []
        self.replays   = []
        self.osu_path  = None
        self._candidate_osu_paths = []
        self.beatmap   = None
        self._score_events = []
        self.error_msg = None
        self._dl_failed = False
        self._dl_status = ""
        self._bg_raw = self._bg_scaled = None
        self.speed = 1.0
        self._start_pending = False

    def _build_combo_colors(self) -> None:
        assert self.beatmap
        idxs, nums = build_combo_info(self.beatmap, len(self.palette))
        self.combo_colors  = [self.palette[i] for i in idxs]
        self.combo_numbers = nums

    def _load_background(self) -> None:
        self._bg_raw = self._bg_scaled = None
        if not self.beatmap or not self.osu_path:
            return
        bg = self.beatmap.background
        if not bg or os.path.splitext(bg)[1].lower() not in _IMAGE_EXTS:
            return
        path = os.path.join(os.path.dirname(self.osu_path), bg)
        if not os.path.isfile(path):
            return
        try:
            self._bg_raw = pygame.image.load(path).convert()
        except Exception:
            self._bg_raw = None

    def _bg_for(self, size: Tuple[int, int]) -> Optional[pygame.Surface]:
        """Window-sized, dimmed cover-scale of the beatmap background."""
        if not self._bg_raw:
            return None
        if self._bg_scaled and self._bg_size == size:
            return self._bg_scaled
        W, H = size
        iw, ih = self._bg_raw.get_size()
        scale = max(W / iw, H / ih)
        img = pygame.transform.smoothscale(self._bg_raw, (int(iw * scale), int(ih * scale)))
        canvas = pygame.Surface((W, H))
        canvas.blit(img, ((W - img.get_width()) // 2, (H - img.get_height()) // 2))
        dark = pygame.Surface((W, H))
        dark.fill((0, 0, 0))
        dark.set_alpha(198)
        canvas.blit(dark, (0, 0))
        self._bg_scaled = canvas
        self._bg_size   = size
        return canvas

    # ------------------------------------------------------------------
    # Audio
    # ------------------------------------------------------------------

    def _init_audio(self) -> None:
        """Find the audio file that belongs to the loaded beatmap."""
        self._audio_path    = None
        self._audio_started = False
        pygame.mixer.music.stop()

        if not self.beatmap or not self.beatmap.audio_filename:
            return
        osu_dir    = os.path.dirname(self.osu_path or "")
        audio_path = os.path.join(osu_dir, self.beatmap.audio_filename)
        if not os.path.isfile(audio_path):
            return
        try:
            pygame.mixer.music.load(audio_path)
            self._audio_path = audio_path
        except Exception as exc:
            self.error_msg = f"Audio load error: {exc}"

    def _audio_play_from(self, game_ms: float) -> None:
        """Start (or restart) audio from the given game time in ms."""
        if not self._audio_path or self.speed != 1.0:
            return
        pos = max(0.0, game_ms / 1000.0)
        try:
            pygame.mixer.music.set_volume(self._music_volume)
            pygame.mixer.music.play(loops=0, start=pos)
            self._audio_started = True
        except Exception as exc:
            self.error_msg = f"Audio play error: {exc}"

    def _audio_stop(self) -> None:
        if self._audio_path:
            pygame.mixer.music.stop()
        self._audio_started = False

    def adjust_music_vol(self, delta: float) -> None:
        self._music_volume = max(0.0, min(1.0, self._music_volume + delta))
        pygame.mixer.music.set_volume(self._music_volume)

    def adjust_sfx_vol(self, delta: float) -> None:
        self._sfx_volume = max(0.0, min(1.0, self._sfx_volume + delta))
        if self._hit_sound:
            self._hit_sound.set_volume(self._sfx_volume)

    def _load_hit_sound(self) -> None:
        path = os.path.join(_PROJECT_ROOT, "osu-hit-sound.mp3")
        if not os.path.isfile(path):
            return
        try:
            self._hit_sound = pygame.mixer.Sound(path)
            self._hit_sound.set_volume(self._sfx_volume)
        except Exception as e:
            self._hit_sound = None
            self.error_msg  = f"Hit sound error: {e}"

    def _num_font(self, size: int) -> pygame.font.Font:
        size = max(6, size)
        if size not in self._font_cache:
            self._font_cache[size] = pygame.font.SysFont("Arial", size, bold=True)
        return self._font_cache[size]

    # ------------------------------------------------------------------
    # Skin surfaces
    # ------------------------------------------------------------------

    def _skin_surface(
        self, name: str, width: int,
        tint: Optional[Tuple[int, int, int]] = None,
    ) -> Optional[pygame.Surface]:
        """Skin element scaled to *width* px (optionally colour-tinted)."""
        if not self.skin or not self.skin.has(name) or width < 2:
            return None
        key = (name, width, tint)
        cached = self._skin_cache.get(key)
        if cached is not None:
            return cached
        raw = self._skin_raw.get(name)
        if raw is None:
            try:
                raw = pygame.image.load(self.skin.elements[name]).convert_alpha()
            except Exception:
                self.skin.elements.pop(name, None)
                return None
            self._skin_raw[name] = raw
        h = max(2, round(width * raw.get_height() / raw.get_width()))
        img = pygame.transform.smoothscale(raw, (width, h))
        if tint:
            img = img.copy()
            img.fill((*tint, 255), special_flags=pygame.BLEND_RGBA_MULT)
        if len(self._skin_cache) > 700:        # bound the cache
            self._skin_cache.clear()
        self._skin_cache[key] = img
        return img

    def _blit_center(
        self, surf: pygame.Surface, img: pygame.Surface,
        pos: Tuple[int, int], alpha: int = 255,
    ) -> None:
        if alpha < 255:
            img.set_alpha(alpha)
        surf.blit(img, (pos[0] - img.get_width() // 2, pos[1] - img.get_height() // 2))
        if alpha < 255:
            img.set_alpha(255)

    # ------------------------------------------------------------------
    # Controls
    # ------------------------------------------------------------------

    def toggle_mode(self) -> None:
        if len(self.replays) < 2:
            return
        self.mode = "SIDE_BY_SIDE" if self.mode == "OVERLAY" else "OVERLAY"

    def begin_playback(self) -> None:
        """Leave the start screen and roll the replay."""
        if not self._start_pending:
            return
        self._start_pending = False
        self.paused = False
        self.last_ticks = pygame.time.get_ticks()

    def toggle_pause(self) -> None:
        if self.state != "PLAYING":
            return
        if self._start_pending:
            self.begin_playback()
            return
        self.paused = not self.paused
        if self.paused:
            if self._audio_started:
                pygame.mixer.music.pause()
        else:
            self.last_ticks = pygame.time.get_ticks()
            if self._audio_started:
                pygame.mixer.music.unpause()
            elif self._audio_path and self.current_time >= 0:
                self._audio_play_from(self.current_time)

    def restart(self) -> None:
        if self.state != "PLAYING":
            return
        self._audio_stop()
        self.current_time   = self.playback_origin
        self.last_ticks     = pygame.time.get_ticks()
        self.paused         = False
        self._start_pending = False
        self._hit_snd_idx   = 0

    def _end_time(self) -> float:
        if not self.beatmap or not self.beatmap.hit_objects:
            return 0.0
        return self.beatmap.hit_objects[-1].time + 2000

    def seek(self, delta_ms: float) -> None:
        if self.state != "PLAYING":
            return
        self.current_time = max(
            self.playback_origin,
            min(self._end_time(), self.current_time + delta_ms),
        )
        self.last_ticks    = pygame.time.get_ticks()
        self._hit_snd_idx  = bisect.bisect_right(self._hit_sound_times, self.current_time)
        if self._audio_path:
            if self.current_time >= 0 and not self.paused:
                self._audio_play_from(self.current_time)
            else:
                self._audio_stop()

    def change_speed(self, direction: int) -> None:
        """Step through config.SPEEDS. Music only plays at 1.00×."""
        if self.state != "PLAYING":
            return
        speeds = config.SPEEDS
        try:
            i = speeds.index(self.speed)
        except ValueError:
            i = speeds.index(1.0)
        i = max(0, min(len(speeds) - 1, i + direction))
        if speeds[i] == self.speed:
            return
        self.speed = speeds[i]
        if self.speed == 1.0:
            if self.current_time >= 0 and not self.paused:
                self._audio_play_from(self.current_time)
        else:
            self._audio_stop()

    def skip_available(self) -> bool:
        return (self.state == "PLAYING"
                and self.beatmap is not None
                and bool(self.beatmap.hit_objects)
                and self.current_time
                < self.beatmap.hit_objects[0].time - self.render_preempt - 900)

    def skip_intro(self) -> None:
        if not self.skip_available():
            return
        assert self.beatmap
        target = self.beatmap.hit_objects[0].time - self.render_preempt - 600
        self.seek(target - self.current_time)

    def toggle_help(self) -> None:
        self.show_help = not self.show_help

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def update(self) -> None:
        self.poll_async()
        if self.state != "PLAYING" or self.paused:
            return
        now = pygame.time.get_ticks()
        self.current_time += (now - self.last_ticks) * self.speed
        self.last_ticks    = now

        # Start audio exactly when game time crosses 0
        if (self._audio_path and not self._audio_started
                and self.current_time >= 0 and self.speed == 1.0):
            self._audio_play_from(self.current_time)

        # Fire hit sound at the player's actual hit times (from replay data)
        if self._hit_sound:
            while self._hit_snd_idx < len(self._hit_sound_times):
                if self._hit_sound_times[self._hit_snd_idx] <= self.current_time:
                    self._hit_sound.play()
                    self._hit_snd_idx += 1
                else:
                    break

    # ------------------------------------------------------------------
    # Draw entry point
    # ------------------------------------------------------------------

    def draw(self) -> None:
        if self.state == "WAITING":
            self._draw_waiting()
        else:
            self._draw_playing()
        if self.show_help:
            self._draw_help_overlay()

    # ------------------------------------------------------------------
    # Waiting screen
    # ------------------------------------------------------------------

    def _draw_waiting(self) -> None:
        surf = self.screen
        surf.fill(config.BG_COLOR)
        W, H = surf.get_size()
        CX   = W // 2

        # ── Title ─────────────────────────────────────────────────────────────
        t_osu = self.font_xl.render("osu!", True, config.PINK)
        t_sub = self.font_lg.render("REPLAY  VIEWER", True, config.TEXT_COLOR)
        title_h = t_osu.get_height() + 6 + t_sub.get_height()
        ty = max(24, H // 2 - title_h // 2 - 190)
        surf.blit(t_osu, (CX - t_osu.get_width() // 2, ty))
        surf.blit(t_sub, (CX - t_sub.get_width() // 2, ty + t_osu.get_height() + 6))

        # ── Drop zone ────────────────────────────────────────────────────────
        zy = ty + title_h + 26
        zw, zh = 460, 120
        zx = CX - zw // 2
        pulse = 0.62 + 0.38 * (0.5 + 0.5 * math.sin(pygame.time.get_ticks() / 480.0))
        zone_col = _tinted(config.PINK, pulse)
        _rounded_box(surf, (zx, zy, zw, zh), (255, 255, 255, 8), radius=14)
        _dashed_rect(surf, (zx, zy, zw, zh), zone_col, radius=14)

        d1 = self.font_lg.render("Drop your  .osr  replays here", True, config.TEXT_COLOR)
        d2 = self.font_sm.render("1 replay to watch  ·  2 replays to compare", True, config.TEXT_DIM)
        d3 = self.font_sm.render("beatmap is downloaded automatically", True, config.PINK)
        surf.blit(d1, (CX - d1.get_width() // 2, zy + 22))
        surf.blit(d2, (CX - d2.get_width() // 2, zy + 22 + d1.get_height() + 8))
        surf.blit(d3, (CX - d3.get_width() // 2, zy + 22 + d1.get_height() + 8 + d2.get_height() + 5))

        # Browse button
        by = zy + zh + 16
        b_lbl = self.font_md.render("Browse files…   (O)", True,
                                    (255, 255, 255) if self._hover == 'browse' else config.TEXT_COLOR)
        bw, bh = b_lbl.get_width() + 36, 34
        bx = CX - bw // 2
        hovered = self._hover == 'browse'
        _rounded_box(surf, (bx, by, bw, bh), (255, 102, 170, 70 if hovered else 38), radius=17)
        pygame.draw.rect(surf, config.PINK, (bx, by, bw, bh), 1, border_radius=17)
        surf.blit(b_lbl, (CX - b_lbl.get_width() // 2, by + (bh - b_lbl.get_height()) // 2))
        self._browse_btn_rect = pygame.Rect(bx, by, bw, bh)

        # ── Status card ───────────────────────────────────────────────────────
        sy      = by + bh + 18
        card_w  = 460
        card_h  = 96
        cx      = CX - card_w // 2
        _rounded_box(surf, (cx, sy, card_w, card_h), (255, 255, 255, 14), radius=12)

        rows = []
        for i in range(2):
            if i < len(self.replays):
                r   = self.replays[i]
                ms  = mods_mod.mods_string(r.mods)
                txt = r.player_name + (f"  +{ms}" if ms else "")
                rows.append((f"REPLAY {i+1}", txt, config.PLAYER_COLORS[i]))
            else:
                rows.append((f"REPLAY {i+1}",
                             "waiting for file…" if i == 0 or self.replays else "optional — compare 2 players",
                             None))

        bm_ok = bool(self.osu_path or self._candidate_osu_paths)
        if bm_ok:
            rows.append(("BEATMAP", "loaded", config.PINK))
        elif self._dl_status:
            dots = "." * (1 + (pygame.time.get_ticks() // 400) % 3)
            rows.append(("BEATMAP", self._dl_status + dots, config.YELLOW))
        else:
            rows.append(("BEATMAP", "drop .osu / .osz — or auto-download", None))

        ry = sy + 14
        for label, value, col in rows:
            ls = self.font_sm.render(label, True, config.TEXT_DIM)
            vs = self.font_sm.render(value[:52], True, col or config.TEXT_DIM)
            dot = col or (50, 50, 68)
            pygame.draw.circle(surf, dot, (cx + 22, ry + ls.get_height() // 2), 5)
            surf.blit(ls, (cx + 36, ry))
            surf.blit(vs, (cx + card_w - vs.get_width() - 20, ry))
            ry += ls.get_height() + 11

        # ── Controls footer ──────────────────────────────────────────────────
        iy = sy + card_h + 22
        pygame.draw.line(surf, (45, 44, 62), (CX - 170, iy), (CX + 170, iy))
        iy += 14
        controls = (
            ("SPACE", "pause"), ("R", "restart"), ("S", "skip intro"),
            ("TAB", "view mode"), ("← →", "seek 5 s"), ("- +", "speed"),
            ("H", "help"), ("C", "close files"), ("ESC", "quit"),
        )
        col_w = 150
        per_row = max(1, min(3, W // col_w))
        x0 = CX - (per_row * col_w) // 2
        for n, (key, action) in enumerate(controls):
            cxx = x0 + (n % per_row) * col_w
            cyy = iy + (n // per_row) * 19
            ks  = self.font_sm.render(key,    True, config.PINK)
            acs = self.font_sm.render(action, True, config.TEXT_DIM)
            surf.blit(ks,  (cxx, cyy))
            surf.blit(acs, (cxx + 52, cyy))

        # ── Skin info ─────────────────────────────────────────────────────────
        if self.skin:
            sk = self.font_xs.render(f"skin:  {self.skin.name.strip('- ')}",
                                     True, config.TEXT_DIM)
            surf.blit(sk, (CX - sk.get_width() // 2, H - 20))

        # ── Error ─────────────────────────────────────────────────────────────
        if self.error_msg:
            es = self.font_sm.render(self.error_msg, True, (255, 75, 90))
            surf.blit(es, (CX - es.get_width() // 2, H - 38))

    # ------------------------------------------------------------------
    # Playing screen
    # ------------------------------------------------------------------

    def _draw_playing(self) -> None:
        W, H = self.screen.get_size()
        bg = self._bg_for((W, H))
        if bg:
            self.screen.blit(bg, (0, 0))
        else:
            self.screen.fill(config.BG_COLOR)

        UI_TOP    = 72
        UI_BOTTOM = 32

        if self.mode == "OVERLAY":
            field = (0, UI_TOP, W, H - UI_TOP - UI_BOTTOM)
            self._draw_field(self.screen, field, [0, 1])
        else:
            mid    = W // 2
            field1 = (0,       UI_TOP, mid - 1, H - UI_TOP - UI_BOTTOM)
            field2 = (mid + 1, UI_TOP, mid - 1, H - UI_TOP - UI_BOTTOM)
            pygame.draw.line(self.screen, (40, 39, 56), (mid, UI_TOP), (mid, H - UI_BOTTOM), 2)
            self._draw_field(self.screen, field1, [0])
            self._draw_field(self.screen, field2, [1])

        self._draw_hud()
        if self._start_pending:
            self._draw_start_overlay()

    def _draw_start_overlay(self) -> None:
        surf = self.screen
        W, H = surf.get_size()
        dim = pygame.Surface((W, H))
        dim.fill((0, 0, 0))
        dim.set_alpha(120)
        surf.blit(dim, (0, 0))

        cx, cy = W // 2, H // 2 - 10
        hovered = self._hover == 'start'
        R = 56 if hovered else 52
        tmp = _alpha_surface(R * 2 + 22, R * 2 + 22)
        c = (R + 11, R + 11)
        pygame.draw.circle(tmp, (255, 102, 170, 60), c, R + 10)
        pygame.draw.circle(tmp, (255, 102, 170, 235 if hovered else 205), c, R)
        surf.blit(tmp, (cx - R - 11, cy - R - 11))
        # play triangle
        pts = [(cx - R * 0.32, cy - R * 0.46), (cx - R * 0.32, cy + R * 0.46),
               (cx + R * 0.55, cy)]
        pygame.draw.polygon(surf, (255, 255, 255), pts)
        self._start_btn_rect = pygame.Rect(cx - R, cy - R, R * 2, R * 2)

        names = "  vs  ".join(r.player_name for r in self.replays[:2])
        ns = self.font_lg.render(names, True, config.TEXT_COLOR)
        surf.blit(ns, (cx - ns.get_width() // 2, cy + R + 26))
        hint = self.font_sm.render("click  or press  SPACE  to start", True, config.TEXT_DIM)
        surf.blit(hint, (cx - hint.get_width() // 2, cy + R + 26 + ns.get_height() + 8))

    # ------------------------------------------------------------------
    # Playfield
    # ------------------------------------------------------------------

    def _draw_field(self, surf: pygame.Surface, rect: Rect, players: List[int]) -> None:
        if not self._bg_raw:
            pygame.draw.rect(surf, config.PLAYFIELD_BG, rect)
        if not self.beatmap:
            return
        self._draw_field_border(surf, rect)
        self._draw_hit_objects(surf, rect)
        for p in players:
            if p < len(self.replays):
                self._draw_judgments(surf, rect, p)
        for p in players:
            if p < len(self.replays):
                self._draw_cursor(surf, rect, p)
        self._draw_key_overlays(surf, rect, players)

    def _draw_field_border(self, surf: pygame.Surface, rect: Rect) -> None:
        """Subtle outline of the actual 512×384 osu! playfield."""
        x0, y0 = self._to_screen(0, 0, rect)
        x1, y1 = self._to_screen(512, 384, rect)
        pygame.draw.rect(surf, (255, 255, 255),
                         (x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16), 1, border_radius=6)
        tmp = _alpha_surface(x1 - x0 + 16, y1 - y0 + 16)
        pygame.draw.rect(tmp, (255, 255, 255, 14), tmp.get_rect(), 1, border_radius=6)
        surf.blit(tmp, (x0 - 8, y0 - 8))

    # ------------------------------------------------------------------
    # Coordinate transform
    # ------------------------------------------------------------------

    def _scale(self, rect: Rect) -> float:
        return min(rect[2] / 512.0, rect[3] / 384.0) * 0.92

    def _to_screen(self, ox: float, oy: float, rect: Rect) -> Tuple[int, int]:
        rx, ry, rw, rh = rect
        s  = self._scale(rect)
        fw, fh = 512.0 * s, 384.0 * s
        return (int(rx + (rw - fw) / 2.0 + ox * s),
                int(ry + (rh - fh) / 2.0 + oy * s))

    # ------------------------------------------------------------------
    # Hit objects
    # ------------------------------------------------------------------

    def _visible_objects(self):
        bm  = self.beatmap
        assert bm
        pre = self.render_preempt
        ct  = self.current_time
        for i, obj in enumerate(bm.hit_objects):
            end = (obj.time + obj.duration if obj.is_slider
                   else obj.end_time       if obj.is_spinner
                   else obj.time)
            if obj.time - pre <= ct <= end + config.HIT_LINGER:
                yield i, obj

    def _draw_hit_objects(self, surf: pygame.Surface, rect: Rect) -> None:
        bm    = self.beatmap
        assert bm
        pre   = self.render_preempt
        scale = self._scale(rect)
        r     = max(4, int(self.render_radius * scale))

        visible = list(self._visible_objects())

        for i, obj in sorted(
            ((i, o) for i, o in visible if o.is_slider),
            key=lambda x: -x[1].time,
        ):
            assert isinstance(obj, Slider)
            self._draw_slider(surf, rect, obj, i, r, scale, pre)

        for i, obj in sorted(
            ((i, o) for i, o in visible if not o.is_slider),
            key=lambda x: -x[1].time,
        ):
            if obj.is_circle:
                self._draw_circle_obj(surf, rect, obj, i, r, pre)
            elif obj.is_spinner:
                assert isinstance(obj, Spinner)
                self._draw_spinner(surf, rect, obj, scale)

    # ------ circle ------

    def _draw_circle_obj(
        self, surf: pygame.Surface, rect: Rect,
        obj, idx: int, r: int, pre: float,
    ) -> None:
        ct    = self.current_time
        dt    = obj.time - ct
        if dt < -config.HIT_LINGER:
            return
        pos   = self._to_screen(obj.x, obj.y, rect)
        color = self.combo_colors[idx] if idx < len(self.combo_colors) else (255, 255, 255)
        alpha = self._object_alpha(dt, pre)

        self._draw_circle_shape(surf, pos, r, color, alpha)
        self._draw_combo_number(surf, pos, r, idx, alpha)

        if dt > 0:
            ar = int(r * (1.0 + 3.0 * dt / pre))
            if ar < 1200:
                self._draw_approach_circle(surf, pos, ar, (*color, alpha))

    def _draw_circle_shape(
        self, surf: pygame.Surface, pos: Tuple[int, int],
        r: int, color: Tuple[int, int, int], alpha: int,
    ) -> None:
        base = self._skin_surface("hitcircle", r * 2, tint=color)
        if base is not None:
            self._blit_center(surf, base, pos, alpha)
            overlay = self._skin_surface("hitcircleoverlay", r * 2)
            if overlay is not None:
                self._blit_center(surf, overlay, pos, alpha)
            return
        tmp = _alpha_surface(r * 2 + 4, r * 2 + 4)
        c   = (r + 2, r + 2)
        pygame.draw.circle(tmp, (*_tinted(color, 0.55), alpha), c, r)
        pygame.draw.circle(tmp, (*color, alpha),               c, r, max(2, r // 5))
        pygame.draw.circle(tmp, (255, 255, 255, alpha),        c, r, 2)
        surf.blit(tmp, (pos[0] - r - 2, pos[1] - r - 2))

    def _draw_combo_number(
        self, surf: pygame.Surface, pos: Tuple[int, int],
        r: int, idx: int, alpha: int,
    ) -> None:
        if idx >= len(self.combo_numbers):
            return
        num  = self.combo_numbers[idx]
        font = self._num_font(max(8, int(r * 0.75)))
        ns   = font.render(str(num), True, (255, 255, 255))
        ns.set_alpha(alpha)
        surf.blit(ns, (pos[0] - ns.get_width() // 2, pos[1] - ns.get_height() // 2))

    def _draw_approach_circle(
        self, surf: pygame.Surface, pos: Tuple[int, int],
        r: int, color: Tuple[int, int, int, int],
    ) -> None:
        # Quantize the size so the scaled-image cache stays small
        img = self._skin_surface("approachcircle",
                                 max(8, (r * 2) // 6 * 6), tint=color[:3])
        if img is not None:
            self._blit_center(surf, img, pos, color[3])
            return
        tmp = _alpha_surface(r * 2 + 4, r * 2 + 4)
        pygame.draw.circle(tmp, color, (r + 2, r + 2), r, 2)
        surf.blit(tmp, (pos[0] - r - 2, pos[1] - r - 2))

    # ------ slider ------

    def _draw_slider(
        self, surf: pygame.Surface, rect: Rect,
        obj: Slider, idx: int, r: int, scale: float, pre: float,
    ) -> None:
        ct    = self.current_time
        dt    = obj.time - ct
        end_t = obj.time + obj.duration
        color = self.combo_colors[idx] if idx < len(self.combo_colors) else (255, 255, 255)
        alpha = self._object_alpha(dt, pre)

        if not obj.path:
            return

        pts  = obj.path
        step = max(1, len(pts) // 80)
        sampled = pts[::step]
        if sampled[-1] != pts[-1]:
            sampled = sampled + [pts[-1]]
        screen_pts = [self._to_screen(px, py, rect) for px, py in sampled]

        border_col = (self.skin.slider_border if self.skin and self.skin.slider_border
                      else (255, 255, 255))
        body_col   = (self.skin.slider_track if self.skin and self.skin.slider_track
                      else config.SLIDER_BODY)
        for pt in screen_pts:
            pygame.draw.circle(surf, border_col, pt, r)
        for pt in screen_pts:
            pygame.draw.circle(surf, body_col, pt, max(1, r - 3))

        tail_xy  = (obj.x, obj.y) if obj.slides % 2 == 0 else obj.path[-1]
        tail_pos = self._to_screen(*tail_xy, rect)
        self._draw_circle_shape(surf, tail_pos, r, color, alpha)

        head_pos = self._to_screen(obj.x, obj.y, rect)
        self._draw_circle_shape(surf, head_pos, r, color, alpha)
        self._draw_combo_number(surf, head_pos, r, idx, alpha)

        if dt > 0:
            ar = int(r * (1.0 + 3.0 * dt / pre))
            if ar < 1200:
                self._draw_approach_circle(surf, head_pos, ar, (*color, alpha))

        if obj.time <= ct <= end_t:
            spd   = obj.duration / obj.slides
            prog  = (ct - obj.time) / spd
            slide = int(prog)
            t     = prog - slide
            if slide % 2 == 1:
                t = 1.0 - t
            t = max(0.0, min(1.0, t))
            bx, by = path_at_t(obj.path, t)
            ball   = self._to_screen(bx, by, rect)
            follow = self._skin_surface("sliderfollowcircle", int(r * 2 * 1.6))
            if follow is not None:
                pygame.draw.circle(surf, (255, 255, 255), ball, max(2, r // 2))
                self._blit_center(surf, follow, ball)
            else:
                pygame.draw.circle(surf, (255, 255, 255), ball, int(r * 1.35), 2)
                pygame.draw.circle(surf, (255, 255, 255), ball, r)
                pygame.draw.circle(surf, color,           ball, max(1, r - 4))

    # ------ spinner ------

    def _draw_spinner(
        self, surf: pygame.Surface, rect: Rect, obj: Spinner, scale: float,
    ) -> None:
        ct     = self.current_time
        center = self._to_screen(256, 192, rect)
        max_r  = int(190 * scale)

        if obj.time <= ct <= obj.end_time:
            frac    = (ct - obj.time) / max(1, obj.end_time - obj.time)
            inner_r = int(max_r * (1.0 - frac))
        elif ct < obj.time:
            inner_r = max_r
        else:
            return

        pygame.draw.circle(surf, (180, 180, 180), center, max_r, 2)
        if inner_r > 2:
            pygame.draw.circle(surf, (220, 220, 220), center, inner_r, 2)

    # ------ alpha ------

    @staticmethod
    def _object_alpha(dt: float, pre: float) -> int:
        FADE_IN = 400.0
        if dt > pre:
            return 0
        if dt > pre - FADE_IN:
            return int(255 * (pre - dt) / FADE_IN)
        if dt >= -config.HIT_LINGER:
            return 255
        return 0

    # ------------------------------------------------------------------
    # Judgments (300 / 100 / 50 / miss popups)
    # ------------------------------------------------------------------

    def _draw_judgments(self, surf: pygame.Surface, rect: Rect, player: int) -> None:
        if player >= len(self._score_events):
            return
        evs = recent_events(self._score_events[player], self.current_time,
                            config.JUDGE_POPUP_MS)
        for ev in evs:
            if ev.judgment == 300:
                continue   # perfect hits stay clean — osu! style
            age  = self.current_time - ev.time
            life = max(0.0, min(1.0, age / config.JUDGE_POPUP_MS))
            alpha = int(255 * (1.0 - life ** 1.5))
            color = config.JUDGE_COLORS[ev.judgment]
            pos   = self._to_screen(ev.x, ev.y, rect)
            # Slight upward drift + pop-in scale
            dy    = int(-10 * life)
            label = "✕" if ev.judgment == 0 else str(ev.judgment)
            size  = 17 if ev.judgment == 0 else 14
            font  = self._num_font(size)
            ts    = font.render(label, True, color)
            ts.set_alpha(alpha)
            # In two-player overlay, offset popups slightly so they don't stack
            dx = 0
            if self.mode == "OVERLAY" and len(self.replays) == 2:
                dx = -14 if player == 0 else 14
            surf.blit(ts, (pos[0] - ts.get_width() // 2 + dx,
                           pos[1] - ts.get_height() // 2 + dy))

    # ------------------------------------------------------------------
    # Key overlay
    # ------------------------------------------------------------------

    def _draw_key_overlays(self, surf: pygame.Surface, rect: Rect, players: List[int]) -> None:
        real = [p for p in players if p < len(self.replays)]
        if not real:
            return
        rx, ry, rw, rh = rect
        for p in real:
            keys = keys_at(self.replays[p].frames, self.current_time)
            k1   = bool(keys & 4)
            k2   = bool(keys & 8)
            m1   = bool(keys & 1) and not k1
            m2   = bool(keys & 2) and not k2
            states = [("K1", k1), ("K2", k2), ("M1", m1), ("M2", m2)]

            box  = 26
            gap  = 6
            total_h = 4 * box + 3 * gap
            y0   = ry + (rh - total_h) // 2
            # P1 on the right edge, P2 on the left edge (overlay);
            # in split view each field shows its own player on the right.
            right = (p == 0) or self.mode == "SIDE_BY_SIDE"
            x0 = rx + rw - box - 10 if right else rx + 10

            col = config.PLAYER_COLORS[p]
            for n, (lbl, on) in enumerate(states):
                yy = y0 + n * (box + gap)
                fill = (*col, 215) if on else (255, 255, 255, 16)
                _rounded_box(surf, (x0, yy, box, box), fill, radius=6)
                pygame.draw.rect(surf, col if on else (70, 70, 95),
                                 (x0, yy, box, box), 1, border_radius=6)
                ts = self.font_xs.render(lbl, True,
                                         (15, 14, 22) if on else config.TEXT_DIM)
                surf.blit(ts, (x0 + (box - ts.get_width()) // 2,
                               yy + (box - ts.get_height()) // 2))

    # ------------------------------------------------------------------
    # Cursor
    # ------------------------------------------------------------------

    def _draw_cursor(self, surf: pygame.Surface, rect: Rect, player: int) -> None:
        if self.skin and self.skin.has("cursor"):
            self._draw_skin_cursor(surf, rect, player)
        else:
            self._draw_default_cursor(
                surf, rect, self.replays[player], config.PLAYER_COLORS[player],
                self.current_time,
            )

    # ---- skin cursor ----

    def _cursor_px(self, name: str, rect: Rect) -> int:
        """On-screen sprite width for a cursor element (768-px reference,
        shrunk by CURSOR_SKIN_SCALE because full size is huge)."""
        assert self.skin
        native = self.skin.sizes.get(name, (64, 64))[0] / self.skin.scales.get(name, 1)
        px = native * (rect[3] / 768.0) * config.CURSOR_SKIN_SCALE
        return max(8, int(px))

    def _draw_skin_cursor(self, surf: pygame.Surface, rect: Rect, player: int) -> None:
        replay = self.replays[player]
        ct     = self.current_time
        # Tint per player only when comparing two replays
        tint = config.PLAYER_COLORS[player] if len(self.replays) >= 2 else None

        trail_img = self._skin_surface(
            "cursortrail", self._cursor_px("cursortrail", rect), tint=tint)
        if trail_img is not None:
            n = 14
            for k in range(n, 0, -1):
                px, py = cursor_at(replay.frames, ct - k * 9)
                sp   = self._to_screen(px, py, rect)
                frac = 1.0 - k / n
                self._blit_center(surf, trail_img, sp, int(165 * frac ** 1.4))

        img = self._skin_surface("cursor", self._cursor_px("cursor", rect), tint=tint)
        if img is None:
            self._draw_default_cursor(surf, rect, replay,
                                      config.PLAYER_COLORS[player], ct)
            return
        px, py = cursor_at(replay.frames, ct)
        self._blit_center(surf, img, self._to_screen(px, py, rect))

    # ---- default cursor ----

    def _draw_default_cursor(
        self,
        surf: pygame.Surface,
        rect: Rect,
        replay: Replay,
        color: Tuple[int, int, int],
        ct: float,
    ) -> None:
        trail = config.CURSOR_TRAIL_LEN
        cr    = config.CURSOR_RADIUS

        # Trail — tapers in size and fades to background colour
        for k in range(trail, 0, -1):
            t_past = ct - k * 11
            px, py = cursor_at(replay.frames, t_past)
            sp     = self._to_screen(px, py, rect)
            frac   = k / trail
            # Quadratic fade so the head end stays bright
            bright = frac ** 1.6
            c      = _tinted(color, bright * 0.55)
            sr     = max(1, int(cr * frac * 0.52))
            pygame.draw.circle(surf, c, sp, sr)

        # Cursor head
        px, py = cursor_at(replay.frames, ct)
        sp = self._to_screen(px, py, rect)

        # Soft outer glow (dim ring slightly larger than cursor)
        pygame.draw.circle(surf, _tinted(color, 0.35), sp, cr + 4, 3)
        # Filled body
        pygame.draw.circle(surf, color, sp, cr)
        # Crisp white outline ring
        pygame.draw.circle(surf, (255, 255, 255), sp, cr, 2)
        # Centre dot
        pygame.draw.circle(surf, (255, 255, 255), sp, 3)

    # ------------------------------------------------------------------
    # HUD
    # ------------------------------------------------------------------

    def _draw_player_panel(self, surf: pygame.Surface, player: int, right: bool) -> None:
        W, _ = surf.get_size()
        ct   = self.current_time
        evs  = self._score_events[player] if player < len(self._score_events) else []
        st   = state_at(evs, ct)
        col  = config.PLAYER_COLORS[player]

        name = self.replays[player].player_name.upper()
        ms   = self.mods_strings[player] if player < len(self.mods_strings) else ""

        ns = self.font_md.render(name, True, col)
        pill_w = ns.get_width() + 20
        px = W - pill_w - 10 if right else 10
        _rounded_box(surf, (px, 9, pill_w, 20), (*col, 38), radius=10)
        surf.blit(ns, (px + 10, 11))

        if ms:
            badge = self.font_xs.render("+" + ms, True, config.YELLOW)
            bx = px - badge.get_width() - 8 if right else px + pill_w + 8
            _rounded_box(surf, (bx - 4, 11, badge.get_width() + 8, 16), (255, 212, 68, 30), radius=8)
            surf.blit(badge, (bx, 13))

        sc = self.font_score.render(f"{st.score:,}", True, col)
        sx = W - sc.get_width() - 10 if right else 10
        surf.blit(sc, (sx, 30))

        cx = self.font_sm.render(f"{st.combo}x", True, _tinted(col, 0.8))
        ax = self.font_sm.render(f"{st.acc:.2f}%", True, config.TEXT_COLOR)
        det = self.font_xs.render(
            f"100×{st.n100}   50×{st.n50}   ✕{st.nmiss}", True, config.TEXT_DIM)

        if right:
            x = W - 10 - cx.get_width()
            surf.blit(cx, (x, 58))
            x -= ax.get_width() + 12
            surf.blit(ax, (x, 58))
            x -= det.get_width() + 14
            surf.blit(det, (x, 60))
        else:
            x = 10
            surf.blit(cx, (x, 58))
            x += cx.get_width() + 12
            surf.blit(ax, (x, 58))
            x += ax.get_width() + 14
            surf.blit(det, (x, 60))

    def _draw_hud(self) -> None:
        surf = self.screen
        W, H = surf.get_size()
        ct   = self.current_time

        # ── Top bar ───────────────────────────────────────────────────────────
        _rounded_box(surf, (0, 0, W, 78), (8, 7, 14, 210), radius=0)
        pygame.draw.line(surf, (40, 39, 56), (0, 78), (W, 78))

        if self.replays:
            self._draw_player_panel(surf, 0, right=False)
        if len(self.replays) >= 2:
            self._draw_player_panel(surf, 1, right=True)

        # ── Clock – center ────────────────────────────────────────────────────
        t_s = abs(ct / 1000.0)
        clock_str = f"{'-' if ct < 0 else ''}{int(t_s // 60):02d}:{t_s % 60:05.2f}"
        cs = self.font_time.render(clock_str, True, config.TEXT_COLOR)
        surf.blit(cs, (W // 2 - cs.get_width() // 2, 12))

        if self.speed != 1.0:
            sp = self.font_sm.render(f"{self.speed:g}×  (audio muted)", True, config.YELLOW)
            surf.blit(sp, (W // 2 - sp.get_width() // 2, 34))

        if self.paused and not self._start_pending:
            ps = self.font_lg.render("PAUSED", True, config.YELLOW)
            surf.blit(ps, (W // 2 - ps.get_width() // 2, 50))

        # ── Hit error bar ─────────────────────────────────────────────────────
        self._draw_error_bar(surf, W, H)

        # ── Skip intro ───────────────────────────────────────────────────────
        self._skip_btn_rect = None
        if self.skip_available():
            lbl = self.font_md.render("SKIP  »", True,
                                      (255, 255, 255) if self._hover == 'skip' else config.TEXT_COLOR)
            bw, bh = lbl.get_width() + 34, 34
            bx, by = W - bw - 22, H - 32 - bh - 18
            hovered = self._hover == 'skip'
            _rounded_box(surf, (bx, by, bw, bh), (255, 102, 170, 80 if hovered else 45), radius=17)
            pygame.draw.rect(surf, config.PINK, (bx, by, bw, bh), 1, border_radius=17)
            surf.blit(lbl, (bx + 17, by + (bh - lbl.get_height()) // 2))
            self._skip_btn_rect = pygame.Rect(bx, by, bw, bh)

        # ── Bottom bar ────────────────────────────────────────────────────────
        self._draw_progress(surf, W, H)

        if self.error_msg:
            es = self.font_sm.render(self.error_msg, True, (255, 75, 90))
            surf.blit(es, (W // 2 - es.get_width() // 2, H - 48))

    # ---- hit error bar ----

    def _draw_error_bar(self, surf: pygame.Surface, W: int, H: int) -> None:
        if not self.beatmap or not self._score_events:
            return
        _, _, od = mods_mod.adjusted_difficulty(
            self.beatmap.cs, self.beatmap.ar, self.beatmap.od, self.replays[0].mods)
        win300, win100, win50 = mods_mod.hit_windows(od, self.replays[0].mods)

        bar_w, bar_h = 260, 6
        bx = W // 2 - bar_w // 2
        by = H - 32 - 22
        cxx = W // 2

        def zone(width_ms: float, color: Tuple[int, int, int], alpha: int) -> None:
            half = int(bar_w / 2 * min(1.0, width_ms / win50))
            _rounded_box(surf, (cxx - half, by, half * 2, bar_h), (*color, alpha), radius=3)

        zone(win50,  config.JUDGE_COLORS[50],  60)
        zone(win100, config.JUDGE_COLORS[100], 70)
        zone(win300, config.JUDGE_COLORS[300], 90)
        pygame.draw.line(surf, (255, 255, 255), (cxx, by - 3), (cxx, by + bar_h + 3), 1)

        for player in range(min(2, len(self._score_events))):
            evs = recent_events(self._score_events[player], self.current_time,
                                config.ERRORBAR_WINDOW_MS)
            for ev in evs:
                if ev.judgment <= 0:
                    continue
                age   = self.current_time - ev.time
                alpha = int(220 * (1.0 - age / config.ERRORBAR_WINDOW_MS))
                off   = max(-1.0, min(1.0, ev.dt / win50))
                tx    = cxx + int(off * bar_w / 2)
                tick  = _alpha_surface(2, 10)
                tick.fill((*config.PLAYER_COLORS[player], alpha))
                ty    = by - 7 if player == 0 else by + bar_h + 1
                surf.blit(tick, (tx, ty))

    def _draw_vol_bar(
        self, surf: pygame.Surface,
        x: int, y: int, vol: float,
        label: str, color: Tuple[int, int, int],
        hover: bool = False,
    ) -> Tuple[int, int]:
        BAR_W, BAR_H, KNOB_R = 82, 6, 7
        bright: Tuple[int, int, int] = (
            min(255, int(color[0] * 1.25)),
            min(255, int(color[1] * 1.25)),
            min(255, int(color[2] * 1.25)),
        )
        fill_col = bright if hover else color
        lbl = self.font_xs.render(label, True, config.TEXT_DIM)
        surf.blit(lbl, (x, y - lbl.get_height() // 2))
        bx = x + lbl.get_width() + 6
        by = y - BAR_H // 2
        track_col = (58, 56, 80) if hover else (38, 37, 54)
        pygame.draw.rect(surf, track_col, (bx, by, BAR_W, BAR_H), border_radius=3)
        fw = int(BAR_W * vol)
        if fw > 0:
            pygame.draw.rect(surf, fill_col, (bx, by, fw, BAR_H), border_radius=3)
        kx = bx + fw
        pygame.draw.circle(surf, (215, 215, 235), (kx, y), KNOB_R)
        pygame.draw.circle(surf, fill_col, (kx, y), KNOB_R - 2)
        pct = self.font_xs.render(f"{int(vol * 100)}%", True, fill_col)
        surf.blit(pct, (bx + BAR_W + KNOB_R + 5, y - pct.get_height() // 2))
        return bx, BAR_W

    def _draw_progress(self, surf: pygame.Surface, W: int, H: int) -> None:
        BOTTOM_H = 32
        _rounded_box(surf, (0, H - BOTTOM_H, W, BOTTOM_H), (8, 7, 14, 210), radius=0)
        pygame.draw.line(surf, (40, 39, 56), (0, H - BOTTOM_H), (W, H - BOTTOM_H))

        mid_y = H - 20
        self._bar_y = mid_y

        # Beatmap info – left
        if self.beatmap:
            info = (f"{self.beatmap.artist}  —  "
                    f"{self.beatmap.title}  [{self.beatmap.version}]")
            bs = self.font_xs.render(info[:70], True, config.TEXT_DIM)
            surf.blit(bs, (10, mid_y - bs.get_height() // 2))

        # Volume sliders – centre
        CX = W // 2
        music_hover = self._hover == 'music' or self._dragging == 'music'
        sfx_hover   = self._hover == 'sfx'   or self._dragging == 'sfx'
        bx_m, bw_m = self._draw_vol_bar(surf, CX - 155, mid_y,
                                         self._music_volume, "♫", config.PINK, music_hover)
        bx_s, bw_s = self._draw_vol_bar(surf, CX + 10, mid_y,
                                         self._sfx_volume, "SFX", (100, 174, 255), sfx_hover)
        self._music_bar_x, self._music_bar_w = bx_m, bw_m
        self._sfx_bar_x,   self._sfx_bar_w   = bx_s, bw_s

        # Right-side buttons: help, speed, mode
        x_right = W - 10

        hs = self.font_xs.render("?", True,
                                 config.TEXT_COLOR if self._hover == 'help' else config.TEXT_DIM)
        hb_w = hs.get_width() + 14
        hb_x = x_right - hb_w
        _rounded_box(surf, (hb_x, mid_y - 9, hb_w, 18),
                     (255, 255, 255, 26 if self._hover == 'help' else 12), radius=9)
        surf.blit(hs, (hb_x + 7, mid_y - hs.get_height() // 2))
        self._help_btn_rect = pygame.Rect(hb_x, mid_y - 9, hb_w, 18)
        x_right = hb_x - 8

        sp_lbl = self.font_xs.render(f"{self.speed:g}×", True,
                                     config.TEXT_COLOR if self._hover == 'speed' else config.TEXT_DIM)
        sp_w = sp_lbl.get_width() + 14
        sp_x = x_right - sp_w
        _rounded_box(surf, (sp_x, mid_y - 9, sp_w, 18),
                     (255, 255, 255, 26 if self._hover == 'speed' else 12), radius=9)
        surf.blit(sp_lbl, (sp_x + 7, mid_y - sp_lbl.get_height() // 2))
        self._speed_btn_rect = pygame.Rect(sp_x, mid_y - 9, sp_w, 18)
        x_right = sp_x - 8

        self._mode_btn_rect = None
        if len(self.replays) >= 2:
            mode_lbl = "OVERLAY" if self.mode == "OVERLAY" else "SIDE BY SIDE"
            mode_hover = self._hover == 'mode'
            ms = self.font_xs.render(f"TAB  {mode_lbl}", True,
                                      config.TEXT_COLOR if mode_hover else config.TEXT_DIM)
            btn_x = x_right - ms.get_width() - 12
            btn_y = mid_y - ms.get_height() // 2
            _rounded_box(surf, (btn_x - 6, btn_y - 3, ms.get_width() + 12, ms.get_height() + 6),
                         (255, 255, 255, 26 if mode_hover else 12), radius=6)
            surf.blit(ms, (btn_x, btn_y))
            self._mode_btn_rect = pygame.Rect(btn_x - 6, btn_y - 3,
                                              ms.get_width() + 12, ms.get_height() + 6)

        # Progress bar – 5 px line at very bottom with draggable knob
        if not self.beatmap or not self.beatmap.hit_objects:
            return
        start = self.playback_origin
        end   = self._end_time()
        total = end - start
        if total <= 0:
            return
        prog = max(0.0, min(1.0, (self.current_time - start) / total))
        bx, by, bw, bh = 0, H - 5, W, 5
        self._prog_bar_x = bx
        self._prog_bar_w = bw
        self._prog_bar_y = by + bh // 2
        pygame.draw.rect(surf, (38, 37, 54), (bx, by, bw, bh))
        fw = int(bw * prog)
        if fw > 0:
            pygame.draw.rect(surf, config.PINK, (bx, by, fw, bh))
        prog_hover = self._hover == 'progress' or self._dragging == 'progress'
        knob_r = 7 if prog_hover else 5
        knob_col = (255, 255, 255) if prog_hover else (210, 210, 230)
        pygame.draw.circle(surf, knob_col, (bx + fw, by + bh // 2), knob_r)

    # ------------------------------------------------------------------
    # Help overlay
    # ------------------------------------------------------------------

    def _draw_help_overlay(self) -> None:
        surf = self.screen
        W, H = surf.get_size()
        dim = pygame.Surface((W, H))
        dim.fill((0, 0, 0))
        dim.set_alpha(170)
        surf.blit(dim, (0, 0))

        entries = (
            ("SPACE", "pause / resume"),
            ("R", "restart"),
            ("S", "skip intro"),
            ("TAB", "overlay ↔ side-by-side"),
            ("← →", "seek ± 5 s"),
            ("- / +", "playback speed"),
            ("[ ]", "music volume"),
            (", .", "hit-sound volume"),
            ("O", "open file browser"),
            ("C", "close files / back to menu"),
            ("H", "toggle this help"),
            ("ESC", "quit"),
        )
        row_h   = 26
        card_w  = 380
        card_h  = 70 + len(entries) * row_h
        cx      = W // 2 - card_w // 2
        cy      = max(20, H // 2 - card_h // 2)
        _rounded_box(surf, (cx, cy, card_w, card_h), (20, 19, 30, 245), radius=14)
        pygame.draw.rect(surf, (60, 58, 84), (cx, cy, card_w, card_h), 1, border_radius=14)

        title = self.font_lg.render("Keyboard shortcuts", True, config.PINK)
        surf.blit(title, (W // 2 - title.get_width() // 2, cy + 18))

        yy = cy + 58
        for key, action in entries:
            ks = self.font_sm.render(key, True, config.PINK)
            vs = self.font_sm.render(action, True, config.TEXT_COLOR)
            surf.blit(ks, (cx + 36, yy))
            surf.blit(vs, (cx + 130, yy))
            yy += row_h

    # ------------------------------------------------------------------
    # Mouse interaction
    # ------------------------------------------------------------------

    def _in_music_bar(self, mx: int, my: int) -> bool:
        return (self.state == "PLAYING"
                and self._music_bar_x <= mx <= self._music_bar_x + self._music_bar_w
                and abs(my - self._bar_y) <= 12)

    def _in_sfx_bar(self, mx: int, my: int) -> bool:
        return (self.state == "PLAYING"
                and self._sfx_bar_x <= mx <= self._sfx_bar_x + self._sfx_bar_w
                and abs(my - self._bar_y) <= 12)

    def _in_prog_bar(self, mx: int, my: int) -> bool:
        return (self.state == "PLAYING"
                and self._prog_bar_w > 0
                and self._prog_bar_x <= mx <= self._prog_bar_x + self._prog_bar_w
                and abs(my - self._prog_bar_y) <= 14)

    @staticmethod
    def _in_rect(rect: Optional[pygame.Rect], mx: int, my: int) -> bool:
        return bool(rect and rect.collidepoint(mx, my))

    def _update_vol_from_x(self, mx: int, which: str) -> None:
        if which == 'music':
            vol = max(0.0, min(1.0, (mx - self._music_bar_x) / max(1, self._music_bar_w)))
            self._music_volume = vol
            pygame.mixer.music.set_volume(vol)
        else:
            vol = max(0.0, min(1.0, (mx - self._sfx_bar_x) / max(1, self._sfx_bar_w)))
            self._sfx_volume = vol
            if self._hit_sound:
                self._hit_sound.set_volume(vol)

    def _seek_from_x(self, mx: int) -> None:
        if self.state != "PLAYING" or self._prog_bar_w <= 0:
            return
        if not self.beatmap or not self.beatmap.hit_objects:
            return
        frac  = max(0.0, min(1.0, (mx - self._prog_bar_x) / self._prog_bar_w))
        start = self.playback_origin
        end   = self._end_time()
        self.seek(start + frac * (end - start) - self.current_time)

    def handle_mouse_down(self, pos: Tuple[int, int], button: int) -> None:
        if button != 1:
            return
        mx, my = pos
        if self.show_help:
            self.show_help = False
            return
        if self.state == "WAITING":
            if self._in_rect(self._browse_btn_rect, mx, my):
                self.open_file_dialog()
            return
        if self._start_pending and self._in_rect(self._start_btn_rect, mx, my):
            self.begin_playback()
            return
        if self._in_music_bar(mx, my):
            self._dragging = 'music'
            self._update_vol_from_x(mx, 'music')
        elif self._in_sfx_bar(mx, my):
            self._dragging = 'sfx'
            self._update_vol_from_x(mx, 'sfx')
        elif self._in_rect(self._mode_btn_rect, mx, my):
            self.toggle_mode()
        elif self._in_rect(self._speed_btn_rect, mx, my):
            speeds = config.SPEEDS
            i = speeds.index(self.speed) if self.speed in speeds else speeds.index(1.0)
            nxt = speeds[(i + 1) % len(speeds)]
            self.change_speed(speeds.index(nxt) - i)
        elif self._in_rect(self._help_btn_rect, mx, my):
            self.toggle_help()
        elif self._in_rect(self._skip_btn_rect, mx, my):
            self.skip_intro()
        elif self._in_prog_bar(mx, my):
            self._dragging = 'progress'
            self._seek_from_x(mx)

    def handle_mouse_up(self) -> None:
        self._dragging = None

    def handle_mouse_motion(self, pos: Tuple[int, int]) -> None:
        mx, my = pos
        if self._dragging == 'music':
            self._update_vol_from_x(mx, 'music')
        elif self._dragging == 'sfx':
            self._update_vol_from_x(mx, 'sfx')
        elif self._dragging == 'progress':
            self._seek_from_x(mx)

        new_hover: Optional[str] = None
        if self.state == "WAITING":
            if self._in_rect(self._browse_btn_rect, mx, my):
                new_hover = 'browse'
        else:
            if self._start_pending and self._in_rect(self._start_btn_rect, mx, my):
                new_hover = 'start'
            elif self._in_music_bar(mx, my):
                new_hover = 'music'
            elif self._in_sfx_bar(mx, my):
                new_hover = 'sfx'
            elif self._in_rect(self._mode_btn_rect, mx, my):
                new_hover = 'mode'
            elif self._in_rect(self._speed_btn_rect, mx, my):
                new_hover = 'speed'
            elif self._in_rect(self._help_btn_rect, mx, my):
                new_hover = 'help'
            elif self._in_rect(self._skip_btn_rect, mx, my):
                new_hover = 'skip'
            elif self._in_prog_bar(mx, my):
                new_hover = 'progress'

        if new_hover != self._hover:
            self._hover = new_hover
            want_hand = new_hover is not None
            if want_hand != self._cursor_hand:
                try:
                    pygame.mouse.set_cursor(
                        pygame.SYSTEM_CURSOR_HAND if want_hand else pygame.SYSTEM_CURSOR_ARROW
                    )
                except pygame.error:
                    pass
                self._cursor_hand = want_hand

    def handle_scroll(self, pos: Tuple[int, int], dy: int) -> None:
        mx, my = pos
        if self._in_music_bar(mx, my):
            self.adjust_music_vol(dy * 0.05)
        elif self._in_sfx_bar(mx, my):
            self.adjust_sfx_vol(dy * 0.05)
