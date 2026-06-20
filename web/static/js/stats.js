/* Scoreboard read-outs: unstable rate, rough pp, the hit-distribution
   histogram panel, and the top HUD per-frame update. */

import { $, S, OPT, clamp, rgba, upperBound, adjDifficulty, fmtTime } from "./core.js";
import { PLAYER_COLORS, JUDGE_COLORS } from "./config.js";

/* ── precomputed cumulative sums (for unstable rate) ───────────────── */

export function prepStats(slot) {
  const ed = S.events[slot];
  if (!ed || ed._prepped) return;
  const evs = ed.events, n = evs.length;
  ed.cN = new Float64Array(n); ed.cS = new Float64Array(n); ed.cQ = new Float64Array(n);
  let cn = 0, cs = 0, cq = 0;
  for (let i = 0; i < n; i++) {
    if (evs[i][4] > 0) { const dt = evs[i][7]; cn++; cs += dt; cq += dt * dt; }
    ed.cN[i] = cn; ed.cS[i] = cs; ed.cQ[i] = cq;
  }
  ed._prepped = true;
}

export function urAt(slot, t) {
  const ed = S.events[slot];
  if (!ed || !ed._prepped) return 0;
  const idx = upperBound(ed.events, t) - 1;
  if (idx < 0) return 0;
  const n = ed.cN[idx];
  if (n < 2) return 0;
  const mean = ed.cS[idx] / n;
  const variance = ed.cQ[idx] / n - mean * mean;
  return Math.sqrt(Math.max(0, variance)) * 10;
}

/* Deliberately a rough proxy — not official pp (needs full star-rating). */
export function ppAt(slot, t) {
  const ed = S.events[slot];
  if (!ed || !S.map) return 0;
  const idx = upperBound(ed.events, t) - 1;
  if (idx < 0) return 0;
  const ev = ed.events[idx];
  const hits = ev[8] + ev[9] + ev[10] + ev[11];
  if (!hits) return 0;
  const acc = ev[3] / 100, combo = ev[2], nmiss = ev[11];
  const total = S.map.objects.length || 1;
  const [, ar, od] = adjDifficulty(S.map.cs, S.map.ar, S.map.od, S.replays[slot].mods);
  let strain = Math.pow(total, 0.62) * 0.09;
  strain *= 1 + Math.max(0, ar - 9) * 0.30 + (ar < 8 ? (8 - ar) * 0.02 : 0);
  strain *= 1 + Math.max(0, od - 8) * 0.04;
  const accScale = Math.pow(acc, 11);
  const comboScale = Math.pow(Math.min(combo, total) / total, 0.8);
  const missPen = Math.pow(0.96, nmiss);
  return strain * 100 * accScale * comboScale * missPen;
}

/* ── top HUD ───────────────────────────────────────────────────────── */

export function updateHUD() {
  if (!S.map) return;
  const cs = Math.abs(S.t / 1000);
  $("clock").textContent = `${S.t < 0 ? "-" : ""}${String(Math.floor(cs / 60)).padStart(2, "0")}:${(cs % 60).toFixed(2).padStart(5, "0")}`;

  for (const slot of [0, 1]) {
    if (!S.replays[slot] || !S.events[slot]) continue;
    const evs = S.events[slot].events;
    const i = upperBound(evs, S.t) - 1;
    const ev = i >= 0 ? evs[i] : null;
    $(`p${slot}-score`).textContent = (ev ? ev[1] : 0).toLocaleString("en-US");
    $(`p${slot}-combo`).textContent = (ev ? ev[2] : 0) + "×";
    $(`p${slot}-acc`).textContent = (ev ? ev[3] : 100).toFixed(2) + "%";
    $(`n300_${slot}`).textContent = ev ? ev[8] : 0;
    $(`n100_${slot}`).textContent = ev ? ev[9] : 0;
    $(`n50_${slot}`).textContent  = ev ? ev[10] : 0;
    $(`nx_${slot}`).textContent   = ev ? ev[11] : 0;
    $(`p${slot}-ur-box`).hidden = !OPT.showUR;
    $(`p${slot}-pp-box`).hidden = !OPT.showPP;
    if (OPT.showUR) $(`p${slot}-ur`).textContent = urAt(slot, S.t).toFixed(0);
    if (OPT.showPP) $(`p${slot}-pp`).textContent = "≈" + Math.round(ppAt(slot, S.t));
  }
  updateLead();

  const frac = clamp((S.t - S.origin) / (S.endT - S.origin), 0, 1);
  if (!S.seeking) $("seek").value = Math.round(frac * 1000);
  $("seek-fill").style.width = frac * 100 + "%";
  $("seek-thumb").style.left = frac * 100 + "%";
  $("time-cur").textContent = fmtTime(S.t - S.origin);
  $("time-dur").textContent = fmtTime(S.endT - S.origin);

  const first = S.map.objects.length ? S.map.objects[0].t : 0;
  $("btn-skip").classList.toggle("hidden", !(S.t < first - S.preempt - 1000 && S.playing));

  $("state-line").textContent =
    !S.playing && S.t < S.endT ? "PAUSED"
    : S.audioBlocked ? "click anywhere to enable audio" : "";
}

/* ── lead meter (centre column, two-replay comparison only) ────────── */

function scoreAt(slot) {
  const ed = S.events[slot];
  if (!ed) return 0;
  const i = upperBound(ed.events, S.t) - 1;
  return i >= 0 ? ed.events[i][1] : 0;
}

function updateLead() {
  const lead = $("lead");
  if (!(S.replays[0] && S.replays[1] && S.events[0] && S.events[1])) {
    lead.hidden = true;
    return;
  }
  lead.hidden = false;
  const s0 = scoreAt(0), s1 = scoreAt(1);
  const share = s0 / (s0 + s1 || 1);   // P1's share of the total, filled from the left
  $("lead-fill").style.width = share * 100 + "%";
  $("lead-mark").style.left = share * 100 + "%";

  const diff = s0 - s1;
  const gap = $("lead-gap");
  if (Math.abs(diff) < 400) {
    gap.textContent = "dead even"; gap.className = "gap";
  } else if (diff > 0) {
    gap.textContent = `${S.replays[0].player} +${Math.round(diff).toLocaleString("en-US")}`;
    gap.className = "gap p0";
  } else {
    gap.textContent = `${S.replays[1].player} +${Math.round(-diff).toLocaleString("en-US")}`;
    gap.className = "gap p1";
  }
}

/* ── hit-distribution histogram panel ──────────────────────────────── */

export function drawStats() {
  const hist = $("hist");
  const dpr = window.devicePixelRatio || 1;
  const w = hist.clientWidth, h = hist.clientHeight;
  if (hist.width !== Math.round(w * dpr)) { hist.width = Math.round(w * dpr); hist.height = Math.round(h * dpr); }
  const g = hist.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const ed = S.events[0] || S.events[1];
  if (!ed) return;
  const w50 = ed.windows[2];
  const BINS = 31, bins = new Array(BINS).fill(0);
  const slots = [0, 1].filter(s => S.events[s]);
  let maxc = 1;
  const perSlot = slots.map(() => new Array(BINS).fill(0));
  slots.forEach((slot, si) => {
    const evs = S.events[slot].events;
    const idx = upperBound(evs, S.t);
    for (let i = 0; i < idx; i++) {
      if (evs[i][4] <= 0) continue;
      const b = clamp(Math.round((evs[i][7] / w50 + 1) / 2 * (BINS - 1)), 0, BINS - 1);
      perSlot[si][b]++; bins[b]++;
    }
  });
  maxc = Math.max(1, ...bins);

  // window zones
  const cx = w / 2;
  const zoneW = ms => (w / 2) * Math.min(1, ms / w50);
  const zoneCol = (ms, col, a) => { g.fillStyle = rgba(col, a); g.fillRect(cx - zoneW(ms), 0, zoneW(ms) * 2, h); };
  zoneCol(w50, JUDGE_COLORS[50], .10); zoneCol(ed.windows[1], JUDGE_COLORS[100], .12); zoneCol(ed.windows[0], JUDGE_COLORS[300], .16);

  const bw = w / BINS;
  perSlot.forEach((arr, si) => {
    g.fillStyle = rgba(PLAYER_COLORS[slots[si]], .85);
    for (let b = 0; b < BINS; b++) {
      const bh = (arr[b] / maxc) * (h - 6);
      g.fillRect(b * bw + 1, h - bh, bw - 2, bh);
    }
  });
  g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1;
  g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h); g.stroke();

  // rows
  const rows = [];
  for (const slot of slots) {
    const evs = S.events[slot].events;
    const i = upperBound(evs, S.t) - 1;
    const ev = i >= 0 ? evs[i] : null;
    const name = S.replays[slot].player;
    rows.push(`<div class="stats-row"><span style="color:${rgba(PLAYER_COLORS[slot], 1)}">${name}</span><span></span></div>`);
    if (ev) {
      rows.push(`<div class="stats-row"><span>300 / 100 / 50 / ✕</span><span>${ev[8]} / ${ev[9]} / ${ev[10]} / ${ev[11]}</span></div>`);
      rows.push(`<div class="stats-row"><span>Accuracy</span><span>${ev[3].toFixed(2)}%</span></div>`);
      rows.push(`<div class="stats-row"><span>Combo</span><span>${ev[2]}x</span></div>`);
      rows.push(`<div class="stats-row"><span>Unstable rate</span><span>${urAt(slot, S.t).toFixed(1)}</span></div>`);
      rows.push(`<div class="stats-row"><span>pp (rough)</span><span>≈${Math.round(ppAt(slot, S.t))}</span></div>`);
    }
  }
  $("stats-rows").innerHTML = rows.join("");
}
