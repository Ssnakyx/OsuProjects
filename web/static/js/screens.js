/* Overlay screens: the "what's new" patch notes and the end-of-replay
   results screen (osu!-style rank, score and judgment breakdown). */

import { S, $, escapeHtml } from "./core.js";
import { APP_VERSION, MOD } from "./config.js";
import { triLayer } from "./landing-fx.js";

/* ════════ patch notes ════════ */

const PATCH_NOTES = [
  {
    ver: "2.2", name: "Results, polish & cleanup", date: "2026-06-20",
    changes: [
      { tag: "added", items: [
        "End-of-replay <b>results screen</b> — osu!-style rank, score, accuracy, max combo and 300/100/50/miss breakdown, with <i>Watch again</i> and <i>Back to menu</i>.",
        "A clear <b>Start</b> button on the main menu (disabled until a replay + beatmap are ready).",
      ]},
      { tag: "changed", items: [
        "Full <b>UI redesign</b> — cleaner theme, custom-styled sliders, grouped playback controls and a polished HUD.",
        "The frontend is now split into small ES modules under <code>web/static/js/</code> instead of one large file.",
      ]},
      { tag: "fixed", items: [
        "The bottom control bar could be pushed off-screen on high-resolution / high-DPI monitors — now stays put.",
        "Loading a new map after finishing one now downloads the right beatmap and plays its own song (it used to reuse the previous map).",
      ]},
    ],
  },
  {
    ver: "2.1", name: "Network & sharing", date: "2026-06-20",
    changes: [
      { tag: "added", items: [
        "Watch on another device — run <code>python main.py --web --lan</code> and the viewer is reachable from any phone or PC on the same Wi-Fi.",
        "The LAN address (e.g. <code>http://YOUR-IP:7270</code>) is printed on startup so you know what to type.",
        "New <code>--host</code> flag to bind a specific network interface.",
        "This <b>What's new</b> page.",
      ]},
      { tag: "changed", items: [
        "Web server still binds to <code>127.0.0.1</code> by default (localhost-only) unless you pass <code>--lan</code>.",
      ]},
    ],
  },
  {
    ver: "2.0", name: "The big upgrade", date: "2026-06-01",
    changes: [
      { tag: "added", items: [
        "Brand-new browser version — <code>python main.py --web</code> renders on an HTML canvas, nothing is uploaded.",
        "Automatic beatmap download by replay MD5 from osu.direct / catboy.best / nerinyan.",
        "<code>.osk</code> skin support — gameplay sprites and skin.ini values.",
        "Compare two replays side-by-side or overlaid.",
        "Live hit distribution & stats panel, hit-error bar, key overlay, unstable rate and a pp estimate.",
        "Settings: accent colour, background dim/blur, cursor size & trail, and overlay toggles.",
        "Recent-replays list and macOS double-click launchers (<code>start.command</code> / <code>start-desktop.command</code>).",
        "Mod handling for DT / NC / HT / HR / EZ.",
      ]},
      { tag: "changed", items: [
        "Completely redesigned UI for both the desktop and web players.",
        "Scoring rewritten as a cumulative timeline with fast binary-search lookups.",
        "Better slider geometry (Bézier, Catmull, perfect-circle, linear).",
      ]},
      { tag: "fixed", items: [
        "HR replays are now correctly un-flipped so they line up with the beatmap.",
        "Timing and hit-window handling under DT / HT.",
      ]},
      { tag: "removed", items: [
        "No osu! API key needed anymore — downloads use public mirrors only.",
      ]},
    ],
  },
];

function renderPatchNotes() {
  $("patch-body").innerHTML = PATCH_NOTES.map(rel => `
    <div class="rel">
      <div class="rel-head">
        <span class="rel-ver">v${rel.ver}</span>
        <span class="rel-name">${rel.name}</span>
        <span class="rel-date">${rel.date}</span>
      </div>
      ${rel.changes.map(c => `
        <div class="chg">
          <span class="chg-tag ${c.tag}">${c.tag}</span>
          <ul>${c.items.map(i => `<li>${i}</li>`).join("")}</ul>
        </div>`).join("")}
    </div>`).join("");
}

export function openPatch() { renderPatchNotes(); $("patch-modal").classList.remove("hidden"); }
export function closePatch() {
  $("patch-modal").classList.add("hidden");
  try { localStorage.setItem("orv-version", APP_VERSION); } catch (_) {}
}

/* ════════ results screen ════════ */

// osu!standard letter grade from the judgment counts (silver SS/S with HD/FL).
function gradeOf(n300, n100, n50, nMiss, mods) {
  const total = n300 + n100 + n50 + nMiss;
  if (!total) return "D";
  const p300 = n300 / total, p50 = n50 / total;
  const silver = (mods & MOD.HD) || (mods & MOD.FL);
  if (nMiss === 0 && n100 === 0 && n50 === 0) return silver ? "SSH" : "SS";
  if (p300 > 0.9 && p50 <= 0.01 && nMiss === 0) return silver ? "SH" : "S";
  if ((p300 > 0.8 && nMiss === 0) || p300 > 0.9) return "A";
  if ((p300 > 0.7 && nMiss === 0) || p300 > 0.8) return "B";
  if (p300 > 0.6) return "C";
  return "D";
}
const gradeLabel = g => g.startsWith("SS") ? "SS" : g.startsWith("S") ? "S" : g;

/* ── results animation state ── */
const RING_SIZE = 172, RING_R = 76, RING_C = 2 * Math.PI * RING_R;
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let resTris = [], resRaf = 0, resLast = 0, resTimers = [];

function resultsLoop(now) {
  const dt = Math.min(0.05, (now - resLast) / 1000); resLast = now;
  for (const l of resTris) l.draw(dt);
  if (resTris.length) resRaf = requestAnimationFrame(resultsLoop);
}
function stopResultsFx() {
  cancelAnimationFrame(resRaf); resRaf = 0; resTris = [];
  resTimers.forEach(clearTimeout); resTimers = [];
}
// Ease-out count-up of a number into an element; `fmt` renders each frame.
function countUp(el, target, dur, delay, fmt) {
  if (reduceMotion()) { el.textContent = fmt(target); return; }
  const t0 = performance.now() + delay;
  (function tick(now) {
    const p = Math.max(0, Math.min(1, (now - t0) / dur));
    el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  })(performance.now());
}

export function showResults() {
  const slots = [0, 1].filter(s => S.replays[s] && S.events[s]);
  if (!slots.length) return;
  stopResultsFx();

  $("results-title").textContent = `${S.map.artist} — ${S.map.title}`;
  $("results-sub").textContent = `[${S.map.version}]  ·  mapped by ${S.map.creator}`;

  const grid = $("results-grid");
  grid.classList.toggle("two", slots.length > 1);

  const data = slots.map(slot => {
    const r = S.replays[slot];
    const evs = S.events[slot].events;
    const ev = evs[evs.length - 1] || [];
    const score = ev[1] || 0, acc = ev[3] != null ? ev[3] : 100;
    const n300 = ev[8] || 0, n100 = ev[9] || 0, n50 = ev[10] || 0, nMiss = ev[11] || 0;
    let maxCombo = 0;
    for (const e of evs) if (e[2] > maxCombo) maxCombo = e[2];
    return { slot, r, score, acc, n300, n100, n50, nMiss, maxCombo, g: gradeOf(n300, n100, n50, nMiss, r.mods) };
  });

  grid.innerHTML = data.map(d => `
    <div class="res-card" style="--pc: var(--p${d.slot})">
      <canvas class="res-tri" aria-hidden="true"></canvas>
      <div class="res-inner">
        <div class="res-player">${escapeHtml(d.r.player)}${d.r.modsStr ? `<span class="res-mods">+${escapeHtml(d.r.modsStr)}</span>` : ""}</div>
        <div class="grade-ring gr-${d.g}">
          <svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" width="${RING_SIZE}" height="${RING_SIZE}">
            <circle class="ring-bg" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}"></circle>
            <circle class="ring-fg" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${RING_R}"
                    stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"></circle>
          </svg>
          <div class="ring-bloom"></div>
          <div class="ring-center">
            <span class="ring-letter">${gradeLabel(d.g)}</span>
            <span class="ring-acc">0.00%</span>
          </div>
        </div>
        <div class="res-score">0</div>
        <div class="res-score-label">score</div>
        <div class="res-stats">
          <div><span>Max Combo</span><b class="res-combo">0x</b></div>
          <div><span>Accuracy</span><b>${d.acc.toFixed(2)}%</b></div>
        </div>
        <div class="res-judge">
          <div class="j j300"><span>300</span><b>${d.n300}</b></div>
          <div class="j j100"><span>100</span><b>${d.n100}</b></div>
          <div class="j j50"><span>50</span><b>${d.n50}</b></div>
          <div class="j jmiss"><span>MISS</span><b>${d.nMiss}</b></div>
        </div>
      </div>
    </div>`).join("");

  $("results-modal").classList.remove("hidden");

  // Reveal each card with a stagger: triangles drift, the accuracy ring
  // sweeps in, the grade pops and the score / combo / accuracy count up.
  [...grid.querySelectorAll(".res-card")].forEach((card, i) => {
    const d = data[i];
    const delay = 180 + i * 260;
    const cv = card.querySelector(".res-tri");
    if (cv) resTris.push(triLayer(cv, { count: 7, color: "rgba(255,255,255,.05)", speed: 0.6, maxSize: 90, opacity: 0.6 }));

    const ring = card.querySelector(".grade-ring");
    const fg = ring.querySelector(".ring-fg");
    const accEl = ring.querySelector(".ring-acc");
    const scoreEl = card.querySelector(".res-score");
    const comboEl = card.querySelector(".res-combo");
    const target = RING_C * (1 - d.acc / 100);

    if (reduceMotion()) {
      fg.style.strokeDashoffset = target;
      ring.classList.add("show");
      accEl.textContent = d.acc.toFixed(2) + "%";
      scoreEl.textContent = d.score.toLocaleString("en-US");
      comboEl.textContent = d.maxCombo + "x";
      return;
    }
    resTimers.push(setTimeout(() => {
      fg.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1) .05s";
      fg.style.strokeDashoffset = target;
      ring.classList.add("show");
    }, delay));
    countUp(accEl, d.acc, 1100, delay, v => v.toFixed(2) + "%");
    countUp(scoreEl, d.score, 1100, delay + 200, v => Math.round(v).toLocaleString("en-US"));
    countUp(comboEl, d.maxCombo, 900, delay + 400, v => Math.round(v) + "x");
  });

  if (resTris.length) {
    if (reduceMotion()) for (const l of resTris) l.draw(0);
    else { resLast = performance.now(); resRaf = requestAnimationFrame(resultsLoop); }
  }
}
export function closeResults() { stopResultsFx(); $("results-modal").classList.add("hidden"); }
