/* Settings UI (accent, visuals, overlays, HUD toggles) and the animated
   particle background shown on the landing screen. */

import { OPT, $, hexToRgb, rgba, saveSettings, S } from "./core.js";
import { ACCENTS, OPT_UNIT, PLAYER_COLORS } from "./config.js";

/* ── particle background ───────────────────────────────────────────── */

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
  if (!PB.items.length) {
    for (let i = 0; i < 26; i++) PB.items.push(spawnParticle(true));
  }
  loopParticles();
}
export function stopParticles() { PB.on = false; cancelAnimationFrame(PB.raf); PB.g.clearRect(0, 0, innerWidth, innerHeight); }
function spawnParticle(any) {
  return {
    x: Math.random() * innerWidth,
    y: any ? Math.random() * innerHeight : innerHeight + 40,
    r: 8 + Math.random() * 34,
    vy: -(8 + Math.random() * 22) / 60,
    vx: (Math.random() - .5) * .25,
    a: .04 + Math.random() * .09,
    ring: Math.random() > .5,
  };
}
function loopParticles() {
  if (!PB.on) return;
  const g = PB.g, col = hexToRgb(ACCENTS[OPT.accent].main);
  g.clearRect(0, 0, innerWidth, innerHeight);
  for (const p of PB.items) {
    p.y += p.vy; p.x += p.vx;
    if (p.y + p.r < -10) Object.assign(p, spawnParticle(false));
    g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    if (p.ring) { g.lineWidth = 2; g.strokeStyle = rgba(col, p.a * 1.6); g.stroke(); }
    else { g.fillStyle = rgba(col, p.a); g.fill(); }
  }
  PB.raf = requestAnimationFrame(loopParticles);
}

/* ── settings ──────────────────────────────────────────────────────── */

export function setAccent(name) {
  const a = ACCENTS[name] || ACCENTS.pink;
  const root = document.documentElement.style;
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
    }
  });
  document.querySelectorAll(".swatch").forEach(s => {
    s.onclick = () => { OPT.accent = s.dataset.accent; setAccent(OPT.accent); saveSettings(); };
  });
}

export function openSettings() { $("settings-modal").classList.remove("hidden"); }
export function closeSettings() { $("settings-modal").classList.add("hidden"); }
