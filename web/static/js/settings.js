/* Settings UI (accent, visuals, overlays, HUD toggles) and the animated
   particle background shown on the landing screen. */

import { OPT, $, hexToRgb, rgba, saveSettings, S } from "./core.js";
import { ACCENTS, OPT_UNIT, PLAYER_COLORS } from "./config.js";

/* ── triangle background ───────────────────────────────────────────────
   Equilateral triangles drifting upward, each a slightly different shade
   of the UI hue (a handful tinted with the accent), in the spirit of the
   lazer menus. Toggled by the "Menu animation" setting. */

const PB = { c: $("particles"), g: null, items: [], raf: 0, on: false };
PB.g = PB.c.getContext("2d");

export function sizeParticles() {
  const dpr = window.devicePixelRatio || 1;
  PB.c.width = Math.round(innerWidth * dpr); PB.c.height = Math.round(innerHeight * dpr);
  PB.g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
export function startParticles() {
  if (PB.on || !OPT.bgParticles) return;
  PB.on = true; sizeParticles();
  const want = Math.round(Math.min(60, Math.max(22, innerWidth * innerHeight / 30000)));
  while (PB.items.length < want) PB.items.push(spawnParticle(true));
  loopParticles();
}
export function stopParticles() { PB.on = false; cancelAnimationFrame(PB.raf); PB.g.clearRect(0, 0, innerWidth, innerHeight); }
function spawnParticle(any) {
  const s = 50 + Math.pow(Math.random(), 1.6) * 260;   // many small, few large
  return {
    x: Math.random() * innerWidth,
    y: any ? Math.random() * (innerHeight + s) : innerHeight + s,
    s,
    vy: -(10 + Math.random() * 18) * (0.45 + s / 300) / 60,
    l: 9 + Math.random() * 9,                     // lightness of the shade
    accent: Math.random() < .12,
  };
}
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function loopParticles() {
  if (!PB.on) return;
  const g = PB.g, hue = ACCENTS[OPT.accent].hue, col = hexToRgb(ACCENTS[OPT.accent].main);
  g.clearRect(0, 0, innerWidth, innerHeight);
  PB.items.sort((a, b) => a.s - b.s);   // bigger (closer) triangles drawn last
  for (const p of PB.items) {
    if (!REDUCED) p.y += p.vy;
    if (p.y + p.s < -10) Object.assign(p, spawnParticle(false));
    const h = p.s * 0.866;
    g.beginPath();
    g.moveTo(p.x, p.y - h * 0.66);
    g.lineTo(p.x + p.s / 2, p.y + h * 0.34);
    g.lineTo(p.x - p.s / 2, p.y + h * 0.34);
    g.closePath();
    g.fillStyle = p.accent ? rgba(col, .07) : `hsla(${hue}, 14%, ${p.l}%, .55)`;
    g.fill();
  }
  if (!REDUCED) PB.raf = requestAnimationFrame(loopParticles);
}

/* ── settings ──────────────────────────────────────────────────────── */

export function setAccent(name) {
  const a = ACCENTS[name] || ACCENTS.pink;
  const root = document.documentElement.style;
  root.setProperty("--h", a.hue);
  root.setProperty("--accent", a.main);
  root.setProperty("--accent-2", a.dark);
  root.setProperty("--accent-glow", a.glow);
  root.setProperty("--accent-soft", a.soft);
  PLAYER_COLORS[0] = hexToRgb(a.main);
  document.querySelectorAll(".swatch").forEach(s => s.classList.toggle("active", s.dataset.accent === name));
}

export function applySettings() {
  setAccent(OPT.accent);
  $("bg-layer").style.filter = `brightness(${(100 - OPT.bgDim) / 100}) blur(${OPT.bgBlur}px) saturate(.95)`;
  $("fps").classList.toggle("hidden", !OPT.showFps);
  $("vol-music").value = OPT.musicVol; $("vol-sfx").value = OPT.sfxVol;
  paintRange($("vol-music")); paintRange($("vol-sfx"));
  if (S.audio) S.audio.volume = OPT.musicVol / 100;
  if (S.sfxGain) S.sfxGain.gain.value = OPT.sfxVol / 100;
  if (OPT.bgParticles && !document.body.classList.contains("playing")) startParticles(); else stopParticles();
}

function fmtOpt(key, v) { return v + (OPT_UNIT[key] || ""); }

export function bindSettings() {
  document.querySelectorAll("[data-opt]").forEach(el => {
    const key = el.dataset.opt;
    if (el.type === "checkbox") {
      el.checked = !!OPT[key];
      el.onchange = () => { OPT[key] = el.checked; applySettings(); saveSettings(); };
    } else {
      el.value = OPT[key];
      const out = el.parentElement.querySelector("output");
      const upd = () => { OPT[key] = parseFloat(el.value); if (out) out.textContent = fmtOpt(key, el.value); applySettings(); saveSettings(); };
      if (out) out.textContent = fmtOpt(key, el.value);
      el.oninput = upd;
      paintRange(el);
    }
  });
  document.querySelectorAll(".swatch").forEach(s => {
    s.onclick = () => { OPT.accent = s.dataset.accent; setAccent(OPT.accent); saveSettings(); };
  });
}

/* Range inputs draw their filled part from --p (0–100). */
export function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  el.style.setProperty("--p", ((+el.value - min) / (max - min || 1)) * 100);
}
document.addEventListener("input", e => { if (e.target.type === "range") paintRange(e.target); });

export function openSettings() { $("settings-modal").classList.remove("hidden"); }
export function closeSettings() { $("settings-modal").classList.add("hidden"); }
