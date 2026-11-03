/* Shared constants, colour palettes and default settings. */

export const COMBO_COLORS = [
  [255, 102, 170], [92, 200, 255], [255, 196, 64], [126, 230, 150],
];
export const PLAYER_COLORS = [[255, 95, 162], [76, 201, 255]];
export const JUDGE_COLORS = { 300: [92, 200, 255], 100: [62, 224, 143], 50: [255, 207, 74], 0: [255, 84, 104] };

export const JUDGE_POPUP_MS = 650;
export const ERRORBAR_MS = 4000;
export const SPEED_OPTS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

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
  pink:   { main: "#ff5fa2", dark: "#d9437f", glow: "rgba(255,95,162,.38)",  soft: "rgba(255,95,162,.13)" },
  blue:   { main: "#5b8cff", dark: "#3f69d6", glow: "rgba(91,140,255,.38)",  soft: "rgba(91,140,255,.13)" },
  green:  { main: "#3ee08f", dark: "#22b56d", glow: "rgba(62,224,143,.36)",  soft: "rgba(62,224,143,.12)" },
  purple: { main: "#a77bff", dark: "#8257e0", glow: "rgba(167,123,255,.38)", soft: "rgba(167,123,255,.13)" },
  orange: { main: "#ff9b42", dark: "#e07722", glow: "rgba(255,155,66,.36)",  soft: "rgba(255,155,66,.12)" },
  red:    { main: "#ff5468", dark: "#d63a4d", glow: "rgba(255,84,104,.38)",  soft: "rgba(255,84,104,.13)" },
};

export const DEFAULTS = {
  accent: "pink",
  bgDim: 78, bgBlur: 4,
  cursorScale: 100, trail: 100,
  showKeys: true, showErrorBar: true, showJudgments: true, show300: false,
  showApproach: true, showBorder: true, showNumbers: true, snaking: true,
  followPoints: true, hiddenFx: true, useSkin: true,
  showUR: true, showPP: true, showFps: false, bgParticles: true,
  musicVol: 70, sfxVol: 80,
};
export const OPT_UNIT = { bgDim: "%", bgBlur: "px", cursorScale: "%", trail: "%" };

// Bump APP_VERSION whenever a release is added to the top of PATCH_NOTES;
// the "what's new" modal then auto-opens once for returning visitors.
export const APP_VERSION = "3.0";
