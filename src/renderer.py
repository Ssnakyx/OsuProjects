from __future__ import annotations

import bisect
import hashlib
import os
import tempfile
import zipfile
from typing import Dict, List, Optional, Tuple

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

import pygame

from . import config
from .beatmap  import load_beatmap, Beatmap, Circle, Slider, Spinner
from .replay   import load_replay, Replay, cursor_at
from .curves   import path_at_t
from .scoring  import compute_live_scores, score_at, combo_at

Rect = Tuple[int, int, int, int]   # x, y, w, h

_VIDEO_EXTS = {'.avi', '.mp4', '.mkv', '.flv', '.wmv', '.mov', '.m4v'}


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

        self.combo_colors:         List[Tuple[int, int, int]] = []
        self.combo_numbers:        List[int]                 = []
        self.error_msg:            Optional[str]             = None
        self._candidate_osu_paths: List[str]                 = []
        self._tmpdir:              Optional[str]             = None

        # Audio
        self._audio_path:    Optional[str]               = None
        self._audio_started: bool                         = False
        self._hit_sound:       Optional[pygame.mixer.Sound] = None
        self._hit_sound_times: List[float]                 = []
        self._hit_snd_idx:     int                         = 0
        self._music_volume:    float                       = 0.7
        self._sfx_volume:      float                       = 1.0

        # Live score timeline — one entry per loaded replay
        self._score_events: List[List] = []

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
        self._mode_btn_rect: Optional[pygame.Rect] = None
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
            if len(self.osr_paths) < 2:
                self.osr_paths.append(path)
            else:
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
        self._try_load()

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
            if len(osu_paths) == 1:
                self.osu_path = osu_paths[0]
        except zipfile.BadZipFile:
            self.error_msg = "Could not open .osz — file may be corrupted."

    # ---- trigger --------------------------------------------------------

    def _try_load(self) -> None:
        if len(self.osr_paths) < 2:
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
            self.replays = [load_replay(p) for p in self.osr_paths[:2]]

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
            self._build_combo_colors()
            self._score_events = [
                compute_live_scores(r, self.beatmap) for r in self.replays
            ]

            # Build hit-sound timeline from P1's actual key-press times.
            # Only include events where combo > 0 (i.e. real hits, not misses).
            self._hit_sound_times = sorted(
                ev[0] for ev in self._score_events[0]
                if ev[0] > float('-inf') and ev[2] > 0
            ) if self._score_events else []
            self._hit_snd_idx = 0

            if self.beatmap.hit_objects:
                first_t = self.beatmap.hit_objects[0].time
                self.playback_origin = first_t - self.beatmap.preempt - 1500
            else:
                self.playback_origin = -2000.0

            self.current_time = self.playback_origin
            self.last_ticks   = pygame.time.get_ticks()
            self.paused       = False
            self.state        = "PLAYING"

            self._init_audio()

            if self.replays[0].beatmap_md5 != self.replays[1].beatmap_md5:
                self.error_msg = "Warning: replays are from different beatmaps!"

        except Exception as exc:
            self.error_msg = f"Load error: {exc}"
            self.state = "WAITING"

    def _build_combo_colors(self) -> None:
        assert self.beatmap
        self.combo_colors  = []
        self.combo_numbers = []
        color_idx  = -1
        combo_num  = 0
        for obj in self.beatmap.hit_objects:
            if obj.is_new_combo or color_idx == -1:
                color_idx = (color_idx + 1) % len(config.COMBO_COLORS)
                combo_num = 1
            else:
                combo_num += 1
            self.combo_colors.append(config.COMBO_COLORS[color_idx])
            self.combo_numbers.append(combo_num)

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
        if not self._audio_path:
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
    # Controls
    # ------------------------------------------------------------------

    def toggle_mode(self) -> None:
        self.mode = "SIDE_BY_SIDE" if self.mode == "OVERLAY" else "OVERLAY"

    def toggle_pause(self) -> None:
        if self.state != "PLAYING":
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
        self.current_time  = self.playback_origin
        self.last_ticks    = pygame.time.get_ticks()
        self.paused        = False
        self._hit_snd_idx  = 0

    def seek(self, delta_ms: float) -> None:
        if self.state != "PLAYING":
            return
        self.current_time += delta_ms
        self.last_ticks    = pygame.time.get_ticks()
        self._hit_snd_idx  = bisect.bisect_right(self._hit_sound_times, self.current_time)
        if self._audio_path:
            if self.current_time >= 0:
                self._audio_play_from(self.current_time)
            else:
                self._audio_stop()

    # ------------------------------------------------------------------
    # Update
    # ------------------------------------------------------------------

    def update(self) -> None:
        if self.state != "PLAYING" or self.paused:
            return
        now = pygame.time.get_ticks()
        self.current_time += now - self.last_ticks
        self.last_ticks    = now

        # Start audio exactly when game time crosses 0
        if self._audio_path and not self._audio_started and self.current_time >= 0:
            self._audio_play_from(self.current_time)

        # Fire hit sound at the player's actual key-press times (from replay data)
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
        ty = H // 2 - title_h // 2 - 110
        surf.blit(t_osu, (CX - t_osu.get_width() // 2, ty))
        surf.blit(t_sub, (CX - t_sub.get_width() // 2, ty + t_osu.get_height() + 6))

        # ── Status card ───────────────────────────────────────────────────────
        sy      = ty + title_h + 36
        card_w  = 320
        card_h  = 74
        cx      = CX - card_w // 2
        _rounded_box(surf, (cx, sy, card_w, card_h), (255, 255, 255, 14), radius=12)

        # Replay row
        rl = self.font_sm.render("REPLAYS", True, config.TEXT_DIM)
        surf.blit(rl, (cx + 20, sy + 14))
        for i in range(2):
            dot_col = config.PLAYER_COLORS[i] if i < len(self.osr_paths) else (50, 50, 68)
            dx = cx + 20 + rl.get_width() + 16 + i * 22
            dy = sy + 20
            pygame.draw.circle(surf, dot_col, (dx, dy), 7)
            if i < len(self.osr_paths):
                pygame.draw.circle(surf, (255, 255, 255), (dx, dy), 7, 1)

        count_s = self.font_sm.render(f"{len(self.osr_paths)} / 2", True, config.TEXT_DIM)
        surf.blit(count_s, (cx + card_w - count_s.get_width() - 20, sy + 14))

        # Beatmap row
        bm_ok  = bool(self.osu_path or self._candidate_osu_paths)
        bl     = self.font_sm.render("BEATMAP", True, config.TEXT_DIM)
        bstate = self.font_sm.render("loaded" if bm_ok else "not loaded",
                                     True, config.PINK if bm_ok else config.TEXT_DIM)
        surf.blit(bl,     (cx + 20, sy + 46))
        surf.blit(bstate, (cx + card_w - bstate.get_width() - 20, sy + 46))
        dot_col = config.PINK if bm_ok else (50, 50, 68)
        pygame.draw.circle(surf, dot_col,
                           (cx + 20 + bl.get_width() + 12, sy + 52), 5)

        # ── Drop hint ─────────────────────────────────────────────────────────
        iy = sy + card_h + 28
        dh = self.font_md.render("Drop files anywhere to load", True, config.TEXT_COLOR)
        surf.blit(dh, (CX - dh.get_width() // 2, iy))
        iy += dh.get_height() + 12

        for label, hint in (
            (".osr", "×2  —  replay files"),
            (".osu  /  .osz", "×1  —  beatmap"),
        ):
            ls = self.font_sm.render(label, True, config.PINK)
            rs = self.font_sm.render(hint,  True, config.TEXT_DIM)
            lx = CX - (ls.get_width() + 12 + rs.get_width()) // 2
            surf.blit(ls, (lx, iy))
            surf.blit(rs, (lx + ls.get_width() + 12, iy))
            iy += ls.get_height() + 7

        # ── Divider ───────────────────────────────────────────────────────────
        iy += 14
        pygame.draw.line(surf, (45, 44, 62), (CX - 130, iy), (CX + 130, iy))
        iy += 14

        # ── Controls ──────────────────────────────────────────────────────────
        for key, action in (
            ("SPACE", "pause / resume"),
            ("R",     "restart"),
            ("TAB",   "overlay  ↔  side-by-side"),
            ("← →",   "seek  ±5 s"),
            ("[ ]",   "music volume  ±10 %"),
            (", .",   "SFX volume  ±10 %"),
            ("ESC",   "quit"),
        ):
            ks  = self.font_sm.render(key,    True, config.PINK)
            acts = self.font_sm.render(action, True, config.TEXT_DIM)
            kx  = CX - 90
            surf.blit(ks,   (kx, iy))
            surf.blit(acts, (kx + 72, iy))
            iy += ks.get_height() + 5

        # ── Error ─────────────────────────────────────────────────────────────
        if self.error_msg:
            es = self.font_sm.render(self.error_msg, True, (255, 75, 90))
            surf.blit(es, (CX - es.get_width() // 2, H - 38))

    # ------------------------------------------------------------------
    # Playing screen
    # ------------------------------------------------------------------

    def _draw_playing(self) -> None:
        self.screen.fill(config.BG_COLOR)
        W, H = self.screen.get_size()
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

    # ------------------------------------------------------------------
    # Playfield
    # ------------------------------------------------------------------

    def _draw_field(self, surf: pygame.Surface, rect: Rect, players: List[int]) -> None:
        pygame.draw.rect(surf, config.PLAYFIELD_BG, rect)
        if not self.beatmap:
            return
        self._draw_hit_objects(surf, rect)
        for p in players:
            if p < len(self.replays):
                self._draw_cursor(surf, rect, p)

    # ------------------------------------------------------------------
    # Coordinate transform
    # ------------------------------------------------------------------

    def _scale(self, rect: Rect) -> float:
        return min(rect[2] / 512.0, rect[3] / 384.0)

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
        pre = bm.preempt
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
        pre   = bm.preempt
        scale = self._scale(rect)
        r     = max(4, int(bm.circle_radius * scale))

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
        tmp = _alpha_surface(r * 2 + 4, r * 2 + 4)
        c   = (r + 2, r + 2)
        pygame.draw.circle(tmp, (*color, alpha),        c, r)
        pygame.draw.circle(tmp, (255, 255, 255, alpha), c, r, 2)
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

        for pt in screen_pts:
            pygame.draw.circle(surf, (255, 255, 255),  pt, r)
        for pt in screen_pts:
            pygame.draw.circle(surf, config.SLIDER_BODY, pt, max(1, r - 3))

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
    # Cursor
    # ------------------------------------------------------------------

    def _draw_cursor(self, surf: pygame.Surface, rect: Rect, player: int) -> None:
        self._draw_default_cursor(
            surf, rect, self.replays[player], config.PLAYER_COLORS[player], self.current_time
        )

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

    def _draw_hud(self) -> None:
        surf = self.screen
        W, H = surf.get_size()
        ct   = self.current_time

        # ── Top bar ───────────────────────────────────────────────────────────
        _rounded_box(surf, (0, 0, W, 72), (8, 7, 14, 210), radius=0)
        pygame.draw.line(surf, (40, 39, 56), (0, 72), (W, 72))

        # ── Player 1 – left ───────────────────────────────────────────────────
        if self.replays:
            ev0   = self._score_events[0] if self._score_events else []
            live0 = score_at(ev0, ct)
            cmb0  = combo_at(ev0, ct)
            col0  = config.PLAYER_COLORS[0]

            ns = self.font_md.render(self.replays[0].player_name.upper(), True, col0)
            pill_w = ns.get_width() + 20
            _rounded_box(surf, (10, 9, pill_w, 20), (*col0, 38), radius=10)
            surf.blit(ns, (20, 11))

            sc = self.font_score.render(f"{live0:,}", True, col0)
            surf.blit(sc, (10, 32))

            cx = self.font_sm.render(f"{cmb0}x", True, _tinted(col0, 0.7))
            surf.blit(cx, (10 + sc.get_width() + 8, 32 + sc.get_height() - cx.get_height()))

        # ── Player 2 – right ──────────────────────────────────────────────────
        if len(self.replays) >= 2:
            ev1   = self._score_events[1] if len(self._score_events) >= 2 else []
            live1 = score_at(ev1, ct)
            cmb1  = combo_at(ev1, ct)
            col1  = config.PLAYER_COLORS[1]

            ns = self.font_md.render(self.replays[1].player_name.upper(), True, col1)
            pill_w = ns.get_width() + 20
            _rounded_box(surf, (W - pill_w - 10, 9, pill_w, 20), (*col1, 38), radius=10)
            surf.blit(ns, (W - ns.get_width() - 20, 11))

            sc = self.font_score.render(f"{live1:,}", True, col1)
            surf.blit(sc, (W - sc.get_width() - 10, 32))

            cx = self.font_sm.render(f"{cmb1}x", True, _tinted(col1, 0.7))
            surf.blit(cx, (W - sc.get_width() - 10 - cx.get_width() - 8,
                           32 + sc.get_height() - cx.get_height()))

        # ── Clock – center ────────────────────────────────────────────────────
        t_s = abs(ct / 1000.0)
        clock_str = f"{'-' if ct < 0 else ''}{int(t_s // 60):02d}:{t_s % 60:05.2f}"
        cs = self.font_time.render(clock_str, True, config.TEXT_COLOR)
        surf.blit(cs, (W // 2 - cs.get_width() // 2, 14))

        if self.paused:
            ps = self.font_lg.render("PAUSED", True, config.YELLOW)
            surf.blit(ps, (W // 2 - ps.get_width() // 2, 38))

        # ── Bottom bar ────────────────────────────────────────────────────────
        self._draw_progress(surf, W, H)

        if self.error_msg:
            es = self.font_sm.render(self.error_msg, True, (255, 75, 90))
            surf.blit(es, (W // 2 - es.get_width() // 2, H - 42))

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
            bs = self.font_xs.render(info, True, config.TEXT_DIM)
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

        # Mode button – right (clickable)
        mode_lbl = "OVERLAY" if self.mode == "OVERLAY" else "SIDE BY SIDE"
        mode_hover = self._hover == 'mode'
        ms = self.font_xs.render(f"TAB  {mode_lbl}", True,
                                  config.TEXT_COLOR if mode_hover else config.TEXT_DIM)
        btn_x = W - ms.get_width() - 18
        btn_y = mid_y - ms.get_height() // 2
        if mode_hover:
            _rounded_box(surf, (btn_x - 6, btn_y - 3, ms.get_width() + 12, ms.get_height() + 6),
                        (255, 255, 255, 20), radius=6)
        surf.blit(ms, (btn_x, btn_y))
        self._mode_btn_rect = pygame.Rect(btn_x - 6, btn_y - 3, ms.get_width() + 12, ms.get_height() + 6)

        # Progress bar – 5 px line at very bottom with draggable knob
        if not self.beatmap or not self.beatmap.hit_objects:
            return
        start = self.playback_origin
        end   = self.beatmap.hit_objects[-1].time + 2000
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
    # Mouse interaction
    # ------------------------------------------------------------------

    def _in_music_bar(self, mx: int, my: int) -> bool:
        return (self._music_bar_x <= mx <= self._music_bar_x + self._music_bar_w
                and abs(my - self._bar_y) <= 12)

    def _in_sfx_bar(self, mx: int, my: int) -> bool:
        return (self._sfx_bar_x <= mx <= self._sfx_bar_x + self._sfx_bar_w
                and abs(my - self._bar_y) <= 12)

    def _in_prog_bar(self, mx: int, my: int) -> bool:
        return (self._prog_bar_w > 0
                and self._prog_bar_x <= mx <= self._prog_bar_x + self._prog_bar_w
                and abs(my - self._prog_bar_y) <= 14)

    def _in_mode_btn(self, mx: int, my: int) -> bool:
        return bool(self._mode_btn_rect and self._mode_btn_rect.collidepoint(mx, my))

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
        end   = self.beatmap.hit_objects[-1].time + 2000
        self.seek(start + frac * (end - start) - self.current_time)

    def handle_mouse_down(self, pos: Tuple[int, int], button: int) -> None:
        if button != 1:
            return
        mx, my = pos
        if self._in_music_bar(mx, my):
            self._dragging = 'music'
            self._update_vol_from_x(mx, 'music')
        elif self._in_sfx_bar(mx, my):
            self._dragging = 'sfx'
            self._update_vol_from_x(mx, 'sfx')
        elif self._in_mode_btn(mx, my):
            self.toggle_mode()
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
        if self._in_music_bar(mx, my):
            new_hover = 'music'
        elif self._in_sfx_bar(mx, my):
            new_hover = 'sfx'
        elif self._in_mode_btn(mx, my):
            new_hover = 'mode'
        elif self._in_prog_bar(mx, my):
            new_hover = 'progress'

        if new_hover != self._hover:
            self._hover = new_hover
            want_hand = new_hover is not None
            if want_hand != self._cursor_hand:
                pygame.mouse.set_cursor(
                    pygame.SYSTEM_CURSOR_HAND if want_hand else pygame.SYSTEM_CURSOR_ARROW
                )
                self._cursor_hand = want_hand

    def handle_scroll(self, pos: Tuple[int, int], dy: int) -> None:
        mx, my = pos
        if self._in_music_bar(mx, my):
            self.adjust_music_vol(dy * 0.05)
        elif self._in_sfx_bar(mx, my):
            self.adjust_sfx_vol(dy * 0.05)
