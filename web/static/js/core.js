/* Foundation shared by every other module: tiny helpers, binary-search
   lookups, difficulty maths, DOM references, mutable app state, settings,
   and the toast / chip UI primitives. */

import { COMBO_COLORS, DEFAULTS, MOD } from "./config.js";

/* ── tiny helpers ──────────────────────────────────────────────────── */

export const $ = id => document.getElementById(id);
export const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function fmtTime(ms) {
  const neg = ms < 0; const s = Math.abs(ms) / 1000;
  return `${neg ? "-" : ""}${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/* ── binary-search timeline / frame lookups ────────────────────────── */

export function upperBound(events, t) {
  let lo = 0, hi = events.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (events[mid][0] <= t) lo = mid + 1; else hi = mid; }
  return lo;
}
export function frameIndexAt(frames, t) {
  let lo = 0, hi = frames.length - 1;
  if (t <= frames[0][0]) return 0;
  if (t >= frames[hi][0]) return hi;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (frames[mid][0] <= t) lo = mid; else hi = mid; }
  return lo;
}
export function cursorAt(frames, t) {
  if (!frames.length) return [256, 192];
  const i = frameIndexAt(frames, t);
  const f0 = frames[i], f1 = frames[Math.min(i + 1, frames.length - 1)];
  if (t <= f0[0] || f1[0] === f0[0]) return [f0[1], f0[2]];
  if (t >= f1[0]) return [f1[1], f1[2]];
  const s = (t - f0[0]) / (f1[0] - f0[0]);
  return [f0[1] + (f1[1] - f0[1]) * s, f0[2] + (f1[2] - f0[2]) * s];
}
export function keysAt(frames, t) {
  if (!frames.length || t < frames[0][0]) return 0;
  return frames[frameIndexAt(frames, t)][3];
}

/* ── difficulty maths ──────────────────────────────────────────────── */

export function clockRate(mods) {
  if (mods & (MOD.DT | MOD.NC)) return 1.5;
  if (mods & MOD.HT) return 0.75;
  return 1.0;
}
export function adjDifficulty(cs, ar, od, mods) {
  if (mods & MOD.HR) { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); }
  else if (mods & MOD.EZ) { cs *= .5; ar *= .5; od *= .5; }
  return [cs, ar, od];
}
export function preemptMs(ar) {
  if (ar < 5) return 1200 + 600 * (5 - ar) / 5;
  if (ar === 5) return 1200;
  return 1200 - 750 * (ar - 5) / 5;
}
export const circleRadius = cs => 54.4 - 4.48 * cs;

/* ── DOM references ────────────────────────────────────────────────── */

export const landing = $("landing"), player = $("player");
export const canvas = $("field"), ctx = canvas.getContext("2d");

/* ── mutable app state ─────────────────────────────────────────────── */

export const S = {
  replays: [null, null],
  replayBytes: [null, null],   // raw .osr buffers, for the "recent" store
  events:  [null, null],
  map: null,
  audio: null, audioBlocked: false,
  actx: null, hitBuf: null, sfxGain: null,
  started: false, playing: false,
  t: 0, lastNow: 0, speed: 1,
  origin: 0, endT: 1,
  radius: 32, preempt: 1200,
  mode: "overlay",
  hitIdx: 0, seeking: false, mapFetching: false,
  ended: false,
  fps: 0, fpsAcc: 0, fpsN: 0,
};

/* Skin holder. `palette` is the active combo-colour set; it is reassigned
   to the skin's colours when an .osk loads (see skin.js). */
export const SKIN = { present: false, el: {}, colors: [], sliderBorder: null, sliderTrack: null, palette: COMBO_COLORS };

/* ── persisted settings ────────────────────────────────────────────── */

export const OPT = { ...DEFAULTS };
try { Object.assign(OPT, JSON.parse(localStorage.getItem("orv_settings") || "{}")); } catch (e) { /* defaults */ }
export const saveSettings = () => { try { localStorage.setItem("orv_settings", JSON.stringify(OPT)); } catch (e) {} };
export function resetOptions() {
  for (const k of Object.keys(OPT)) delete OPT[k];
  Object.assign(OPT, DEFAULTS);
}

/* ── toasts & chips ────────────────────────────────────────────────── */

export function toast(msg, kind = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = "toast" + (kind !== "info" ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translateY(8px)"; setTimeout(() => el.remove(), 250); }, ms);
}

export function chip(id, value, state, pct) {
  const el = $(id);
  el.querySelector(".chip-value").textContent = value;
  el.classList.remove("ok", "err", "busy");
  if (state) el.classList.add(state);
  const bar = el.querySelector(".chip-bar i");
  if (bar) bar.style.width = (pct == null ? 0 : clamp(pct, 0, 100)) + "%";
}
