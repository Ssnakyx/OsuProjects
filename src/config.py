OSU_WIDTH  = 512
OSU_HEIGHT = 384

# ── Background ────────────────────────────────────────────────────────────────
BG_COLOR     = (15, 14, 22)
PLAYFIELD_BG = (22, 21, 33)

# ── Brand / accent ────────────────────────────────────────────────────────────
PINK   = (255, 102, 170)   # osu! lazer pink
YELLOW = (255, 212,  68)   # paused / highlight

# ── Text ──────────────────────────────────────────────────────────────────────
TEXT_COLOR = (210, 210, 228)
TEXT_DIM   = (110, 110, 145)

# ── Player colours ────────────────────────────────────────────────────────────
PLAYER_COLORS = [
    (255, 102, 170),   # P1 – osu! pink
    (100, 174, 255),   # P2 – sky blue
]

# ── Hit-object combo colours ──────────────────────────────────────────────────
COMBO_COLORS = [
    (255, 160,  55),
    ( 60, 210,  90),
    ( 60, 148, 255),
    (255,  60,  90),
    (175,  60, 218),
    (255, 218,  50),
]

# ── Cursor ────────────────────────────────────────────────────────────────────
CURSOR_TRAIL_LEN  = 28
CURSOR_RADIUS     = 9      # vector fallback cursor
CURSOR_SKIN_SCALE = 0.6    # shrink factor for skin cursor sprites

# ── Slider ────────────────────────────────────────────────────────────────────
SLIDER_BODY  = (50, 50, 72)

# ── Timing ────────────────────────────────────────────────────────────────────
FADE_IN_MS  = 400
HIT_LINGER  = 200

# ── Judgments ─────────────────────────────────────────────────────────────────
JUDGE_COLORS = {
    300: ( 80, 170, 255),
    100: ( 90, 220, 110),
    50:  (255, 175,  70),
    0:   (255,  70,  90),   # miss
}
JUDGE_POPUP_MS = 650        # how long a judgment popup stays on screen
ERRORBAR_WINDOW_MS = 4000   # hit-error ticks linger this long

# ── Playback speeds ───────────────────────────────────────────────────────────
SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
