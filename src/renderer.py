from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
from typing import List, Optional, Tuple

import pygame

from . import config
from .beatmap  import load_beatmap, Beatmap, Circle, Slider, Spinner
from .replay   import load_replay, Replay, cursor_at
from .curves   import path_at_t

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


# ---------------------------------------------------------------------------
# Renderer
# ---------------------------------------------------------------------------

class Renderer:

    def __init__(self, screen: pygame.Surface):
        self.screen = screen

        pygame.font.init()
        pygame.mixer.init(frequency=44100, size=-16, channels=2, buffer=512)

        self.font_lg = pygame.font.SysFont("Arial", 28, bold=True)
        self.font_md = pygame.font.SysFont("Arial", 20)
        self.font_sm = pygame.font.SysFont("Arial", 15)

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
        self.error_msg:            Optional[str]              = None
        self._candidate_osu_paths: List[str]                  = []
        self._tmpdir:              Optional[str]              = None

        # Audio
        self._audio_path:    Optional[str] = None
        self._audio_started: bool          = False

        # Skin
        self._cursor_img:    Optional[pygame.Surface] = None
        self._cursor_trail:  Optional[pygame.Surface] = None
        self._cursor_middle: Optional[pygame.Surface] = None
        self._skin_dir:      Optional[str]            = None

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
        elif ext == ".osk":
            self._handle_osk(path)
            return          # skin loads independently, no need to trigger _try_load
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

    # ---- .osk -----------------------------------------------------------

    def _handle_osk(self, path: str) -> None:
        try:
            skin_dir = tempfile.mkdtemp(prefix="osu_rv_skin_")
            self._skin_dir = skin_dir
            with zipfile.ZipFile(path, "r") as zf:
                for name in zf.namelist():
                    if name.lower().endswith(".png") or name.lower().endswith(".ini"):
                        zf.extract(name, skin_dir)
            self._load_skin_images(skin_dir)
            self.error_msg = None
        except zipfile.BadZipFile:
            self.error_msg = "Could not open .osk — file may be corrupted."

    def _load_skin_images(self, skin_dir: str) -> None:
        def try_img(name: str) -> Optional[pygame.Surface]:
            for fname in (name.replace(".png", "@2x.png"), name):
                p = os.path.join(skin_dir, fname)
                if os.path.isfile(p):
                    try:
                        return pygame.image.load(p).convert_alpha()
                    except Exception:
                        pass
            return None

        def scaled(img: pygame.Surface, px: int) -> pygame.Surface:
            return pygame.transform.smoothscale(img, (px, px))

        r = config.CURSOR_RADIUS

        img = try_img("cursor.png")
        if img:
            self._cursor_img = scaled(img, r * 4)

        trail = try_img("cursortrail.png")
        if trail:
            self._cursor_trail = scaled(trail, r * 3)

        mid = try_img("cursor-middle.png")
        if mid:
            self._cursor_middle = scaled(mid, r * 2)

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
        self.combo_colors = []
        idx = -1
        for obj in self.beatmap.hit_objects:
            if obj.is_new_combo or idx == -1:
                idx = (idx + 1) % len(config.COMBO_COLORS)
            self.combo_colors.append(config.COMBO_COLORS[idx])

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
            pygame.mixer.music.play(loops=0, start=pos)
            self._audio_started = True
        except Exception as exc:
            self.error_msg = f"Audio play error: {exc}"

    def _audio_stop(self) -> None:
        if self._audio_path:
            pygame.mixer.music.stop()
        self._audio_started = False

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
        self.current_time = self.playback_origin
        self.last_ticks   = pygame.time.get_ticks()
        self.paused       = False

    def seek(self, delta_ms: float) -> None:
        if self.state != "PLAYING":
            return
        self.current_time += delta_ms
        self.last_ticks    = pygame.time.get_ticks()
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
        self.screen.fill(config.BG_COLOR)
        W, H = self.screen.get_size()

        skin_loaded = self._cursor_img is not None
        lines = [
            ("osu! Replay Viewer",                          self.font_lg, (255, 220, 80)),
            ("",                                             self.font_md, config.TEXT_COLOR),
            (f"Replays loaded : {len(self.osr_paths)} / 2", self.font_md, config.TEXT_COLOR),
            (f"Beatmap loaded : {'Yes' if (self.osu_path or self._candidate_osu_paths) else 'No'}",
             self.font_md, config.TEXT_COLOR),
            (f"Skin loaded    : {'Yes' if skin_loaded else 'No'}",
             self.font_md, config.TEXT_COLOR),
            ("",                                             self.font_md, config.TEXT_COLOR),
            ("Drag & drop anywhere on the window:",          self.font_md, (180, 220, 255)),
            ("  • 2 replay files   (.osr)",                  self.font_sm, config.TEXT_COLOR),
            ("  • 1 beatmap file   (.osu  or  .osz)",        self.font_sm, config.TEXT_COLOR),
            ("  • 1 skin  (optional)  (.osk)",               self.font_sm, config.TEXT_COLOR),
            ("",                                             self.font_sm, config.TEXT_COLOR),
            ("Controls :",                                   self.font_md, (180, 220, 255)),
            ("  SPACE       pause / resume",                 self.font_sm, config.TEXT_COLOR),
            ("  R           restart",                        self.font_sm, config.TEXT_COLOR),
            ("  TAB         toggle overlay / side-by-side",  self.font_sm, config.TEXT_COLOR),
            ("  ← →         seek  ±5 s",                    self.font_sm, config.TEXT_COLOR),
            ("  ESC         quit",                           self.font_sm, config.TEXT_COLOR),
        ]

        y = H // 8
        for text, font, color in lines:
            if text:
                surf = font.render(text, True, color)
                self.screen.blit(surf, (W // 2 - surf.get_width() // 2, y))
            y += font.size("A")[1] + 6

        if self.error_msg:
            s = self.font_md.render(self.error_msg, True, (255, 80, 80))
            self.screen.blit(s, (W // 2 - s.get_width() // 2, H - 60))

    # ------------------------------------------------------------------
    # Playing screen
    # ------------------------------------------------------------------

    def _draw_playing(self) -> None:
        self.screen.fill(config.BG_COLOR)
        W, H = self.screen.get_size()
        UI_TOP    = 48
        UI_BOTTOM = 24

        if self.mode == "OVERLAY":
            field = (0, UI_TOP, W, H - UI_TOP - UI_BOTTOM)
            self._draw_field(self.screen, field, [0, 1])
        else:
            mid    = W // 2
            field1 = (0,       UI_TOP, mid - 2, H - UI_TOP - UI_BOTTOM)
            field2 = (mid + 2, UI_TOP, mid - 2, H - UI_TOP - UI_BOTTOM)
            pygame.draw.line(self.screen, (70, 70, 90), (mid, 0), (mid, H), 2)
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
        replay = self.replays[player]
        color  = config.PLAYER_COLORS[player]
        ct     = self.current_time

        if self._cursor_img is not None:
            self._draw_skin_cursor(surf, rect, replay, color, ct)
        else:
            self._draw_default_cursor(surf, rect, replay, color, ct)

    # ---- skinned cursor ----

    def _draw_skin_cursor(
        self,
        surf: pygame.Surface,
        rect: Rect,
        replay: Replay,
        color: Tuple[int, int, int],
        ct: float,
    ) -> None:
        trail_img  = self._cursor_trail or self._cursor_img
        cursor_img = self._cursor_img
        trail_len  = config.CURSOR_TRAIL_LEN

        # Trail
        if trail_img is not None:
            tw, th = trail_img.get_size()
            for k in range(1, trail_len + 1):
                t_past = ct - k * 14
                px, py = cursor_at(replay.frames, t_past)
                sp     = self._to_screen(px, py, rect)
                alpha  = int(220 * (trail_len - k) / trail_len)
                if alpha <= 0:
                    continue
                tmp = trail_img.copy()
                tmp.set_alpha(alpha)
                surf.blit(tmp, (sp[0] - tw // 2, sp[1] - th // 2))

        # Main cursor — tinted with player color so the two are distinguishable
        if cursor_img is not None:
            px, py = cursor_at(replay.frames, ct)
            sp = self._to_screen(px, py, rect)
            cw, ch = cursor_img.get_size()

            tinted = cursor_img.copy()
            # BLEND_RGBA_MULT multiplies existing pixel colors by the fill color.
            # White (255,255,255) cursors become the player color; colored cursors
            # get a tint shift.  Alpha channel is preserved.
            tinted.fill((*color, 255), special_flags=pygame.BLEND_RGBA_MULT)
            surf.blit(tinted, (sp[0] - cw // 2, sp[1] - ch // 2))

            # Optional center dot on top
            if self._cursor_middle is not None:
                mw, mh = self._cursor_middle.get_size()
                surf.blit(self._cursor_middle, (sp[0] - mw // 2, sp[1] - mh // 2))

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

        for k in range(trail, 0, -1):
            t_past = ct - k * 14
            px, py = cursor_at(replay.frames, t_past)
            sp     = self._to_screen(px, py, rect)
            factor = k / trail
            c      = _tinted(color, factor * 0.75)
            sr     = max(1, int(config.CURSOR_RADIUS * factor * 0.65))
            pygame.draw.circle(surf, c, sp, sr)

        px, py = cursor_at(replay.frames, ct)
        sp = self._to_screen(px, py, rect)
        pygame.draw.circle(surf, color,           sp, config.CURSOR_RADIUS)
        pygame.draw.circle(surf, (255, 255, 255), sp, config.CURSOR_RADIUS, 2)

    # ------------------------------------------------------------------
    # HUD
    # ------------------------------------------------------------------

    def _draw_hud(self) -> None:
        surf = self.screen
        W, H = surf.get_size()
        ct   = self.current_time

        if self.replays:
            s = self.font_md.render(self.replays[0].player_name, True, config.PLAYER_COLORS[0])
            surf.blit(s, (10, 10))
        if len(self.replays) >= 2:
            s = self.font_md.render(self.replays[1].player_name, True, config.PLAYER_COLORS[1])
            surf.blit(s, (W - s.get_width() - 10, 10))

        t_s       = ct / 1000.0
        sign, t_s = ("-", abs(t_s)) if t_s < 0 else ("", t_s)
        clock_str = f"{sign}{int(t_s // 60):02d}:{t_s % 60:05.2f}"
        cs = self.font_md.render(clock_str, True, config.TEXT_COLOR)
        surf.blit(cs, (W // 2 - cs.get_width() // 2, 12))

        if self.paused:
            ps = self.font_lg.render("PAUSED", True, (255, 210, 0))
            surf.blit(ps, (W // 2 - ps.get_width() // 2, 36))

        mode_lbl = "OVERLAY" if self.mode == "OVERLAY" else "SIDE BY SIDE"
        ms = self.font_sm.render(f"[TAB] {mode_lbl}", True, (120, 120, 140))
        surf.blit(ms, (W - ms.get_width() - 8, H - 20))

        if self.beatmap:
            info = f"{self.beatmap.artist} – {self.beatmap.title}  [{self.beatmap.version}]"
            bs = self.font_sm.render(info, True, (150, 150, 170))
            surf.blit(bs, (8, H - 20))

        self._draw_progress(surf, W, H)

        if self.error_msg:
            es = self.font_sm.render(self.error_msg, True, (255, 100, 100))
            surf.blit(es, (W // 2 - es.get_width() // 2, H - 38))

    def _draw_progress(self, surf: pygame.Surface, W: int, H: int) -> None:
        if not self.beatmap or not self.beatmap.hit_objects:
            return
        bm    = self.beatmap
        start = self.playback_origin
        end   = bm.hit_objects[-1].time + 2000
        total = end - start
        if total <= 0:
            return
        prog = max(0.0, min(1.0, (self.current_time - start) / total))
        bx, by, bw, bh = 8, H - 10, W - 16, 4
        pygame.draw.rect(surf, (50, 50, 70),    (bx, by, bw, bh))
        pygame.draw.rect(surf, (160, 160, 220), (bx, by, int(bw * prog), bh))
