/* Shared constants, colour palettes and default settings. */

export const COMBO_COLORS = [
  [255, 160, 55], [60, 210, 90], [60, 148, 255],
  [255, 60, 90], [175, 60, 218], [255, 218, 50],
];
export const PLAYER_COLORS = [[255, 102, 170], [100, 174, 255]];
export const JUDGE_COLORS = { 300: [80, 170, 255], 100: [90, 220, 110], 50: [255, 175, 70], 0: [255, 70, 90] };

export const HIT_LINGER = 200;
export const JUDGE_POPUP_MS = 650;
export const ERRORBAR_MS = 4000;
export const SPEED_OPTS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export const CURSOR_SKIN_SCALE = 0.6;

export const MOD = { NF: 1, EZ: 2, HD: 8, HR: 16, DT: 64, HT: 256, NC: 512, FL: 1024 };

export const ACCENTS = {
  pink:   { main: "#ff66aa", dark: "#c94e85", glow: "rgba(255,102,170,.45)", soft: "rgba(255,102,170,.14)" },
  blue:   { main: "#5b9dff", dark: "#3f6fd1", glow: "rgba(91,157,255,.45)",  soft: "rgba(91,157,255,.14)" },
  green:  { main: "#54e08a", dark: "#33b069", glow: "rgba(84,224,138,.42)",  soft: "rgba(84,224,138,.14)" },
  purple: { main: "#b06bff", dark: "#8a44e0", glow: "rgba(176,107,255,.45)", soft: "rgba(176,107,255,.14)" },
  orange: { main: "#ff9a3c", dark: "#e0741a", glow: "rgba(255,154,60,.42)",  soft: "rgba(255,154,60,.14)" },
  red:    { main: "#ff5b6b", dark: "#d13b4b", glow: "rgba(255,91,107,.45)",  soft: "rgba(255,91,107,.14)" },
};

export const DEFAULTS = {
  accent: "pink",
  bgDim: 78, bgBlur: 4,
  cursorScale: 100, trail: 100,
  showKeys: true, showErrorBar: true, showJudgments: true, show300: false,
  showApproach: true, showBorder: true, showNumbers: true, snaking: false,
  showUR: true, showPP: true, showFps: false, bgParticles: true,
  musicVol: 70, sfxVol: 80,
};
export const OPT_UNIT = { bgDim: "%", bgBlur: "px", cursorScale: "%", trail: "%" };

// Bump APP_VERSION whenever a release is added to the top of PATCH_NOTES;
// the "what's new" modal then auto-opens once for returning visitors.
export const APP_VERSION = "2.2";
