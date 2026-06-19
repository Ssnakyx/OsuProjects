/* Canvas rendering: playfield, hit objects, sliders, cursors, judgments,
   hit-error bar and key overlay. `draw()` is called once per animation frame. */

import {
  $, rgba, clamp, S, SKIN, OPT, canvas, ctx, upperBound, cursorAt, keysAt,
} from "./core.js";
import {
  PLAYER_COLORS, JUDGE_COLORS, HIT_LINGER, JUDGE_POPUP_MS, ERRORBAR_MS, CURSOR_SKIN_SCALE,
} from "./config.js";
import { sprite } from "./skin.js";

/* ── slider geometry ───────────────────────────────────────────────── */

export function prepareSliders() {
  for (const o of S.map.objects) {
    if (o.k !== "s" || !o.path || o.path.length < 2) continue;
    const pre = [0]; let acc = 0;
    for (let i = 1; i < o.path.length; i++) {
      acc += Math.hypot(o.path[i][0] - o.path[i - 1][0], o.path[i][1] - o.path[i - 1][1]);
      pre.push(acc);
    }
    o.plen = pre; o.ptotal = acc;
  }
}

function pathAt(o, t01) {
  const pts = o.path, pre = o.plen;
  if (!pts || !pts.length) return [o.x, o.y];
  if (t01 <= 0 || !o.ptotal) return pts[0];
  if (t01 >= 1) return pts[pts.length - 1];
  const target = t01 * o.ptotal;
  let lo = 0, hi = pre.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (pre[mid] <= target) lo = mid; else hi = mid; }
  const seg = pre[hi] - pre[lo] || 1;
  const s = (target - pre[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * s, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * s];
}

/* ── viewport / transforms ─────────────────────────────────────────── */

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}

function fieldTransform(rect) {
  const s = Math.min(rect.w / 512, rect.h / 384) * 0.92;
  return { s, ox: rect.x + (rect.w - 512 * s) / 2, oy: rect.y + (rect.h - 384 * s) / 2 };
}
const tx = (tr, x) => tr.ox + x * tr.s;
const ty = (tr, y) => tr.oy + y * tr.s;

function objectAlpha(dt) {
  const FADE = 400;
  if (dt > S.preempt) return 0;
  if (dt > S.preempt - FADE) return (S.preempt - dt) / FADE;     // fade in
  if (dt >= 0) return 1;
  if (dt >= -HIT_LINGER) return 1 + dt / HIT_LINGER;              // fade out after hit
  return 0;
}

function activeFields(w, h) {
  const both = S.replays[0] && S.replays[1];
  if (S.mode === "split" && both) {
    return [
      { rect: { x: 0, y: 0, w: w / 2 - 1, h }, players: [0] },
      { rect: { x: w / 2 + 1, y: 0, w: w / 2 - 1, h }, players: [1] },
    ];
  }
  return [{ rect: { x: 0, y: 0, w, h }, players: [0, 1].filter(i => S.replays[i]) }];
}

/* ── top-level draw ────────────────────────────────────────────────── */

export function draw() {
  const [w, h] = fitCanvas();
  ctx.clearRect(0, 0, w, h);
  if (!S.map) return;
  const fields = activeFields(w, h);
  if (fields.length === 2) {
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  }
  for (const f of fields) drawField(f);
  if (OPT.showErrorBar) drawErrorBar(w, h);
}

function drawField(f) {
  const tr = fieldTransform(f.rect);
  const r = Math.max(4, S.radius * tr.s);

  if (OPT.showBorder) {
    ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.lineWidth = 1;
    roundRect(tx(tr, 0) - 10, ty(tr, 0) - 10, 512 * tr.s + 20, 384 * tr.s + 20, 8);
    ctx.stroke();
  }

  const t = S.t, vis = [];
  for (const o of S.map.objects) {
    const end = o.k === "s" ? o.t + o.dur : o.k === "p" ? o.end : o.t;
    if (o.t - S.preempt <= t && t <= end + HIT_LINGER) vis.push(o);
  }

  for (let i = vis.length - 1; i >= 0; i--) if (vis[i].k === "s") drawSlider(vis[i], tr, r);
  for (let i = vis.length - 1; i >= 0; i--) {
    if (vis[i].k === "c") drawCircle(vis[i], tr, r);
    else if (vis[i].k === "p") drawSpinner(vis[i], tr);
  }

  if (OPT.showJudgments) for (const p of f.players) drawJudgments(p, tr, f.players.length);
  for (const p of f.players) drawCursor(p, tr, f.rect);
  if (OPT.showKeys) drawKeyOverlay(f);
}

function roundRect(x, y, w, h, rad) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
  ctx.rect(x, y, w, h);
}

/* ── hit objects ───────────────────────────────────────────────────── */

function drawCircleShape(x, y, r, color, alpha) {
  const base = sprite("hitcircle", r * 2, color);
  if (base) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(base, x - base.width / 2, y - base.height / 2);
    const ov = sprite("hitcircleoverlay", r * 2, null);
    if (ov) ctx.drawImage(ov, x - ov.width / 2, y - ov.height / 2);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color.map(c => c * .5), alpha); ctx.fill();
  ctx.lineWidth = Math.max(2, r / 4.6); ctx.strokeStyle = rgba(color, alpha); ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = rgba([255, 255, 255], alpha); ctx.stroke();
}

function drawComboNumber(o, x, y, r, alpha) {
  if (!OPT.showNumbers) return;
  ctx.fillStyle = rgba([255, 255, 255], alpha);
  ctx.font = `700 ${Math.max(9, r * .85)}px Inter, -apple-system, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(o.cn), x, y + 1);
}

function drawApproach(x, y, ar, color, alpha) {
  if (!OPT.showApproach || ar > 1100) return;
  const img = sprite("approachcircle", Math.max(8, Math.round(ar * 2 / 6) * 6), color);
  if (img) { ctx.globalAlpha = alpha * .95; ctx.drawImage(img, x - img.width / 2, y - img.height / 2); ctx.globalAlpha = 1; return; }
  ctx.beginPath(); ctx.arc(x, y, ar, 0, Math.PI * 2);
  ctx.lineWidth = 2.5; ctx.strokeStyle = rgba(color, alpha * .9); ctx.stroke();
}

function drawCircle(o, tr, r) {
  const dt = o.t - S.t;
  if (dt < -HIT_LINGER) return;
  const alpha = objectAlpha(dt);
  const color = SKIN.palette[o.ci % SKIN.palette.length];
  const x = tx(tr, o.x), y = ty(tr, o.y);
  drawCircleShape(x, y, r, color, alpha);
  drawComboNumber(o, x, y, r, alpha);
  if (dt > 0) drawApproach(x, y, r * (1 + 3 * dt / S.preempt), color, alpha);
}

function drawSlider(o, tr, r) {
  if (!o.path || o.path.length < 2) return;
  const dt = o.t - S.t;
  const endT = o.t + o.dur;
  const alpha = objectAlpha(dt);
  const color = SKIN.palette[o.ci % SKIN.palette.length];

  // snaking: body extends as the object approaches its hit time
  let endFrac = 1;
  if (OPT.snaking && dt > 0) endFrac = clamp(1 - dt / Math.max(1, S.preempt * 0.7), 0, 1);

  ctx.lineCap = "round"; ctx.lineJoin = "round";
  const buildPath = () => {
    ctx.beginPath();
    ctx.moveTo(tx(tr, o.path[0][0]), ty(tr, o.path[0][1]));
    if (endFrac >= 1) {
      for (let i = 1; i < o.path.length; i++) ctx.lineTo(tx(tr, o.path[i][0]), ty(tr, o.path[i][1]));
    } else {
      const target = endFrac * o.ptotal;
      for (let i = 1; i < o.path.length; i++) {
        if (o.plen[i] <= target) { ctx.lineTo(tx(tr, o.path[i][0]), ty(tr, o.path[i][1])); }
        else { const [ex, ey] = pathAt(o, endFrac); ctx.lineTo(tx(tr, ex), ty(tr, ey)); break; }
      }
    }
  };
  buildPath(); ctx.lineWidth = r * 2; ctx.strokeStyle = rgba(SKIN.sliderBorder || [255, 255, 255], alpha * .8); ctx.stroke();
  buildPath(); ctx.lineWidth = Math.max(1, r * 2 - 7); ctx.strokeStyle = rgba(SKIN.sliderTrack || [38, 37, 56], alpha * .94); ctx.stroke();

  const tailPt = o.slides % 2 === 0 ? o.path[0] : o.path[o.path.length - 1];
  drawCircleShape(tx(tr, tailPt[0]), ty(tr, tailPt[1]), r, color, alpha);
  const hx = tx(tr, o.x), hy = ty(tr, o.y);
  drawCircleShape(hx, hy, r, color, alpha);
  drawComboNumber(o, hx, hy, r, alpha);
  if (dt > 0) drawApproach(hx, hy, r * (1 + 3 * dt / S.preempt), color, alpha);

  if (S.t >= o.t && S.t <= endT && o.slides > 0) {
    const span = o.dur / o.slides;
    let prog = (S.t - o.t) / span;
    const slide = Math.floor(prog);
    let tt = prog - slide;
    if (slide % 2 === 1) tt = 1 - tt;
    const [bx, by] = pathAt(o, clamp(tt, 0, 1));
    const bsx = tx(tr, bx), bsy = ty(tr, by);
    const follow = sprite("sliderfollowcircle", r * 2 * 1.6, null);
    if (follow) {
      ctx.beginPath(); ctx.arc(bsx, bsy, Math.max(2, r * .45), 0, Math.PI * 2); ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fill();
      ctx.drawImage(follow, bsx - follow.width / 2, bsy - follow.height / 2);
    } else {
      ctx.beginPath(); ctx.arc(bsx, bsy, r * 1.35, 0, Math.PI * 2); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke();
      ctx.beginPath(); ctx.arc(bsx, bsy, r * .82, 0, Math.PI * 2); ctx.fillStyle = rgba(color, 1); ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }
}

function drawSpinner(o, tr) {
  const t = S.t;
  const cx = tx(tr, 256), cy = ty(tr, 192);
  const maxR = 190 * tr.s;
  let innerR;
  if (t >= o.t && t <= o.end) innerR = maxR * (1 - (t - o.t) / Math.max(1, o.end - o.t));
  else if (t < o.t) innerR = maxR;
  else return;
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(200,200,210,.8)";
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.stroke();
  if (innerR > 2) {
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.stroke();
  }
}

/* ── cursors ───────────────────────────────────────────────────────── */

function drawCursor(p, tr, rect) {
  const frames = S.replays[p].frames;
  const color = PLAYER_COLORS[p];
  const tint = (S.replays[0] && S.replays[1]) ? color : null;
  const cMul = OPT.cursorScale / 100, tMul = OPT.trail / 100;

  if (SKIN.el.cursor) {
    const pxOf = name => { const e = SKIN.el[name]; return Math.max(8, (e.w / e.scale) * (rect.h / 768) * CURSOR_SKIN_SCALE * cMul); };
    const trailImg = (tMul > 0 && SKIN.el.cursortrail) ? sprite("cursortrail", pxOf("cursortrail"), tint) : null;
    if (trailImg) {
      const N = Math.round(14 * tMul);
      for (let k = N; k > 0; k--) {
        const [cx0, cy0] = cursorAt(frames, S.t - k * 9);
        ctx.globalAlpha = .62 * Math.pow(1 - k / N, 1.4);
        ctx.drawImage(trailImg, tx(tr, cx0) - trailImg.width / 2, ty(tr, cy0) - trailImg.height / 2);
      }
      ctx.globalAlpha = 1;
    }
    const cur = sprite("cursor", pxOf("cursor"), tint);
    if (cur) {
      const [cx0, cy0] = cursorAt(frames, S.t);
      ctx.drawImage(cur, tx(tr, cx0) - cur.width / 2, ty(tr, cy0) - cur.height / 2);
      return;
    }
  }

  const TRAIL = Math.round(26 * tMul);
  for (let k = TRAIL; k > 0; k--) {
    const [px, py] = cursorAt(frames, S.t - k * 10);
    const frac = k / TRAIL;
    ctx.beginPath();
    ctx.arc(tx(tr, px), ty(tr, py), Math.max(1, 9 * tr.s * 1.45 * frac * .5 * cMul), 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, Math.pow(1 - frac, .35) * .35); ctx.fill();
  }
  const [px, py] = cursorAt(frames, S.t);
  const x = tx(tr, px), y = ty(tr, py);
  const cr = Math.max(5, 9 * tr.s * 1.45 * cMul);
  ctx.save();
  ctx.shadowColor = rgba(color, .9); ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2); ctx.fillStyle = rgba(color, 1); ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2; ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
}

/* ── judgments / error bar / keys ──────────────────────────────────── */

function eventsWindow(slot, windowMs) {
  const ed = S.events[slot];
  if (!ed) return [];
  const evs = ed.events;
  const hi = upperBound(evs, S.t);
  const out = [];
  for (let i = hi - 1; i >= 0; i--) { if (S.t - evs[i][0] > windowMs) break; out.push(evs[i]); }
  return out;
}

function drawJudgments(slot, tr, nPlayers) {
  for (const ev of eventsWindow(slot, JUDGE_POPUP_MS)) {
    const judg = ev[4];
    if (judg === 300 && !OPT.show300) continue;
    const life = clamp((S.t - ev[0]) / JUDGE_POPUP_MS, 0, 1);
    const alpha = 1 - Math.pow(life, 1.5);
    const color = JUDGE_COLORS[judg];
    let x = tx(tr, ev[5]), y = ty(tr, ev[6]) - 10 * life;
    if (nPlayers === 2) x += slot === 0 ? -14 : 14;
    ctx.font = `800 ${judg === 0 ? 19 : 15}px Inter, -apple-system, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(color, alpha);
    ctx.fillText(judg === 0 ? "✕" : String(judg), x, y);
  }
}

function drawErrorBar(w, h) {
  const e0 = S.events[0] || S.events[1];
  if (!e0) return;
  const [w300, w100, w50] = e0.windows;
  const barW = Math.min(260, w * .3), barH = 6;
  const cx = w / 2, by = h - 18;
  const zone = (ms, color, a) => { const half = barW / 2 * Math.min(1, ms / w50); ctx.fillStyle = rgba(color, a); ctx.fillRect(cx - half, by, half * 2, barH); };
  zone(w50, JUDGE_COLORS[50], .30); zone(w100, JUDGE_COLORS[100], .35); zone(w300, JUDGE_COLORS[300], .45);
  ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fillRect(cx - .5, by - 3, 1, barH + 6);
  for (const slot of [0, 1]) {
    if (!S.events[slot]) continue;
    for (const ev of eventsWindow(slot, ERRORBAR_MS)) {
      if (ev[4] <= 0) continue;
      const age = (S.t - ev[0]) / ERRORBAR_MS;
      const off = clamp(ev[7] / w50, -1, 1);
      ctx.fillStyle = rgba(PLAYER_COLORS[slot], .85 * (1 - age));
      ctx.fillRect(cx + off * barW / 2 - 1, slot === 0 ? by - 8 : by + barH + 2, 2, 6);
    }
  }
}

function drawKeyOverlay(f) {
  const box = 24, gap = 5;
  for (const p of f.players) {
    const keys = keysAt(S.replays[p].frames, S.t);
    const k1 = !!(keys & 4), k2 = !!(keys & 8);
    const states = [["K1", k1], ["K2", k2], ["M1", !!(keys & 1) && !k1], ["M2", !!(keys & 2) && !k2]];
    const right = p === 0 || S.mode === "split";
    const x = right ? f.rect.x + f.rect.w - box - 10 : f.rect.x + 10;
    let y = f.rect.y + f.rect.h / 2 - (4 * box + 3 * gap) / 2;
    const color = PLAYER_COLORS[p];
    for (const [lbl, on] of states) {
      ctx.fillStyle = on ? rgba(color, .9) : "rgba(255,255,255,.06)";
      roundRect(x, y, box, box, 6); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = on ? rgba(color, 1) : "rgba(255,255,255,.18)";
      roundRect(x, y, box, box, 6); ctx.stroke();
      ctx.font = "700 10px Inter, -apple-system, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = on ? "#15141f" : "rgba(255,255,255,.4)";
      ctx.fillText(lbl, x + box / 2, y + box / 2 + .5);
      y += box + gap;
    }
  }
}
