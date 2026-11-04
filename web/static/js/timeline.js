/* Enriched seek bar: hard sections (a heat band built from note density and
   spacing), every miss / 50 marked on the track, a hover preview, and the
   "jump to previous / next miss" and "step one note" helpers. */

import { $, S, OPT, rgba, clamp, fmtTime, clockRate } from "./core.js";
import { PLAYER_COLORS, JUDGE_COLORS } from "./config.js";

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const HEAT = [255, 150, 70];

/* Cached per-session data: rebuilt by `prepareTimeline()` on enterPlayer. */
const TLD = { heat: [], marks: [], key: "" };

/* ── difficulty heat ───────────────────────────────────────────────── *
 * A rough osu!-style strain: each note adds a speed term (notes per second)
 * and an aim term (distance / time), the running strain decays over time.
 * We keep the peak strain per bin and normalise against a high percentile,
 * so the band lights up on the streams, jumps and bursts of *this* map. */
function computeHeat(nBins) {
  const objs = (S.map && S.map.objects || []).filter(o => o.k !== "p");
  const bins = new Array(nBins).fill(0);
  if (objs.length < 2) return bins;
  const lead = S.replays[0] || S.replays[1];
  const rate = lead ? clockRate(lead.mods) : 1;
  const span = S.endT - S.origin || 1;
  let strain = 0;
  for (let i = 1; i < objs.length; i++) {
    const a = objs[i - 1], b = objs[i];
    const dt = Math.max(30, (b.t - a.t) / rate);           // real-time ms
    const dist = Math.hypot(b.x - a.x, b.y - a.y) / (S.radius * 2 || 64);
    const add = 1000 / dt * 0.55 + dist * 1000 / dt * 0.45;
    strain = strain * Math.pow(0.3, dt / 1000) + add;
    const bin = clamp(Math.floor((b.t - S.origin) / span * nBins), 0, nBins - 1);
    if (strain > bins[bin]) bins[bin] = strain;
  }
  const sorted = bins.filter(v => v > 0).sort((x, y) => x - y);
  const ref = sorted[Math.floor(sorted.length * 0.97)] || 1;
  const floor = sorted[Math.floor(sorted.length * 0.55)] || 0;
  // light smoothing so single notes don't flicker
  const out = bins.map((v, i) => (v + (bins[i - 1] ?? v) * .5 + (bins[i + 1] ?? v) * .5) / 2);
  return out.map(v => clamp((v - floor) / (ref - floor || 1), 0, 1));
}

/* Misses (and 50s) for every loaded replay, in song time. */
function collectMarks() {
  const marks = [];
  for (const slot of [0, 1]) {
    const ed = S.events[slot];
    if (!S.replays[slot] || !ed) continue;
    for (const e of ed.events) if (e[4] === 0 || e[4] === 50) marks.push({ t: e[0], j: e[4], slot, ot: e[12] ?? e[0] });
  }
  return marks.sort((a, b) => a.t - b.t);
}

export function prepareTimeline() {
  TLD.heat = computeHeat(240);
  TLD.marks = collectMarks();
  TLD.key = "";
  const n = TLD.marks.filter(m => m.j === 0).length;
  $("btn-miss-prev").disabled = $("btn-miss-next").disabled = !n;
  $("btn-miss-prev").title = n ? "Previous miss ([)" : "No misses";
  $("btn-miss-next").title = n ? "Next miss (])" : "No misses";
}

/* ── drawing the track overlay ─────────────────────────────────────── */

export function drawTimeline() {
  const cv = $("seek-marks");
  if (!cv || !S.map) return;
  const w = cv.clientWidth, h = cv.clientHeight, d = DPR();
  const key = `${w}x${h}@${d}|${OPT.seekHeat}|${OPT.seekMarks}|${TLD.marks.length}|${S.endT}`;
  if (key === TLD.key) return;          // static: only redraw on resize / data change
  TLD.key = key;
  cv.width = Math.round(w * d); cv.height = Math.round(h * d);
  const g = cv.getContext("2d");
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  const mid = h / 2, span = S.endT - S.origin || 1;
  const X = t => clamp((t - S.origin) / span, 0, 1) * w;

  if (OPT.seekHeat) {
    const n = TLD.heat.length, bw = w / n;
    for (let i = 0; i < n; i++) {
      const v = TLD.heat[i];
      if (v < 0.08) continue;
      const hh = 4 + v * 8;
      g.fillStyle = rgba(HEAT, 0.12 + v * 0.5);
      g.fillRect(i * bw, mid - hh / 2, bw + .5, hh);
    }
  }
  if (OPT.seekMarks) {
    const duo = !!(S.replays[0] && S.replays[1]);
    for (const m of TLD.marks) {
      const x = Math.round(X(m.t));
      if (m.j === 50) {
        g.fillStyle = rgba(JUDGE_COLORS[50], .8);
        const y = duo ? (m.slot ? mid + 3 : mid - 6) : mid - 4;
        g.fillRect(x, y, 1.5, duo ? 3 : 8);
        continue;
      }
      // miss: red tick, with a player-coloured cap when two replays are loaded
      g.fillStyle = rgba(JUDGE_COLORS[0], 1);
      if (duo) {
        const y0 = m.slot ? mid : mid - 10;
        g.fillRect(x - 1, y0, 2, 10);
        g.fillStyle = rgba(PLAYER_COLORS[m.slot], 1);
        g.fillRect(x - 1, m.slot ? mid + 9 : mid - 11, 2, 2);
      } else {
        g.fillRect(x - 1, mid - 8, 2, 16);
      }
    }
  }
}

/* ── hover preview ─────────────────────────────────────────────────── */

const JNAME = { 0: "miss", 50: "50" };
export function bindSeekHover() {
  const track = $("seek-track"), tip = $("seek-tip");
  track.addEventListener("pointermove", e => {
    if (!S.map) return;
    const r = track.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / r.width, 0, 1);
    const t = S.origin + f * (S.endT - S.origin);
    const tol = (S.endT - S.origin) / r.width * 5;
    let near = null, bd = tol;
    for (const m of TLD.marks) { const dd = Math.abs(m.t - t); if (dd <= bd && (m.j === 0 || !near || near.j !== 0)) { bd = dd; near = m; } }
    const heat = TLD.heat.length ? TLD.heat[clamp(Math.floor(f * TLD.heat.length), 0, TLD.heat.length - 1)] : 0;
    let html = `<b>${fmtTime((near ? near.t : t) - S.origin)}</b>`;
    if (near) html += `<em class="j${near.j}">${JNAME[near.j]}${S.replays[0] && S.replays[1] ? " · " + escape(S.replays[near.slot].player) : ""}</em>`;
    else if (OPT.seekHeat && heat > .6) html += `<em class="hot">hard section</em>`;
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    tip.style.left = (f * 100) + "%";
  });
  track.addEventListener("pointerleave", () => tip.classList.add("hidden"));
  window.addEventListener("resize", () => { TLD.key = ""; });
}
const escape = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── navigation helpers ────────────────────────────────────────────── */

/* Time to seek to so the moment `ot` (a note's time) is about to happen. */
const lookAhead = ot => ot - Math.max(600, S.preempt + 250);

/* Next / previous miss after or before the current position. Lands just
   before the note so you see it approach; playback state is kept. */
export function missTarget(dir) {
  const misses = TLD.marks.filter(m => m.j === 0);
  if (!misses.length) return null;
  const here = S.t, eps = 30;
  if (dir > 0) {
    const m = misses.find(m => lookAhead(m.ot) > here + eps);
    return m ? lookAhead(m.ot) : null;
  }
  for (let i = misses.length - 1; i >= 0; i--) if (lookAhead(misses[i].ot) < here - eps) return lookAhead(misses[i].ot);
  return null;
}

/* Exact time of the next / previous hit object (frame-accurate note stepping). */
export function noteTarget(dir) {
  const objs = S.map ? S.map.objects : [];
  if (!objs.length) return null;
  const here = S.t, eps = 0.5;
  if (dir > 0) { const o = objs.find(o => o.t > here + eps); return o ? o.t : null; }
  for (let i = objs.length - 1; i >= 0; i--) if (objs[i].t < here - eps) return objs[i].t;
  return null;
}
