/* Overlay screens: the "what's new" patch notes and the end-of-replay
   results screen (osu!-style rank, score and judgment breakdown). */

import { S, $, escapeHtml } from "./core.js";
import { APP_VERSION, MOD } from "./config.js";

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
        "The LAN address (e.g. <code>http://192.168.1.42:7270</code>) is printed on startup so you know what to type.",
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

export function showResults() {
  const slots = [0, 1].filter(s => S.replays[s] && S.events[s]);
  if (!slots.length) return;

  $("results-title").textContent = `${S.map.artist} — ${S.map.title}`;
  $("results-sub").textContent = `[${S.map.version}]  ·  mapped by ${S.map.creator}`;

  const grid = $("results-grid");
  grid.classList.toggle("two", slots.length > 1);
  grid.innerHTML = slots.map(slot => {
    const r = S.replays[slot];
    const evs = S.events[slot].events;
    const ev = evs[evs.length - 1] || [];
    const score = ev[1] || 0, acc = ev[3] != null ? ev[3] : 100;
    const n300 = ev[8] || 0, n100 = ev[9] || 0, n50 = ev[10] || 0, nMiss = ev[11] || 0;
    let maxCombo = 0;
    for (const e of evs) if (e[2] > maxCombo) maxCombo = e[2];
    const g = gradeOf(n300, n100, n50, nMiss, r.mods);
    return `
      <div class="res-card grade-${g}">
        <div class="res-player">${escapeHtml(r.player)}${r.modsStr ? ` <span class="res-mods">+${escapeHtml(r.modsStr)}</span>` : ""}</div>
        <div class="res-grade grade-${g}">${gradeLabel(g)}</div>
        <div class="res-score">${score.toLocaleString("en-US")}</div>
        <div class="res-score-label">score</div>
        <div class="res-stats">
          <div><span>Accuracy</span><b>${acc.toFixed(2)}%</b></div>
          <div><span>Max Combo</span><b>${maxCombo}x</b></div>
        </div>
        <div class="res-judge">
          <div class="j j300"><span>300</span><b>${n300}</b></div>
          <div class="j j100"><span>100</span><b>${n100}</b></div>
          <div class="j j50"><span>50</span><b>${n50}</b></div>
          <div class="j jmiss"><span>MISS</span><b>${nMiss}</b></div>
        </div>
      </div>`;
  }).join("");

  $("results-modal").classList.remove("hidden");
}
export function closeResults() { $("results-modal").classList.add("hidden"); }
