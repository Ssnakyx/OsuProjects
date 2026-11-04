/* Overlay screens: the "what's new" patch notes and the end-of-replay
   results screen (osu!-style rank, score and judgment breakdown). */

import { S, $, escapeHtml, rgba, clamp, upperBound, fmtTime, clockRate } from "./core.js";
import { APP_VERSION, MOD, PLAYER_COLORS, JUDGE_COLORS } from "./config.js";
import { triLayer } from "./landing-fx.js";
import { prepStats, urAt, ppAt } from "./stats.js";
import { seekTo, setPlaying } from "./playback.js";
import { buildDuel, renderDuel, drawDuel } from "./compare.js";

/* ════════ patch notes ════════ */

const PATCH_NOTES = [
  {
    ver: "3.4", name: "Links & a faster start", date: "2026-11-04",
    changes: [
      { tag: "added", items: [
        "<b>Load from a link</b>: paste a beatmap link or a beatmap ID in the new box (or anywhere on the menu, or drag the link in) and the map downloads with the right difficulty selected. A direct link to an <b>.osr</b> works too.",
        "Score links are recognised: osu! only lets signed-in players download replays, so the viewer links you to the score page to grab the file. The local version can use your own osu! API app to fetch the map for you.",
        "<code>?link=…</code> in the address opens a beatmap or replay link straight away, handy for sharing.",
      ]},
      { tag: "changed", items: [
        "<b>Much faster start online</b>: the Python engine is now kept in your browser's cache, warms up in the background before you drop a file, and its loading shows real progress.",
        "The last 12 downloaded beatmaps are cached, so rewatching a map is instant.",
      ]},
    ],
  },
  {
    ver: "3.3", name: "Clips & skin library", date: "2026-11-04",
    changes: [
      { tag: "added", items: [
        "<b>Export a clip</b> (camera button or <b>E</b> in the player): save a moment or the whole replay as a <b>video</b> (MP4 where your browser supports it, WebM otherwise, 720p or 1080p, with music and hit sounds) or as a looping <b>GIF</b> (up to 20 s). Presets for the whole replay or the 10 seconds around the current moment, an optional score overlay, and a preview before you download.",
        "<b>Skin library</b>: every .osk you load is kept in your browser. Pick one in Settings → Skin (or click the skin chip on the menu) to switch in one click, press <b>K</b> in the player to cycle through them, and delete the ones you no longer want.",
      ]},
    ],
  },
  {
    ver: "3.2", name: "Head to head", date: "2026-11-04",
    changes: [
      { tag: "added", items: [
        "<b>Head to head</b> on the results screen when two replays are loaded: the cursor gap at every note, who handled each note better, a win tally with streaks and the list of notes the two players were judged differently on. Click any of them to rewatch.",
        "The accuracy timeline now shades the gap between both curves in the leader's colour, and its tooltip says who leads and by how much.",
        "In overlay mode a dashed line joins the two cursors with their distance in osu! pixels (Settings → Overlays → Cursor gap).",
        "The <b>seek bar</b> shows every miss and 50 (per player) and lights up the <b>hard sections</b> of the map; hover it to see what is there.",
        "Jump to the previous / next miss with <b>[</b> and <b>]</b> (or the new buttons), step note by note with <b>Shift + , / .</b>, and toggle <b>0.25× slow motion</b> with <b>Q</b>. A new 0.1× speed plays without music.",
      ]},
      { tag: "changed", items: [
        "Frame stepping (<b>,</b> / <b>.</b>) now walks the frames of both replays, so it never skips a frame of the second player.",
      ]},
    ],
  },
  {
    ver: "3.1", name: "A new look", date: "2026-11-04",
    changes: [
      { tag: "added", items: [
        "<b>Much richer results screen</b>: an accuracy timeline with every miss, 50 and 100, the timing distribution (mean error, UR, early/late split), a playfield map of where the misses happened and a list of every missed or weak hit.",
        "Click a moment on the timeline, or any row of the list, to <b>rewatch it</b> straight away.",
        "Score panels now show max combo out of the map's total, pp estimate, unstable rate, mean error and a Full combo / misses badge.",
      ]},
      { tag: "changed", items: [
        "<b>New design</b> inspired by modern rhythm-game menus: sheared buttons and bars, drifting triangles in the background, overlay-style panels and the <b>Outfit</b> typeface.",
        "The accent colour in Settings now tints the <b>whole interface</b>, not just the buttons.",
        "Settings open as a side panel; sliders and switches have a new style.",
        "Mods in the HUD are coloured by type (difficulty reduction, increase, automation…).",
      ]},
    ],
  },
  {
    ver: "3.0", name: "Skins everywhere & a new look", date: "2026-11-03",
    changes: [
      { tag: "added", items: [
        "<b>Skins work everywhere</b>, including the online version: drop an <b>.osk</b> (or use the Skin button) and it is remembered in your browser. Remove it any time from Settings.",
        "Much fuller skin support: hit circle numbers, slider start/end circles, slider ball, follow circle, reverse arrows, follow points, judgments (300/100/50/miss), cursor rotation/expand, smooth cursor trail and spinners. Elements a skin hides (1×1 images) stay hidden.",
        "Hit sounds use your skin's own <code>normal-hitnormal</code> when it has one; the default hit sound is much louder.",
        "<b>Note stacking</b> like osu!, <b>follow points</b>, <b>reverse arrows</b> on repeat sliders and the <b>Hidden</b> fade-out.",
      ]},
      { tag: "changed", items: [
        "New design: darker \"night session\" theme, Space Grotesk + Inter, a two-column menu with a slot for every file.",
        "Scoring is closer to osu!stable: note lock, too-early clicks count as misses, exact circle size and stacked positions.",
        "Snaking sliders are on by default.",
      ]},
      { tag: "fixed", items: [
        "Sliders disappeared 200 ms after they started instead of staying until the end.",
        "Beatmaps whose audio/background name differs in case (e.g. <code>Audio.MP3</code>) played silently with no background online.",
        "After reloading the page, the first replay could land in the Replay 2 slot.",
        "Clicking the progress bar without dragging could freeze playback.",
        "Space / arrows on the menu kept controlling the hidden player (the old song resumed in the background).",
        "Wrong slider lengths on maps with green lines on the same ms as a red line, or extreme slider velocity.",
        "UR under DT/HT is now shown in real time.",
      ]},
    ],
  },
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

/* ════════ results screen ════════
   Score panels (grade ring, score, combo, pp, UR, judgments), then the
   detailed breakdown: an accuracy timeline with every miss / 50 / 100,
   the timing distribution, a playfield map of the bad hits and a
   clickable list of them. Clicking a moment rewatches it. */

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
const JNAME = { 0: "miss", 50: "50", 100: "100", 300: "300" };
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

let resTris = [], resRaf = 0, resLast = 0, resTimers = [];
let RD = null;              // data of the results currently shown
let missFilter = "all";

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

/* Size a canvas to its CSS box (HiDPI aware) and return a ready context. */
function fitCanvas(cv) {
  const w = cv.clientWidth, h = cv.clientHeight, d = DPR();
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) {
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
  }
  const g = cv.getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const relTime = t => fmtTime(t - S.origin);
const signedMs = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " ms";

/* Index (1-based) of the hit object an event belongs to. */
function noteIndex(t) {
  const objs = S.map.objects;
  let lo = 0, hi = objs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (objs[m].t < t - 1) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(objs[lo - 1].t - t) < Math.abs(objs[lo].t - t)) lo--;
  return lo + 1;
}

/* Everything the results screen shows for one replay. */
function analyse(slot) {
  prepStats(slot);
  const r = S.replays[slot];
  const ed = S.events[slot];
  const evs = ed.events;
  const ev = evs[evs.length - 1] || [];
  const score = ev[1] || 0, acc = ev[3] != null ? ev[3] : 100;
  const n300 = ev[8] || 0, n100 = ev[9] || 0, n50 = ev[10] || 0, nMiss = ev[11] || 0;
  let maxCombo = 0, sum = 0, n = 0, early = 0, late = 0;
  const bad = [];
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    if (e[2] > maxCombo) maxCombo = e[2];
    if (e[4] > 0) { sum += e[7]; n++; if (e[7] < 0) early++; else late++; }
    if (e[4] !== 300 && e[4] >= 0) {
      bad.push({ t: e[0], j: e[4], dt: e[7], x: e[5], y: e[6], combo: i > 0 ? evs[i - 1][2] : 0, slot });
    }
  }
  const rate = clockRate(r.mods);
  const mapMax = S.map.objects.filter(o => o.k !== "p").length || maxCombo;
  const endT = evs.length ? evs[evs.length - 1][0] + 1 : S.endT;
  return {
    slot, r, evs, windows: ed.windows, score, acc, n300, n100, n50, nMiss, maxCombo, mapMax,
    g: gradeOf(n300, n100, n50, nMiss, r.mods),
    ur: urAt(slot, endT), pp: ppAt(slot, endT),
    mean: n ? sum / n / rate : 0, early: n ? early / n : 0, late: n ? late / n : 0,
    bad,
  };
}

/* ── score panel ───────────────────────────────────────────────────── */

function cardHtml(d) {
  const total = d.n300 + d.n100 + d.n50 + d.nMiss || 1;
  const fc = d.nMiss === 0;
  const badge = fc
    ? `<span class="res-badge fc">${d.n100 + d.n50 === 0 ? "perfect" : "full combo"}</span>`
    : `<span class="res-badge miss">${d.nMiss} miss${d.nMiss > 1 ? "es" : ""}</span>`;
  const mods = (d.r.modsStr || "").match(/.{2}/g) || [];
  const j = (cls, label, v) => `
    <div class="j ${cls}">
      <div class="j-top"><span>${label}</span><b>${v}</b></div>
      <div class="j-bar"><i style="--w:${(v / total * 100).toFixed(1)}%"></i></div>
    </div>`;
  return `
    <div class="res-card" style="--pc: var(--p${d.slot})">
      <canvas class="res-tri" aria-hidden="true"></canvas>
      <div class="res-inner">
        <div class="grade-ring gr-${d.g}">
          <svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}">
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
        <div class="res-main">
          <div class="res-player">
            <span class="res-av">${escapeHtml((d.r.player || "?").trim().charAt(0).toUpperCase() || "?")}</span>
            <span class="res-name">${escapeHtml(d.r.player)}</span>
            ${mods.map(m => `<span class="mod mod-${m}">${m}</span>`).join("")}
            ${badge}
          </div>
          <div class="res-score">0</div>
          <div class="res-stats">
            <div><span>Max combo</span><b class="res-combo">0x</b><em>/ ${d.mapMax}x</em></div>
            <div><span>pp</span><b>≈${Math.round(d.pp)}</b></div>
            <div><span>Unstable rate</span><b>${d.ur.toFixed(1)}</b></div>
            <div><span>Mean error</span><b>${signedMs(d.mean)}</b><em>${Math.abs(d.mean) < 1 ? "centred" : d.mean > 0 ? "late" : "early"}</em></div>
          </div>
        </div>
      </div>
      <div class="res-judge">
        ${j("j300", "300", d.n300)}${j("j100", "100", d.n100)}${j("j50", "50", d.n50)}${j("jmiss", "miss", d.nMiss)}
      </div>
    </div>`;
}

/* ── accuracy timeline ─────────────────────────────────────────────── */

const TL = { pad: { l: 44, r: 14, t: 14 }, lane: 18, axis: 22, hoverX: null };

function tlRange() {
  const objs = S.map.objects;
  const t0 = objs.length ? objs[0].t - 400 : S.origin;
  let t1 = objs.length ? objs[objs.length - 1].endT : S.endT;
  for (const d of RD) if (d.evs.length) t1 = Math.max(t1, d.evs[d.evs.length - 1][0]);
  return [t0, t1 + 400];
}

function drawTimeline() {
  const cv = $("res-timeline");
  if (!cv || !RD) return;
  const { g, w, h } = fitCanvas(cv);
  const { pad, lane, axis } = TL;
  const lanesH = RD.length * lane + 6;
  const gx0 = pad.l, gx1 = w - pad.r, gy0 = pad.t, gy1 = h - axis - lanesH - 8;
  const [t0, t1] = tlRange();
  const X = t => gx0 + (t - t0) / (t1 - t0 || 1) * (gx1 - gx0);
  TL.geom = { gx0, gx1, t0, t1, X };

  // accuracy scale: ignore the noisy first few hits when choosing the floor
  let lo = 100;
  for (const d of RD) {
    const skip = Math.max(3, Math.floor(d.evs.length * 0.05));
    for (let i = skip; i < d.evs.length; i++) lo = Math.min(lo, d.evs[i][3]);
  }
  lo = Math.max(0, Math.floor((lo - 0.5) / 5) * 5);
  if (lo > 95) lo = 95;
  const Y = a => gy1 - (clamp(a, lo, 100) - lo) / (100 - lo) * (gy1 - gy0);

  const dim = css("--dim") || "#999", stroke = "rgba(255,255,255,.07)";
  g.font = `600 10.5px ${css("--font-sans") || "sans-serif"}`;

  // grid + y labels
  g.textAlign = "right"; g.textBaseline = "middle";
  const ticks = [lo, (lo + 100) / 2, 100];
  for (const a of ticks) {
    const y = Math.round(Y(a)) + .5;
    g.strokeStyle = stroke; g.lineWidth = 1;
    g.beginPath(); g.moveTo(gx0, y); g.lineTo(gx1, y); g.stroke();
    g.fillStyle = dim; g.fillText((a % 1 ? a.toFixed(1) : a) + "%", gx0 - 8, y);
  }

  // miss columns (faint, behind the lines)
  for (const d of RD) {
    g.fillStyle = rgba(JUDGE_COLORS[0], RD.length > 1 ? .10 : .14);
    for (const b of d.bad) if (b.j === 0) g.fillRect(Math.round(X(b.t)) - 1, gy0, 2, gy1 - gy0);
  }

  // two replays: shade the gap between the curves in the leader's colour
  if (RD.length === 2 && RD[0].evs.length && RD[1].evs.length) {
    const [A, B] = RD;
    let i = 0, j = 0, a = 100, b = 100, t = t0;
    while (i < A.evs.length || j < B.evs.length) {
      const ta = i < A.evs.length ? A.evs[i][0] : Infinity, tb = j < B.evs.length ? B.evs[j][0] : Infinity;
      const tn = Math.min(ta, tb);
      if (Math.abs(a - b) > 1e-6) {
        g.fillStyle = rgba(PLAYER_COLORS[a > b ? A.slot : B.slot], .16);
        const y0 = Y(Math.max(a, b)), y1 = Y(Math.min(a, b));
        g.fillRect(X(t), y0, X(tn) - X(t), y1 - y0);
      }
      t = tn;
      if (ta === tn) a = A.evs[i++][3];
      if (tb === tn) b = B.evs[j++][3];
    }
    if (Math.abs(a - b) > 1e-6) {
      g.fillStyle = rgba(PLAYER_COLORS[a > b ? A.slot : B.slot], .16);
      g.fillRect(X(t), Y(Math.max(a, b)), X(t1) - X(t), Y(Math.min(a, b)) - Y(Math.max(a, b)));
    }
  }

  // accuracy lines with a soft fill
  for (const d of RD) {
    const col = PLAYER_COLORS[d.slot];
    if (!d.evs.length) continue;
    let pf = 100;
    g.beginPath();
    g.moveTo(X(t0), Y(100));
    for (const e of d.evs) { g.lineTo(X(e[0]), Y(pf)); g.lineTo(X(e[0]), Y(e[3])); pf = e[3]; }
    g.lineTo(X(t1), Y(pf));
    const grad = g.createLinearGradient(0, gy0, 0, gy1);
    grad.addColorStop(0, rgba(col, RD.length > 1 ? .14 : .24)); grad.addColorStop(1, rgba(col, 0));
    g.save(); g.lineTo(X(t1), gy1); g.lineTo(X(t0), gy1); g.closePath();
    g.fillStyle = grad; g.fill(); g.restore();
    // stroke as steps
    g.beginPath();
    let prev = 100;
    g.moveTo(X(t0), Y(100));
    for (const e of d.evs) { g.lineTo(X(e[0]), Y(prev)); g.lineTo(X(e[0]), Y(e[3])); prev = e[3]; }
    g.lineTo(X(t1), Y(prev));
    g.strokeStyle = rgba(col, 1); g.lineWidth = 2; g.lineJoin = "round";
    g.shadowColor = rgba(col, .6); g.shadowBlur = 8; g.stroke(); g.shadowBlur = 0;
  }

  // judgment lanes
  RD.forEach((d, i) => {
    const ly = gy1 + 10 + i * lane, lh = lane - 4;
    g.fillStyle = "rgba(255,255,255,.04)";
    g.fillRect(gx0, ly, gx1 - gx0, lh);
    g.fillStyle = rgba(PLAYER_COLORS[d.slot], 1);
    g.fillRect(gx0 - 6, ly, 3, lh);
    for (const b of d.bad) {
      const x = Math.round(X(b.t));
      const hh = b.j === 0 ? lh : b.j === 50 ? lh * .72 : lh * .45;
      g.fillStyle = rgba(JUDGE_COLORS[b.j], b.j === 100 ? .75 : 1);
      g.fillRect(x - (b.j === 0 ? 1.5 : 1), ly + lh - hh, b.j === 0 ? 3 : 2, hh);
    }
  });

  // time axis
  g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = dim;
  const span = (t1 - t0) / 1000;
  const step = [5, 10, 15, 30, 60, 120, 300].find(s => span / s <= 8) || 600;
  const first = Math.ceil((t0 - S.origin) / 1000 / step) * step;
  for (let s = first; S.origin + s * 1000 <= t1; s += step) {
    const x = X(S.origin + s * 1000);
    g.fillText(fmtTime(s * 1000), x, h - axis + 6);
    g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(Math.round(x), h - axis, 1, 4); g.fillStyle = dim;
  }

  // hover cursor
  if (TL.hoverX != null) {
    const x = clamp(TL.hoverX, gx0, gx1);
    g.fillStyle = "rgba(255,255,255,.6)";
    g.fillRect(Math.round(x), gy0, 1, h - axis - gy0);
  }
}

function timelineTip(e) {
  const cv = $("res-timeline"), tip = $("res-tip");
  if (!TL.geom) return;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left;
  const { gx0, gx1, t0, t1 } = TL.geom;
  if (x < gx0 - 4 || x > gx1 + 4) { timelineLeave(); return; }
  TL.hoverX = x; drawTimeline();
  const t = t0 + (clamp(x, gx0, gx1) - gx0) / (gx1 - gx0) * (t1 - t0);
  const near = nearestBad(t, (t1 - t0) / (gx1 - gx0) * 6);
  const rows = RD.map(d => {
    const i = upperBound(d.evs, t) - 1;
    const ev = i >= 0 ? d.evs[i] : null;
    return `<div><i style="background:${rgba(PLAYER_COLORS[d.slot], 1)}"></i>${escapeHtml(d.r.player)}<span>${ev ? ev[3].toFixed(2) : "100.00"}% · ${ev ? ev[2] : 0}x</span></div>`;
  }).join("");
  let lead = "";
  if (RD.length === 2) {
    const accOf = d => { const i = upperBound(d.evs, t) - 1; return i >= 0 ? d.evs[i][3] : 100; };
    const diff = accOf(RD[0]) - accOf(RD[1]);
    lead = Math.abs(diff) < 0.005 ? `<div>dead even</div>`
      : `<div>${escapeHtml(RD[diff > 0 ? 0 : 1].r.player)} leads<span>+${Math.abs(diff).toFixed(2)}%</span></div>`;
  }
  tip.innerHTML = `<b>${relTime(near ? near.t : t)}</b>${near ? `<em class="jt j${near.j}">${JNAME[near.j]} · ${escapeHtml(S.replays[near.slot].player)}</em>` : ""}${rows}${lead}<small>click to watch</small>`;
  tip.classList.remove("hidden");
  const tw = tip.offsetWidth;
  tip.style.left = clamp(x + 14, 4, r.width - tw - 4) + "px";
  if (x + 14 + tw > r.width) tip.style.left = Math.max(4, x - tw - 14) + "px";
}
function timelineLeave() { TL.hoverX = null; $("res-tip").classList.add("hidden"); drawTimeline(); }
function nearestBad(t, tol) {
  let best = null, bd = tol;
  for (const d of RD) for (const b of d.bad) { const dd = Math.abs(b.t - t); if (dd <= bd) { bd = dd; best = b; } }
  return best;
}
function timelineClick(e) {
  if (!TL.geom) return;
  const r = $("res-timeline").getBoundingClientRect();
  const { gx0, gx1, t0, t1 } = TL.geom;
  const x = clamp(e.clientX - r.left, gx0, gx1);
  const t = t0 + (x - gx0) / (gx1 - gx0) * (t1 - t0);
  const near = nearestBad(t, (t1 - t0) / (gx1 - gx0) * 6);
  watchAt(near ? near.t : t);
}

/* ── timing distribution ───────────────────────────────────────────── */

function drawHist() {
  const cv = $("res-hist");
  if (!cv || !RD) return;
  const { g, w, h } = fitCanvas(cv);
  const win = RD[0].windows, w50 = win[2];
  const axis = 20, top = 8, gh = h - axis - top;
  const BINS = 41;
  const per = RD.map(d => {
    const arr = new Array(BINS).fill(0);
    for (const e of d.evs) if (e[4] > 0) arr[clamp(Math.round((e[7] / w50 + 1) / 2 * (BINS - 1)), 0, BINS - 1)]++;
    return arr;
  });
  const maxc = Math.max(1, ...per.flat());
  const cx = w / 2, zw = ms => (w / 2) * Math.min(1, ms / w50);
  const zone = (ms, col, a) => { g.fillStyle = rgba(col, a); g.fillRect(cx - zw(ms), top, zw(ms) * 2, gh); };
  zone(w50, JUDGE_COLORS[50], .07); zone(win[1], JUDGE_COLORS[100], .08); zone(win[0], JUDGE_COLORS[300], .10);

  const bw = w / BINS;
  per.forEach((arr, si) => {
    const col = PLAYER_COLORS[RD[si].slot];
    const off = RD.length > 1 ? (si ? bw * .25 : -bw * .25) : 0, bwid = RD.length > 1 ? bw * .5 - 1 : bw - 2;
    for (let b = 0; b < BINS; b++) {
      if (!arr[b]) continue;
      const bh = Math.max(2, arr[b] / maxc * (gh - 4));
      g.fillStyle = rgba(col, .9);
      const x = b * bw + (bw - bwid) / 2 + off;
      g.beginPath(); g.roundRect ? g.roundRect(x, top + gh - bh, bwid, bh, [2, 2, 0, 0]) : g.rect(x, top + gh - bh, bwid, bh); g.fill();
    }
  });
  // centre + mean markers
  g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(Math.round(cx), top, 1, gh);
  for (const d of RD) {
    const mx = cx + clamp(d.mean * clockRate(d.r.mods) / w50, -1, 1) * w / 2;
    g.fillStyle = rgba(PLAYER_COLORS[d.slot], 1);
    g.beginPath(); g.moveTo(mx, top + gh + 2); g.lineTo(mx - 5, top + gh + 9); g.lineTo(mx + 5, top + gh + 9); g.closePath(); g.fill();
  }
  // window labels
  g.font = `600 10px ${css("--font-sans") || "sans-serif"}`; g.textAlign = "center"; g.textBaseline = "top";
  for (const [ms, col] of [[win[0], JUDGE_COLORS[300]], [win[1], JUDGE_COLORS[100]], [w50, JUDGE_COLORS[50]]]) {
    g.fillStyle = rgba(col, .85);
    const lbl = "±" + Math.round(ms / (RD[0] ? clockRate(RD[0].r.mods) : 1));
    g.fillText(lbl, clamp(cx + zw(ms), 14, w - 14), top + gh + 9);
    g.fillText(lbl, clamp(cx - zw(ms), 14, w - 14), top + gh + 9);
  }

  $("res-timing").innerHTML = RD.map(d => `
    <div class="tm-row">
      <span class="tm-name"><i style="background:${rgba(PLAYER_COLORS[d.slot], 1)}"></i>${escapeHtml(d.r.player)}</span>
      <span>mean <b>${signedMs(d.mean)}</b></span>
      <span>UR <b>${d.ur.toFixed(1)}</b></span>
      <span class="tm-split"><em style="--e:${(d.early * 100).toFixed(1)}%"></em><b>${Math.round(d.early * 100)}%</b> early · <b>${Math.round(d.late * 100)}%</b> late</span>
    </div>`).join("");
}

/* ── playfield map of bad hits ─────────────────────────────────────── */

function drawField() {
  const cv = $("res-field");
  if (!cv || !RD) return;
  const { g, w, h } = fitCanvas(cv);
  const sc = Math.min((w - 20) / 512, (h - 20) / 384);
  const ox = (w - 512 * sc) / 2, oy = (h - 384 * sc) / 2;
  const P = (x, y) => [ox + x * sc, oy + y * sc];
  g.strokeStyle = "rgba(255,255,255,.1)"; g.lineWidth = 1;
  g.strokeRect(Math.round(ox) + .5, Math.round(oy) + .5, Math.round(512 * sc), Math.round(384 * sc));
  g.fillStyle = "rgba(255,255,255,.07)";
  for (const o of S.map.objects) {
    if (o.k === "p") continue;
    const [x, y] = P(o.x, o.y);
    g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
  }
  const order = { 100: 0, 50: 1, 0: 2 };
  const all = RD.flatMap(d => d.bad).sort((a, b) => order[a.j] - order[b.j]);
  for (const b of all) {
    const [x, y] = P(b.x, b.y);
    const pc = PLAYER_COLORS[b.slot];
    if (b.j === 0) {
      const r = 5.5;
      g.strokeStyle = rgba(JUDGE_COLORS[0], 1); g.lineWidth = 2.4; g.lineCap = "round";
      g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke();
      if (RD.length > 1) { g.fillStyle = rgba(pc, 1); g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.fill(); }
    } else {
      g.fillStyle = rgba(JUDGE_COLORS[b.j], b.j === 50 ? .95 : .7);
      g.beginPath(); g.arc(x, y, b.j === 50 ? 4 : 3, 0, Math.PI * 2); g.fill();
      if (RD.length > 1) { g.strokeStyle = rgba(pc, .9); g.lineWidth = 1.2; g.stroke(); }
    }
  }
}

/* ── list of misses / weak hits ────────────────────────────────────── */

function renderMisses() {
  const box = $("res-misses");
  const keep = b => missFilter === "all" ? true : b.j === +missFilter;
  const counts = { all: 0, 0: 0, 50: 0, 100: 0 };
  for (const d of RD) for (const b of d.bad) { counts.all++; counts[b.j]++; }
  const tabs = [["all", "All"], ["0", "Misses"], ["50", "50s"], ["100", "100s"]].map(([k, l]) =>
    `<button class="mf ${missFilter === k ? "on" : ""}" data-f="${k}">${l}<span>${counts[k]}</span></button>`).join("");
  const col = d => {
    const rows = d.bad.filter(keep);
    const body = rows.length ? rows.slice(0, 300).map(b => `
      <button class="mrow" data-t="${b.t}">
        <span class="mj j${b.j}">${JNAME[b.j]}</span>
        <span class="mt">${relTime(b.t)}</span>
        <span class="mn">note ${noteIndex(b.t)}</span>
        <span class="md">${b.j === 0 ? (b.combo ? `broke a <b>${b.combo}x</b> combo` : "no combo lost") : `${signedMs(b.dt / clockRate(d.r.mods))} <em>${b.dt < 0 ? "early" : "late"}</em>`}</span>
        <span class="mgo" aria-hidden="true">›</span>
      </button>`).join("") + (rows.length > 300 ? `<div class="mempty">… and ${rows.length - 300} more</div>` : "")
      : `<div class="mempty">${missFilter === "0" || (missFilter === "all" && !d.nMiss && !d.bad.length) ? "Nothing here, clean run!" : "Nothing in this category."}</div>`;
    return `<div class="mcol" style="--pc: var(--p${d.slot})">
      ${RD.length > 1 ? `<div class="mcol-head"><i></i>${escapeHtml(d.r.player)}</div>` : ""}
      <div class="mlist">${body}</div></div>`;
  };
  box.innerHTML = `<div class="mtabs">${tabs}</div><div class="mcols ${RD.length > 1 ? "two" : ""}">${RD.map(col).join("")}</div>`;
  box.querySelectorAll(".mf").forEach(b => b.onclick = () => { missFilter = b.dataset.f; renderMisses(); });
  box.querySelectorAll(".mrow").forEach(b => b.onclick = () => watchAt(+b.dataset.t));
}

/* Jump back into the replay a little before `t`. */
function watchAt(t) {
  closeResults();
  S.ended = false;
  seekTo(Math.max(S.origin, t - 1500));
  setPlaying(true);
}

function drawCharts() { drawTimeline(); drawDuel(); drawHist(); drawField(); }
let chartsBound = false;
function bindCharts() {
  if (chartsBound) return;
  chartsBound = true;
  const cv = $("res-timeline");
  cv.addEventListener("mousemove", timelineTip);
  cv.addEventListener("mouseleave", timelineLeave);
  cv.addEventListener("click", timelineClick);
  window.addEventListener("resize", () => { if (RD && !$("results-modal").classList.contains("hidden")) drawCharts(); });
}

export function showResults() {
  const slots = [0, 1].filter(s => S.replays[s] && S.events[s]);
  if (!slots.length) return;
  stopResultsFx();

  $("results-title").textContent = `${S.map.artist} — ${S.map.title}`;
  $("results-sub").textContent = `[${S.map.version}]  ·  mapped by ${S.map.creator}`;

  const data = slots.map(analyse);
  RD = data;
  missFilter = "all";

  const grid = $("results-grid");
  grid.classList.toggle("two", slots.length > 1);
  grid.innerHTML = data.map(cardHtml).join("");

  $("results-modal").classList.remove("hidden");
  $("results-modal").querySelector(".modal-card").scrollTop = 0;
  bindCharts();
  buildDuel();
  renderDuel(watchAt);
  renderMisses();
  requestAnimationFrame(drawCharts);

  // Reveal each card with a stagger: triangles drift, the accuracy ring
  // sweeps in, the grade pops and the score / combo / accuracy count up.
  [...grid.querySelectorAll(".res-card")].forEach((card, i) => {
    const d = data[i];
    const delay = 180 + i * 260;
    const cv = card.querySelector(".res-tri");
    if (cv) resTris.push(triLayer(cv, { count: 8, color: "rgba(255,255,255,.04)", speed: 0.6, maxSize: 110, opacity: 0.7 }));

    const ring = card.querySelector(".grade-ring");
    const fg = ring.querySelector(".ring-fg");
    const accEl = ring.querySelector(".ring-acc");
    const scoreEl = card.querySelector(".res-score");
    const comboEl = card.querySelector(".res-combo");
    const target = RING_C * (1 - d.acc / 100);
    card.querySelectorAll(".j-bar i").forEach(b => resTimers.push(setTimeout(() => b.classList.add("show"), delay + 300)));

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
export function closeResults() { stopResultsFx(); $("results-modal").classList.add("hidden"); $("res-tip").classList.add("hidden"); }
