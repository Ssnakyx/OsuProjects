/* Head-to-head comparison of two replays on the results screen: for every
   note, where each cursor was when the note had to be hit, how far apart the
   two cursors were, and who judged it better. Rendered as a "cursor gap"
   chart (one bar per note), a win tally and the biggest divergences. */

import { S, $, escapeHtml, rgba, clamp, fmtTime, cursorAt, clockRate } from "./core.js";
import { PLAYER_COLORS, JUDGE_COLORS } from "./config.js";

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const JNAME = { 0: "miss", 50: "50", 100: "100", 300: "300" };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const TIE_MS = 3;   // equal judgments closer than this in timing are a draw

let DU = null;                 // current duel data
const CH = { hover: -1, geom: null, onWatch: null };

/* ── data ──────────────────────────────────────────────────────────── */

function judgedByNote(slot) {
  const m = new Map();
  for (const e of S.events[slot].events) {
    const ot = e[12] != null ? e[12] : e[0] - e[7];   // older payloads: press time − error
    m.set(Math.round(ot), e);
  }
  return m;
}

/* +1 if player 0 handled the note better, −1 for player 1, 0 for a draw. */
function winnerOf(e0, e1, rate) {
  const j0 = e0 ? e0[4] : 0, j1 = e1 ? e1[4] : 0;
  if (j0 !== j1) return j0 > j1 ? 1 : -1;
  if (j0 === 0) return 0;
  const a0 = Math.abs(e0[7]) / rate, a1 = Math.abs(e1[7]) / rate;
  if (Math.abs(a0 - a1) < TIE_MS) return 0;
  return a0 < a1 ? 1 : -1;
}

export function buildDuel() {
  if (!(S.replays[0] && S.replays[1] && S.events[0] && S.events[1] && S.map)) { DU = null; return null; }
  const r0 = S.replays[0], r1 = S.replays[1];
  const rate0 = clockRate(r0.mods), rate1 = clockRate(r1.mods);
  const rate = (rate0 + rate1) / 2;
  const m0 = judgedByNote(0), m1 = judgedByNote(1);
  const notes = [];
  let idx = 0;
  for (const o of S.map.objects) {
    if (o.k === "p") continue;
    idx++;
    const key = Math.round(o.t);
    const e0 = m0.get(key), e1 = m1.get(key);
    if (!e0 && !e1) continue;
    const c0 = cursorAt(r0.frames, o.t), c1 = cursorAt(r1.frames, o.t);
    const nx = (e0 || e1)[5], ny = (e0 || e1)[6];
    notes.push({
      n: idx, t: o.t,
      gap: Math.hypot(c1[0] - c0[0], c1[1] - c0[1]),
      off: [Math.hypot(c0[0] - nx, c0[1] - ny), Math.hypot(c1[0] - (e1 ? e1[5] : nx), c1[1] - (e1 ? e1[6] : ny))],
      j: [e0 ? e0[4] : 0, e1 ? e1[4] : 0],
      dt: [e0 && e0[4] ? e0[7] / rate0 : null, e1 && e1[4] ? e1[7] / rate1 : null],
      win: winnerOf(e0, e1, rate),
    });
  }
  if (!notes.length) { DU = null; return null; }
  const gaps = notes.map(n => n.gap).sort((a, b) => a - b);
  const wins = [notes.filter(n => n.win > 0).length, notes.filter(n => n.win < 0).length];
  // "Divergences": notes where the judgments differ, worst first, then the widest gaps.
  const diverge = notes
    .filter(n => n.j[0] !== n.j[1])
    .sort((a, b) => Math.abs(b.j[0] - b.j[1]) - Math.abs(a.j[0] - a.j[1]) || b.gap - a.gap);
  DU = {
    notes, wins, ties: notes.length - wins[0] - wins[1],
    mean: gaps.reduce((s, v) => s + v, 0) / gaps.length,
    median: gaps[Math.floor(gaps.length / 2)],
    p95: gaps[Math.floor(gaps.length * 0.95)] || gaps[gaps.length - 1],
    maxNote: notes.reduce((b, n) => (n.gap > b.gap ? n : b), notes[0]),
    close: notes.filter(n => n.gap <= S.radius).length / notes.length,
    diverge,
    // streak of consecutive notes each player won
    streak: longestStreaks(notes),
  };
  return DU;
}

function longestStreaks(notes) {
  const best = [0, 0];
  let cur = 0, who = 0;
  for (const n of notes) {
    const w = n.win > 0 ? 0 : n.win < 0 ? 1 : -1;
    if (w === -1) { cur = 0; who = -1; continue; }
    if (w === who) cur++; else { who = w; cur = 1; }
    if (cur > best[w]) best[w] = cur;
  }
  return best;
}

/* ── summary + list ────────────────────────────────────────────────── */

const pname = s => escapeHtml(S.replays[s].player);
const jtag = j => `<span class="mj j${j}">${JNAME[j]}</span>`;

export function renderDuel(onWatch) {
  CH.onWatch = onWatch;
  const sec = $("res-duel");
  if (!DU) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const total = DU.notes.length;
  const pct = v => (v / total * 100).toFixed(1);
  $("duel-summary").innerHTML = `
    <div class="duel-bar" title="notes won by each player">
      <i class="p0" style="width:${pct(DU.wins[0])}%"></i><i class="tie" style="width:${pct(DU.ties)}%"></i><i class="p1" style="width:${pct(DU.wins[1])}%"></i>
    </div>
    <div class="duel-tally">
      <div class="dt-side p0"><b>${DU.wins[0]}</b><span>notes won by ${pname(0)}</span><em>best streak ${DU.streak[0]}</em></div>
      <div class="dt-mid"><b>${DU.ties}</b><span>draws</span></div>
      <div class="dt-side p1"><b>${DU.wins[1]}</b><span>notes won by ${pname(1)}</span><em>best streak ${DU.streak[1]}</em></div>
    </div>
    <div class="duel-facts">
      <div><span>Average cursor gap</span><b>${DU.mean.toFixed(1)} px</b></div>
      <div><span>Median gap</span><b>${DU.median.toFixed(1)} px</b></div>
      <div><span>Both inside one circle</span><b>${Math.round(DU.close * 100)}%</b><em>gap ≤ ${Math.round(S.radius)} px</em></div>
      <div><span>Widest gap</span><b>${Math.round(DU.maxNote.gap)} px</b><em>note ${DU.maxNote.n} · ${fmtTime(DU.maxNote.t - S.origin)}</em></div>
    </div>`;

  const rows = DU.diverge.slice(0, 12);
  $("duel-list").innerHTML = rows.length ? rows.map(n => `
    <button class="mrow drow" data-t="${n.t}">
      <span class="mt">${fmtTime(n.t - S.origin)}</span>
      <span class="mn">note ${n.n}</span>
      <span class="dside"><i class="dot p0"></i>${jtag(n.j[0])}</span>
      <span class="dside"><i class="dot p1"></i>${jtag(n.j[1])}</span>
      <span class="md"><b>${Math.round(n.gap)} px</b> apart</span>
      <span class="mgo" aria-hidden="true">›</span>
    </button>`).join("") + (DU.diverge.length > rows.length ? `<div class="mempty">… and ${DU.diverge.length - rows.length} more notes judged differently</div>` : "")
    : `<div class="mempty">Both players got the same judgment on every note.</div>`;
  $("duel-list").querySelectorAll(".drow").forEach(b => b.onclick = () => CH.onWatch && CH.onWatch(+b.dataset.t));
  bindDuelChart();
}

/* ── chart: cursor gap per note ────────────────────────────────────── */

export function drawDuel() {
  const cv = $("duel-chart");
  if (!cv || !DU) return;
  const w = cv.clientWidth, h = cv.clientHeight, d = DPR();
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
  const g = cv.getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);

  const pad = { l: 44, r: 14, t: 10 }, lane = 9, axis = 20;
  const gx0 = pad.l, gx1 = w - pad.r, gy0 = pad.t, gy1 = h - axis - lane * 2 - 12;
  const N = DU.notes.length;
  const X = i => gx0 + (i + .5) / N * (gx1 - gx0);
  const bw = Math.max(1, (gx1 - gx0) / N - (N < 200 ? 1 : 0));
  const top = Math.max(S.radius * 2.2, DU.p95 * 1.15, 20);
  const Y = v => gy1 - clamp(v, 0, top) / top * (gy1 - gy0);
  CH.geom = { gx0, gx1, N };

  const dim = css("--dim") || "#999";
  g.font = `600 10.5px ${css("--font-sans") || "sans-serif"}`;
  g.textAlign = "right"; g.textBaseline = "middle";
  for (const v of [0, Math.round(top / 2), Math.round(top)]) {
    const y = Math.round(Y(v)) + .5;
    g.fillStyle = "rgba(255,255,255,.07)"; g.fillRect(gx0, y, gx1 - gx0, 1);
    g.fillStyle = dim; g.fillText(v + "px", gx0 - 8, y);
  }
  // one circle radius: below it both cursors could be on the same note
  const ry = Math.round(Y(S.radius)) + .5;
  g.strokeStyle = "rgba(255,255,255,.28)"; g.setLineDash([4, 4]); g.lineWidth = 1;
  g.beginPath(); g.moveTo(gx0, ry); g.lineTo(gx1, ry); g.stroke(); g.setLineDash([]);
  g.textAlign = "left"; g.fillStyle = "rgba(255,255,255,.4)"; g.fillText("circle radius", gx0 + 6, ry - 7);

  // bars, coloured by who won the note (grey = draw)
  DU.notes.forEach((n, i) => {
    const col = n.win > 0 ? PLAYER_COLORS[0] : n.win < 0 ? PLAYER_COLORS[1] : [150, 150, 165];
    g.fillStyle = rgba(col, i === CH.hover ? 1 : n.win ? .8 : .45);
    const y = Y(n.gap);
    g.fillRect(X(i) - bw / 2, y, bw, Math.max(1, gy1 - y));
  });

  // judgment lanes (only non-300s are drawn)
  for (const s of [0, 1]) {
    const ly = gy1 + 6 + s * lane;
    g.fillStyle = "rgba(255,255,255,.04)"; g.fillRect(gx0, ly, gx1 - gx0, lane - 2);
    g.fillStyle = rgba(PLAYER_COLORS[s], 1); g.fillRect(gx0 - 6, ly, 3, lane - 2);
    DU.notes.forEach((n, i) => {
      if (n.j[s] === 300) return;
      g.fillStyle = rgba(JUDGE_COLORS[n.j[s]], 1);
      g.fillRect(X(i) - Math.max(1, bw / 2), ly, Math.max(2, bw), lane - 2);
    });
  }

  // x axis: note numbers
  g.textAlign = "center"; g.textBaseline = "top"; g.fillStyle = dim;
  const step = [10, 25, 50, 100, 200, 250, 500, 1000].find(s => N / s <= 8) || 2000;
  for (let k = step; k <= N; k += step) g.fillText("#" + DU.notes[k - 1].n, X(k - 1), h - axis + 6);

  if (CH.hover >= 0) {
    g.fillStyle = "rgba(255,255,255,.55)";
    g.fillRect(Math.round(X(CH.hover)), gy0, 1, h - axis - gy0);
  }
}

let bound = false;
function bindDuelChart() {
  if (bound) return;
  bound = true;
  const cv = $("duel-chart"), tip = $("duel-tip");
  const at = e => {
    if (!CH.geom || !DU) return -1;
    const r = cv.getBoundingClientRect();
    const { gx0, gx1, N } = CH.geom;
    const x = e.clientX - r.left;
    if (x < gx0 - 4 || x > gx1 + 4) return -1;
    return clamp(Math.floor((x - gx0) / (gx1 - gx0) * N), 0, N - 1);
  };
  cv.addEventListener("mousemove", e => {
    const i = at(e);
    if (i < 0) { CH.hover = -1; tip.classList.add("hidden"); drawDuel(); return; }
    CH.hover = i; drawDuel();
    const n = DU.notes[i];
    const side = s => `<div><i style="background:${rgba(PLAYER_COLORS[s], 1)}"></i>${pname(s)}<span>${JNAME[n.j[s]]}${n.dt[s] != null ? ` · ${n.dt[s] >= 0 ? "+" : "−"}${Math.abs(n.dt[s]).toFixed(0)} ms` : ""} · ${Math.round(n.off[s])} px off</span></div>`;
    const who = n.win > 0 ? pname(0) : n.win < 0 ? pname(1) : null;
    tip.innerHTML = `<b>note ${n.n} · ${fmtTime(n.t - S.origin)}</b><em class="jt">${Math.round(n.gap)} px between cursors</em>${side(0)}${side(1)}<small>${who ? `won by ${who}` : "draw"} · click to watch</small>`;
    tip.classList.remove("hidden");
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, tw = tip.offsetWidth;
    tip.style.left = (x + 14 + tw > r.width ? Math.max(4, x - tw - 14) : x + 14) + "px";
  });
  cv.addEventListener("mouseleave", () => { CH.hover = -1; tip.classList.add("hidden"); drawDuel(); });
  cv.addEventListener("click", e => { const i = at(e); if (i >= 0 && CH.onWatch) CH.onWatch(DU.notes[i].t); });
}
