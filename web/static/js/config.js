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

/* Transport line-icons (stroke = currentColor). Injected onto any element
   with a matching data-ic attribute; play/pause are swapped live by playback. */
export const ICONS = {
  play:    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 7 5.5Z"/></svg>',
  pause:   '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.4" height="14" rx="1.2"/><rect x="14.1" y="5" width="3.4" height="14" rx="1.2"/></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.36"/><path d="M3 4v4.5h4.5"/></svg>',
  stepB:   '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5.5" width="2.6" height="13" rx="1"/><path d="M20 6.2v11.6a1 1 0 0 1-1.55.83l-8.4-5.8a1 1 0 0 1 0-1.66l8.4-5.8A1 1 0 0 1 20 6.2Z"/></svg>',
  stepF:   '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="16.4" y="5.5" width="2.6" height="13" rx="1"/><path d="M4 6.2v11.6a1 1 0 0 0 1.55.83l8.4-5.8a1 1 0 0 0 0-1.66l-8.4-5.8A1 1 0 0 0 4 6.2Z"/></svg>',
  stats:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 19V11M12 19V5M19 19v-6"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-2.6-1.5L12.3 3h-3.6l-.4 2.4A7.6 7.6 0 0 0 5.7 6.9l-2-.8L1.9 9.2l1.7 1.3a7.7 7.7 0 0 0 0 3L1.9 14.8l1.8 3.1 2-.8a7.6 7.6 0 0 0 2.6 1.5l.4 2.4h3.6l.4-2.4a7.6 7.6 0 0 0 2.6-1.5l2 .8 1.8-3.1Z" stroke-linejoin="round"/></svg>',
  files:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  full:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>',
  music:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  sfx:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M17 8.5a4.5 4.5 0 0 1 0 7"/></svg>',
};

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
