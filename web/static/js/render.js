/* Canvas rendering: playfield, hit objects, sliders, follow points, cursors,
   judgments, hit-error bar and key overlay. `draw()` runs once per frame.

   Everything is drawn in the *unflipped* playfield (Hard Rock replays are
   un-flipped when parsed), with stacking applied like osu! does. When a skin
   is loaded its sprites are used; anything the skin lacks falls back to the
   built-in vector style, and anything the skin hides (1×1 image) stays hidden. */

import {
  rgba, clamp, S, SKIN, OPT, canvas, ctx, upperBound, cursorAt, keysAt, frameIndexAt,
} from "./core.js";
import {
  PLAYER_COLORS, JUDGE_COLORS, JUDGE_POPUP_MS, ERRORBAR_MS,
} from "./config.js";
import { skinState, drawEl, drawDigits, frameOf } from "./skin.js";

const skinOn = () => SKIN.present && OPT.useSkin;
const has = name => skinOn() && skinState(name) === "img";
const hidden = name => skinOn() && skinState(name) === "hidden";
const palette = () => (skinOn() && SKIN.colors.length ? SKIN.colors : S.basePalette);
const comboColor = o => { const p = palette(); return p[o.ci % p.length]; };

/* ── map preparation (stacking, slider geometry, follow points) ───── */

function endPos(o) {
  if (o.k === "s" && o.path && o.path.length) return o.slides % 2 === 1 ? o.path[o.path.length - 1] : o.path[0];
  return [o.x, o.y];
}
const endTime = o => o.k === "s" ? o.t + o.dur : o.k === "p" ? o.end : o.t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* osu! stacking (format v6+) — same algorithm as src/beatmap.py. */
function stackHeights(objs, preempt, leniency) {
  const h = new Array(objs.length).fill(0);
  const threshold = preempt * leniency, SD = 3;
  for (let i = objs.length - 1; i > 0; i--) {
    let n = i, ii = i;
    if (h[ii] !== 0 || objs[ii].k === "p") continue;
    if (objs[ii].k === "s") {
      while (--n >= 0) {
        const on = objs[n];
        if (on.k === "p") continue;
        if (objs[ii].t - on.t > threshold) break;
        if (dist(endPos(on), [objs[ii].x, objs[ii].y]) < SD) { h[n] = h[ii] + 1; ii = n; }
      }
    } else {
      while (--n >= 0) {
        const on = objs[n];
        if (on.k === "p") continue;
        if (objs[ii].t - endTime(on) > threshold) break;
        if (on.k === "s" && dist(endPos(on), [objs[ii].x, objs[ii].y]) < SD) {
          const off = h[ii] - h[n] + 1;
          for (let j = n + 1; j <= i; j++) if (dist(endPos(on), [objs[j].x, objs[j].y]) < SD) h[j] -= off;
          break;
        }
        if (dist([on.x, on.y], [objs[ii].x, objs[ii].y]) < SD) { h[n] = h[ii] + 1; ii = n; }
      }
    }
  }
  return h;
}

export function prepareMap() {
  const objs = S.map.objects;
  const fv = S.map.formatVersion || 14;
  const heights = fv >= 6 ? stackHeights(objs, S.preempt, S.map.stackLeniency ?? 0.7) : objs.map(() => 0);
  objs.forEach((o, i) => {
    const off = -heights[i] * S.radius / 10;
    const ox = off, oy = S.hr ? -off : off;
    o.sx = o.x + ox; o.sy = o.y + oy;
    if (o.k === "s" && o.path && o.path.length >= 2) {
      o.spath = o.path.map(p => [p[0] + ox, p[1] + oy]);
      const pre = [0]; let acc = 0;
      for (let k = 1; k < o.spath.length; k++) { acc += dist(o.spath[k], o.spath[k - 1]); pre.push(acc); }
      o.plen = pre; o.ptotal = acc;
    }
    o.endT = endTime(o);
  });
  // Follow points join consecutive objects of the same combo.
  S.follow = [];
  for (let i = 1; i < objs.length; i++) {
    const a = objs[i - 1], b = objs[i];
    if (b.cn === 1 || a.k === "p" || b.k === "p") continue;
    const p0 = a.k === "s" && a.spath ? (a.slides % 2 ? a.spath[a.spath.length - 1] : a.spath[0]) : [a.sx, a.sy];
    const p1 = [b.sx, b.sy];
    if (dist(p0, p1) < 80) continue;     // osu! skips very short gaps
    S.follow.push({ p0, p1, t0: a.endT, t1: b.t });
  }
}

function pathAt(o, t01) {
  const pts = o.spath, pre = o.plen;
  if (!pts || !pts.length) return [o.sx, o.sy];
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
  const s = Math.min(rect.w / 512, rect.h / 384) * 0.9;
  return { s, ox: rect.x + (rect.w - 512 * s) / 2, oy: rect.y + (rect.h - 384 * s) / 2 };
}
const tx = (tr, x) => tr.ox + x * tr.s;
const ty = (tr, y) => tr.oy + y * tr.s;

/* Opacity of an object's head/body at time S.t (osu!stable timings). */
function headAlpha(o) {
  const t = S.t, start = o.t - S.preempt;
  if (t < start) return 0;
  if (S.hd) {
    const fin = S.preempt * 0.4, fout = S.preempt * 0.3;
    if (t < start + fin) return (t - start) / fin;
    return clamp(1 - (t - start - fin) / fout, 0, 1);
  }
  if (t < start + S.fadeIn) return (t - start) / S.fadeIn;
  return 1;
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
  if (w < 2 || h < 2) return;            // player hidden (menu): nothing to draw
  ctx.clearRect(0, 0, w, h);
  if (!S.map || !S.map.objects) return;
  const fields = activeFields(w, h);
  if (fields.length === 2) {
    ctx.strokeStyle = "rgba(255,255,255,.10)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  }
  for (const f of fields) drawField(f);
  if (OPT.showErrorBar) drawErrorBar(w, h);
}

function drawField(f) {
  const tr = fieldTransform(f.rect);
  const r = Math.max(3, S.radius * tr.s);
  const k = r / 64;                       // screen px per 1× skin px (hitcircle = 128 px)

  if (OPT.showBorder) {
    ctx.strokeStyle = "rgba(255,255,255,.07)"; ctx.lineWidth = 1;
    roundRect(tx(tr, 0) - 12, ty(tr, 0) - 12, 512 * tr.s + 24, 384 * tr.s + 24, 10);
    ctx.stroke();
  }

  const t = S.t, vis = [];
  const objs = S.map.objects;
  // objects are time-sorted: binary-search the first one that can be visible
  let lo = 0, hi = objs.length;
  const longest = S.longest || 0;
  while (lo < hi) { const m = (lo + hi) >> 1; if (objs[m].t < t - longest - 400) lo = m + 1; else hi = m; }
  for (let i = lo; i < objs.length; i++) {
    const o = objs[i];
    if (o.t - S.preempt > t) break;
    if (t <= o.endT + 260) vis.push(o);
  }

  drawFollowPoints(tr, k);
  // osu! draws earlier objects on top → paint from the last one back.
  for (let i = vis.length - 1; i >= 0; i--) {
    const o = vis[i];
    if (o.k === "s") drawSlider(o, tr, r, k);
    else if (o.k === "c") drawCircle(o, tr, r, k);
    else drawSpinner(o, tr, k);
  }

  if (OPT.showJudgments) for (const p of f.players) drawJudgments(p, tr, k, f.players.length);
  if (OPT.cursorGap && f.players.length === 2) drawCursorGap(tr);
  for (const p of f.players) drawCursor(p, tr);
  if (OPT.showKeys) drawKeyOverlay(f);
}

function roundRect(x, y, w, h, rad) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
  ctx.rect(x, y, w, h);
}

/* ── follow points ─────────────────────────────────────────────────── */

function drawFollowPoints(tr, k) {
  if (!OPT.followPoints || !S.follow) return;
  const t = S.t;
  for (const fp of S.follow) {
    const appear = fp.t1 - S.preempt - 200;
    if (t < appear || t > fp.t1 + 60) continue;
    if (fp.t0 - S.preempt > t) continue;
    const len = dist(fp.p0, fp.p1);
    const ang = Math.atan2(fp.p1[1] - fp.p0[1], fp.p0[0] === fp.p1[0] && fp.p0[1] === fp.p1[1] ? 1 : fp.p1[0] - fp.p0[0]);
    const spacing = 32;
    for (let d = spacing * 1.5; d < len - spacing; d += spacing) {
      const frac = d / len;
      // each point fades in sweeping from start to end, then out after the hit
      const tIn = fp.t0 - S.preempt + (fp.t1 - fp.t0) * frac;
      const tOut = fp.t0 + (fp.t1 - fp.t0) * frac;
      let a = clamp((t - tIn) / 300, 0, 1);
      if (t > tOut) a *= clamp(1 - (t - tOut) / 300, 0, 1);
      if (a <= 0) continue;
      const x = tx(tr, fp.p0[0] + (fp.p1[0] - fp.p0[0]) * frac);
      const y = ty(tr, fp.p0[1] + (fp.p1[1] - fp.p0[1]) * frac);
      if (has("followpoint")) {
        drawEl(ctx, "followpoint", x, y, tr.s / 1.6 * 1.0, { alpha: a, rot: ang, age: t - tIn, loop: true });
      } else if (!hidden("followpoint")) {
        ctx.save();
        ctx.translate(x, y); ctx.rotate(ang);
        ctx.globalAlpha = a * 0.55;
        ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(1.2, 2 * tr.s / 1.6); ctx.lineCap = "round";
        const s = 4.5 * tr.s / 1.6;
        ctx.beginPath(); ctx.moveTo(-s, -s); ctx.lineTo(0, 0); ctx.lineTo(-s, s); ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/* ── hit circles ───────────────────────────────────────────────────── */

// After its hit time a circle grows a little and fades out (like osu!).
function hitFx(o) {
  const after = S.t - o.t;
  if (after <= 0) return { a: 1, s: 1 };
  const p = clamp(after / 240, 0, 1);
  return { a: 1 - p, s: 1 + 0.35 * p };
}

function drawCircleShape(x, y, r, k, color, alpha, kind, scale = 1) {
  if (alpha <= 0) return;
  const base = kind === "head" && has("sliderstartcircle") ? "sliderstartcircle"
             : kind === "tail" && (has("sliderendcircle") || hidden("sliderendcircle")) ? "sliderendcircle" : "hitcircle";
  const over = base === "sliderstartcircle" && (has("sliderstartcircleoverlay") || hidden("sliderstartcircleoverlay")) ? "sliderstartcircleoverlay"
             : base === "sliderendcircle" ? "sliderendcircleoverlay" : "hitcircleoverlay";
  if (skinOn() && (has(base) || hidden(base))) {
    drawEl(ctx, base, x, y, k, { color, alpha, scale });
    if (!(kind === "head" || kind === "circle") || SKIN.ini.hitCircleOverlayAboveNumber)
      drawEl(ctx, over, x, y, k, { alpha, scale });
    return;
  }
  const rr = r * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  // vector style: soft glow, tinted body, crisp white rim
  const g = ctx.createRadialGradient(x, y - rr * .35, rr * .1, x, y, rr);
  g.addColorStop(0, rgba(color.map(c => Math.min(255, c * .75 + 40)), 1));
  g.addColorStop(1, rgba(color.map(c => c * .42), 1));
  ctx.beginPath(); ctx.arc(x, y, rr * .9, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = Math.max(1.5, rr * .14); ctx.strokeStyle = "#fff"; ctx.stroke();
  if (kind === "tail") { ctx.globalAlpha = alpha * .5; }
  ctx.beginPath(); ctx.arc(x, y, rr * .9 + Math.max(1.5, rr * .14) / 2 + 1, 0, Math.PI * 2);
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(color, .9); ctx.stroke();
  ctx.restore();
}

function drawComboNumber(o, x, y, r, k, alpha) {
  if (!OPT.showNumbers || alpha <= 0) return;
  if (skinOn() && drawDigits(ctx, o.cn, x, y, k * 0.8, alpha)) {
    if (!SKIN.ini.hitCircleOverlayAboveNumber) drawEl(ctx, "hitcircleoverlay", x, y, k, { alpha });
    return;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#fff";
  ctx.font = `800 ${Math.max(9, r * .78)}px "Space Grotesk", "Inter", system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 4;
  ctx.fillText(String(o.cn), x, y + 1);
  ctx.restore();
}

function drawApproach(o, x, y, r, k, color, alpha) {
  if (!OPT.showApproach) return;
  const dt = o.t - S.t;
  if (dt <= 0) return;
  if (S.hd && o !== S.map.objects[0]) return;     // Hidden: no approach circles
  const scale = 1 + 3 * dt / S.preempt;
  const a = clamp((S.preempt - dt) / Math.min(S.preempt, S.fadeIn * 2), 0, 1) * 0.9 * alpha;
  if (hidden("approachcircle")) return;
  if (has("approachcircle")) { drawEl(ctx, "approachcircle", x, y, k, { color, alpha: a, scale }); return; }
  ctx.beginPath(); ctx.arc(x, y, r * scale * .95, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.5, r * .09); ctx.strokeStyle = rgba(color, a); ctx.stroke();
}

function drawCircle(o, tr, r, k) {
  const x = tx(tr, o.sx), y = ty(tr, o.sy);
  const color = comboColor(o);
  const fx = hitFx(o);
  const alpha = headAlpha(o) * fx.a;
  drawCircleShape(x, y, r, k, color, alpha, "circle", fx.s);
  if (S.t <= o.t) drawComboNumber(o, x, y, r, k, alpha);
  drawApproach(o, x, y, r, k, color, headAlpha(o));
}

/* ── sliders ───────────────────────────────────────────────────────── */

let bodyLayer = null, bodyCtx = null;
function layer() {
  if (!bodyLayer) { bodyLayer = document.createElement("canvas"); bodyCtx = bodyLayer.getContext("2d"); }
  if (bodyLayer.width !== canvas.width || bodyLayer.height !== canvas.height) {
    bodyLayer.width = canvas.width; bodyLayer.height = canvas.height;
  }
  bodyCtx.setTransform(ctx.getTransform());
  return bodyCtx;
}

function sliderBodyAlpha(o) {
  const t = S.t, start = o.t - S.preempt;
  if (t < start) return 0;
  let a = clamp((t - start) / S.fadeIn, 0, 1);
  if (S.hd) {
    // Hidden: the body fades away over the slider's lifetime
    const fadeStart = start + S.preempt * 0.4;
    a = t < fadeStart ? a : clamp(1 - (t - fadeStart) / Math.max(1, o.endT - fadeStart), 0, 1);
  }
  if (t > o.endT) a *= clamp(1 - (t - o.endT) / 200, 0, 1);
  return a;
}

function strokeBody(g, o, tr, endFrac) {
  g.beginPath();
  const p = o.spath;
  g.moveTo(tx(tr, p[0][0]), ty(tr, p[0][1]));
  if (endFrac >= 1) {
    for (let i = 1; i < p.length; i++) g.lineTo(tx(tr, p[i][0]), ty(tr, p[i][1]));
  } else {
    const target = endFrac * o.ptotal;
    for (let i = 1; i < p.length; i++) {
      if (o.plen[i] <= target) g.lineTo(tx(tr, p[i][0]), ty(tr, p[i][1]));
      else { const [ex, ey] = pathAt(o, endFrac); g.lineTo(tx(tr, ex), ty(tr, ey)); break; }
    }
  }
}

function drawSlider(o, tr, r, k) {
  if (!o.spath || o.spath.length < 2) { drawCircle(o, tr, r, k); return; }
  const color = comboColor(o);
  const bodyA = sliderBodyAlpha(o);
  const dt = o.t - S.t;

  let endFrac = 1;
  if (OPT.snaking && dt > 0) endFrac = clamp(1 - (dt - S.preempt * 0.3) / (S.preempt * 0.7), 0, 1);

  if (bodyA > 0) {
    const g = layer();
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.lineCap = "round"; g.lineJoin = "round";
    if (skinOn()) {
      // osu!stable look: border colour, then a track shaded toward the centre
      const border = SKIN.sliderBorder || [255, 255, 255];
      const track = SKIN.sliderTrack || color;
      strokeBody(g, o, tr, endFrac); g.lineWidth = r * 2 * 0.98; g.strokeStyle = rgba(border, 1); g.stroke();
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const f = i / (steps - 1);
        const shade = track.map(c => Math.min(255, c * (0.55 + 0.45 * f) + 25 * f));
        strokeBody(g, o, tr, endFrac);
        g.lineWidth = r * 2 * 0.84 * (1 - f * 0.75);
        g.strokeStyle = rgba(shade, 1); g.stroke();
      }
    } else {
      strokeBody(g, o, tr, endFrac); g.lineWidth = r * 2 * 0.96; g.strokeStyle = "rgba(255,255,255,1)"; g.stroke();
      strokeBody(g, o, tr, endFrac); g.lineWidth = r * 2 * 0.84; g.strokeStyle = rgba(color.map(c => c * .22 + 12), 1); g.stroke();
      strokeBody(g, o, tr, endFrac); g.lineWidth = r * 2 * 0.5; g.strokeStyle = rgba(color.map(c => c * .32 + 16), 1); g.stroke();
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = bodyA * (skinOn() ? 0.92 : 0.88);
    ctx.drawImage(bodyLayer, 0, 0);
    ctx.restore();
  }

  // tail circle + reverse arrows
  const nSpan = Math.max(1, o.slides);
  const span = o.dur / nSpan;
  const curSpan = S.t < o.t ? 0 : Math.min(nSpan - 1, Math.floor((S.t - o.t) / Math.max(1, span)));
  const pEnd = o.spath[o.spath.length - 1], pStart = o.spath[0];
  if (endFrac >= 1 && bodyA > 0) {
    const tailPt = nSpan % 2 === 1 ? pEnd : pStart;
    const tailA = S.t > o.endT ? bodyA : bodyA * (S.hd ? 0.9 : 1);
    drawCircleShape(tx(tr, tailPt[0]), ty(tr, tailPt[1]), r, k, color, tailA, "tail");
    if (nSpan > 1) {
      // a pending repeat at the end (even spans) and/or at the start (odd spans)
      let endRep = false, startRep = false;
      for (let i = curSpan; i < nSpan - 1; i++) { if (i % 2 === 0) endRep = true; else startRep = true; }
      const pulse = 1 + 0.12 * Math.max(0, Math.sin((S.t - o.t) / (span || 300) * Math.PI * 2));
      if (endRep) drawArrow(pEnd, o.spath[Math.max(0, o.spath.length - 3)], tr, r, k, bodyA, pulse);
      if (startRep) drawArrow(pStart, o.spath[Math.min(o.spath.length - 1, 2)], tr, r, k, bodyA, pulse);
    }
  }

  // head (fades like a circle once the slider has started)
  const hx = tx(tr, o.sx), hy = ty(tr, o.sy);
  const fx = hitFx(o);
  const headA = headAlpha(o) * fx.a;
  drawCircleShape(hx, hy, r, k, color, headA, "head", fx.s);
  if (S.t <= o.t) drawComboNumber(o, hx, hy, r, k, headA);
  drawApproach(o, hx, hy, r, k, color, headAlpha(o));

  // ball + follow circle while sliding
  if (S.t >= o.t && S.t <= o.endT) {
    let prog = (S.t - o.t) / Math.max(1, span);
    const slide = Math.min(nSpan - 1, Math.floor(prog));
    let tt = prog - slide;
    const back = slide % 2 === 1;
    if (back) tt = 1 - tt;
    const [bx, by] = pathAt(o, clamp(tt, 0, 1));
    const [ax, ay] = pathAt(o, clamp(tt + (back ? -0.01 : 0.01), 0, 1));
    const ang = Math.atan2(ay - by, ax - bx);
    const bsx = tx(tr, bx), bsy = ty(tr, by);
    drawBall(o, bsx, bsy, r, k, color, ang, back);
  }
}

function drawArrow(p, toward, tr, r, k, alpha, pulse) {
  if (hidden("reversearrow")) return;
  const x = tx(tr, p[0]), y = ty(tr, p[1]);
  const ang = Math.atan2(toward[1] - p[1], toward[0] - p[0]);
  if (has("reversearrow")) { drawEl(ctx, "reversearrow", x, y, k, { alpha, rot: ang, scale: pulse }); return; }
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang); ctx.scale(pulse, pulse);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = "#fff"; ctx.lineWidth = Math.max(2, r * .16); ctx.lineCap = "round"; ctx.lineJoin = "round";
  const s = r * .42;
  ctx.beginPath(); ctx.moveTo(-s * .3, -s); ctx.lineTo(s * .7, 0); ctx.lineTo(-s * .3, s); ctx.stroke();
  ctx.restore();
}

function drawBall(o, x, y, r, k, color, ang, back) {
  const holding = S.replays[0] ? (keysAt(S.replays[0].frames, S.t) & 15) !== 0 : true;
  const since = S.t - o.t;
  if (skinOn() && (has("sliderb") || hidden("sliderb"))) {
    if (has("sliderb-nd")) drawEl(ctx, "sliderb-nd", x, y, k, { color: [5, 5, 5] });
    const ballTint = SKIN.ini.allowSliderBallTint ? color : (SKIN.sliderBall || null);
    const fr = SKIN.el.sliderb && SKIN.el.sliderb.frames;
    // animation advances with distance travelled (≈ every 4 osu!px)
    const idx = fr ? Math.floor(since / Math.max(1, o.dur / Math.max(1, o.ptotal * o.slides / 4))) % fr.length : 0;
    drawEl(ctx, "sliderb", x, y, k, {
      frame: fr ? fr[idx] : undefined, color: ballTint, rot: ang,
      flipX: back && SKIN.ini.sliderBallFlip,
    });
    if (has("sliderb-spec")) { ctx.save(); ctx.globalCompositeOperation = "lighter"; drawEl(ctx, "sliderb-spec", x, y, k); ctx.restore(); }
  } else {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, r * .86, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color.map(c => Math.min(255, c * .9 + 20)), 1); ctx.fill();
    ctx.lineWidth = Math.max(2, r * .13); ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.restore();
  }
  if (!holding) return;
  const grow = clamp(since / 120, 0, 1);
  if (has("sliderfollowcircle")) {
    drawEl(ctx, "sliderfollowcircle", x, y, k, { scale: 0.5 + 0.5 * grow, alpha: grow, age: since, loop: true });
  } else if (!hidden("sliderfollowcircle")) {
    ctx.beginPath(); ctx.arc(x, y, r * (1.2 + 0.9 * grow), 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * .1); ctx.strokeStyle = `rgba(255,255,255,${.75 * grow})`; ctx.stroke();
  }
}

/* ── spinners ──────────────────────────────────────────────────────── */

function drawSpinner(o, tr, k) {
  const t = S.t;
  if (t > o.end + 200) return;
  const cx = tx(tr, 256), cy = ty(tr, 192);
  const appear = clamp((t - (o.t - S.preempt)) / 300, 0, 1);
  const out = t > o.end ? 1 - (t - o.end) / 200 : 1;
  const alpha = appear * out;
  if (alpha <= 0) return;
  const prog = clamp((t - o.t) / Math.max(1, o.end - o.t), 0, 1);
  const rot = t > o.t ? (t - o.t) / 1000 * Math.PI * 2 * (1 + prog * 2) : 0;
  const ks = tr.s / 1.6;

  if (skinOn() && (has("spinner-bottom") || has("spinner-top"))) {
    drawEl(ctx, "spinner-glow", cx, cy, ks, { alpha: alpha * prog });
    drawEl(ctx, "spinner-bottom", cx, cy, ks, { alpha, rot: rot / 3 });
    drawEl(ctx, "spinner-top", cx, cy, ks, { alpha, rot });
    drawEl(ctx, "spinner-middle2", cx, cy, ks, { alpha });
    drawEl(ctx, "spinner-middle", cx, cy, ks, { alpha, color: [255, 255 * (1 - prog), 255 * (1 - prog)] });
    return;
  }
  if (skinOn() && has("spinner-circle")) {
    drawEl(ctx, "spinner-background", cx, cy, ks, { alpha });
    drawEl(ctx, "spinner-circle", cx, cy, ks, { alpha, rot });
    if (t >= o.t) drawEl(ctx, "spinner-approachcircle", cx, cy, ks, { alpha, scale: Math.max(0.02, 1 - prog) });
    return;
  }
  const maxR = 180 * tr.s;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.stroke();
  // progress arc + spinning blades
  ctx.lineWidth = 6; ctx.lineCap = "round"; ctx.strokeStyle = rgba(PLAYER_COLORS[0], .9);
  ctx.beginPath(); ctx.arc(cx, cy, maxR * .72, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.75)";
  for (let i = 0; i < 3; i++) {
    const a0 = rot + i * Math.PI * 2 / 3;
    ctx.beginPath(); ctx.arc(cx, cy, maxR * .5, a0, a0 + 1.2); ctx.stroke();
  }
  if (t >= o.t) {
    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(4, maxR * (1 - prog)), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
}

/* ── cursors ───────────────────────────────────────────────────────── *
 * Skin cursor, osu!-style: `cursor` (+ CursorCentre / CursorRotate /
 * CursorExpand), `cursormiddle` on top, and a `cursortrail` that is either
 * discrete ghosts or — when the skin ships a cursormiddle — a dense "smooth"
 * trail laid along the path. Each part falls back on its own: a missing
 * cursor or trail gets the vector style, a 1×1 (hidden) trail means none.
 * Trail sprites sit on an absolute time grid so they stay put between frames
 * instead of shimmering as the window slides.
 */

const CURSOR_SPIN_MS = 10000;   // CursorRotate: one turn per 10 s
const EXPAND_SCALE = 1.2, EXPAND_MS = 100;

const cursorRot = t => (SKIN.ini.cursorRotate ? (t / CURSOR_SPIN_MS) * Math.PI * 2 : 0);
const easeOut = x => 1 - (1 - x) * (1 - x);

/* [pressed, ms since the key state last changed] at time t. */
function pressState(frames, t) {
  if (!frames.length || t < frames[0][0]) return [false, 1e9];
  const i = frameIndexAt(frames, t);
  const on = (frames[i][3] & 15) !== 0;
  for (let j = i; j > 0 && i - j < 60; j--) {
    if (((frames[j - 1][3] & 15) !== 0) !== on) return [on, t - frames[j][0]];
  }
  return [on, 1e9];
}

function expandScale(frames) {
  if (!SKIN.ini.cursorExpand) return 1;
  const [on, age] = pressState(frames, S.t);
  const k = easeOut(clamp(age / EXPAND_MS, 0, 1));
  return 1 + (EXPAND_SCALE - 1) * (on ? k : 1 - k);
}

function skinTrailPoints(frames, tr, ks, tMul, smooth) {
  const pts = [];                                  // [x, y, ageMs, time]
  const life = 150 * tMul;
  if (life <= 0) return pts;
  if (!smooth) {
    const g = 16;                                  // one ghost per ~frame
    for (let t = Math.ceil((S.t - life) / g) * g; t < S.t; t += g) {
      const [ox, oy] = cursorAt(frames, t);
      pts.push([tx(tr, ox), ty(tr, oy), S.t - t, t]);
    }
    return pts;
  }
  const fr = frameOf("cursortrail");
  const spacing = Math.max(1.5, fr.w * ks / 2.5);
  const g = 4;
  const times = [];
  for (let t = Math.ceil((S.t - life) / g) * g; t < S.t; t += g) times.push(t);
  times.push(S.t);
  let prev = null, last = null;
  for (const t of times) {
    const [ox, oy] = cursorAt(frames, t);
    const p = [tx(tr, ox), ty(tr, oy), S.t - t, t];
    if (!prev) { pts.push(p); last = p; prev = p; continue; }
    const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (d >= spacing) {
      // fill the gap at even steps (depends only on the two grid points)
      const n = Math.min(64, Math.ceil(d / spacing));
      for (let j = 1; j <= n; j++) {
        const f = j / n;
        pts.push([prev[0] + (p[0] - prev[0]) * f, prev[1] + (p[1] - prev[1]) * f,
          prev[2] + (p[2] - prev[2]) * f, prev[3] + (p[3] - prev[3]) * f]);
      }
      last = p;
    } else if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= spacing) {
      pts.push(p); last = p;
    }
    prev = p;
  }
  return pts.length > 600 ? pts.slice(-600) : pts;
}

function drawSkinTrail(frames, tr, ks, tMul, tint) {
  const smooth = has("cursormiddle");
  const life = 150 * tMul;
  const spin = SKIN.ini.cursorTrailRotate;
  for (const [x, y, age, t] of skinTrailPoints(frames, tr, ks, tMul, smooth)) {
    const f = 1 - age / life;
    if (f <= 0) continue;
    drawEl(ctx, "cursortrail", x, y, ks, {
      color: tint, alpha: smooth ? Math.pow(f, 1.4) * .9 : f * .85,
      rot: spin ? cursorRot(t) : 0,
    });
  }
}

function drawVectorTrail(frames, tr, color, base, tMul) {
  const TRAIL = Math.round(22 * tMul);
  if (TRAIL <= 1) return;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  let prev = cursorAt(frames, S.t - TRAIL * 8);
  for (let k2 = TRAIL - 1; k2 >= 0; k2--) {
    const cur = cursorAt(frames, S.t - k2 * 8);
    const f = 1 - k2 / TRAIL;
    ctx.strokeStyle = rgba(color, f * .45);
    ctx.lineWidth = Math.max(1, base * 1.1 * f);
    ctx.beginPath(); ctx.moveTo(tx(tr, prev[0]), ty(tr, prev[1])); ctx.lineTo(tx(tr, cur[0]), ty(tr, cur[1])); ctx.stroke();
    prev = cur;
  }
  ctx.restore();
}

function drawVectorHead(x, y, color, base, pressed) {
  const cr = Math.max(5, base) * (pressed ? 1.18 : 1);
  ctx.save();
  ctx.shadowColor = rgba(color, .9); ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2); ctx.fillStyle = rgba(color, pressed ? 1 : .92); ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2; ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
}

/* Player-coloured glow under a skin cursor, so two identical skin cursors
   stay tellable apart without recolouring the skin itself. */
function drawPlayerHalo(x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, .55));
  g.addColorStop(.55, rgba(color, .25));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/* Overlay mode with two replays: a line joining both cursors and their
   distance in osu! pixels, so you can see exactly where the aims diverge. */
function drawCursorGap(tr) {
  const [ax, ay] = cursorAt(S.replays[0].frames, S.t);
  const [bx, by] = cursorAt(S.replays[1].frames, S.t);
  const d = Math.hypot(bx - ax, by - ay);
  if (d < 6) return;
  const x0 = tx(tr, ax), y0 = ty(tr, ay), x1 = tx(tr, bx), y1 = ty(tr, by);
  const a = clamp((d - 6) / 40, 0, 1) * .75;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, rgba(PLAYER_COLORS[0], a)); grad.addColorStop(1, rgba(PLAYER_COLORS[1], a));
  ctx.save();
  ctx.strokeStyle = grad; ctx.lineWidth = Math.max(1.2, tr.s * 1.1);
  ctx.setLineDash([6 * tr.s, 5 * tr.s]);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.setLineDash([]);
  if (d >= 24) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, lbl = Math.round(d) + " px";
    ctx.font = `600 ${Math.round(clamp(10 * tr.s, 10, 14))}px Outfit, sans-serif`;
    const w = ctx.measureText(lbl).width + 10, h = clamp(10 * tr.s, 10, 14) + 6;
    ctx.fillStyle = `rgba(10,10,14,${.55 * a / .75 + .1})`;
    roundRect(mx - w / 2, my - h / 2, w, h, 4); ctx.fill();
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a / .75 + .2)})`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(lbl, mx, my + .5);
  }
  ctx.restore();
}

function drawCursor(p, tr) {
  const frames = S.replays[p].frames;
  const color = PLAYER_COLORS[p];
  const duo = !!(S.replays[0] && S.replays[1]);
  const cMul = OPT.cursorScale / 100, tMul = OPT.trail / 100;
  const ks = tr.s / 1.6 * cMul;                    // osu! sprites are sized for a 768-px-tall screen
  const base = 9 * tr.s * 1.35 * cMul;             // vector cursor radius

  // trail: skin sprite → vector fallback when absent → nothing when hidden
  if (tMul > 0) {
    if (has("cursortrail")) drawSkinTrail(frames, tr, ks, tMul, duo ? color : null);
    else if (!hidden("cursortrail")) drawVectorTrail(frames, tr, color, base, tMul);
  }

  const [ox, oy] = cursorAt(frames, S.t);
  const x = tx(tr, ox), y = ty(tr, oy);
  const head = has("cursor"), middle = has("cursormiddle");
  if (!head && !middle) {
    drawVectorHead(x, y, color, base, (keysAt(frames, S.t) & 15) !== 0);
    return;
  }
  const ex = expandScale(frames);
  if (duo) {
    const fr = frameOf(head ? "cursor" : "cursormiddle");
    drawPlayerHalo(x, y, Math.max(14, Math.max(fr.w, fr.h) * ks * .55 * ex), color);
  }
  if (head) {
    if (SKIN.ini.cursorCentre) drawEl(ctx, "cursor", x, y, ks, { scale: ex, rot: cursorRot(S.t) });
    else drawEl(ctx, "cursor", x, y, ks, { scale: ex, topLeft: true });
  }
  if (middle) drawEl(ctx, "cursormiddle", x, y, ks);
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

const JUDGE_EL = { 300: "hit300", 100: "hit100", 50: "hit50", 0: "hit0" };

function drawJudgments(slot, tr, k, nPlayers) {
  for (const ev of eventsWindow(slot, JUDGE_POPUP_MS)) {
    const judg = ev[4];
    if (judg === 300 && !OPT.show300) continue;
    const age = S.t - ev[0];
    const life = clamp(age / JUDGE_POPUP_MS, 0, 1);
    const alpha = life < .7 ? 1 : 1 - (life - .7) / .3;
    let x = tx(tr, ev[5]), y = ty(tr, ev[6]);
    if (nPlayers === 2) x += (slot === 0 ? -1 : 1) * 16 * tr.s / 1.6;
    const name = JUDGE_EL[judg];
    if (hidden(name)) continue;
    if (has(name)) {
      const pop = judg === 0 ? 1.6 - 0.6 * clamp(age / 100, 0, 1) : 0.8 + 0.2 * clamp(age / 80, 0, 1);
      drawEl(ctx, name, x, y + (judg === 0 ? 20 * k * life : 0), Math.max(k, tr.s / 1.6 * .6), {
        alpha, age, scale: pop, rot: judg === 0 ? 0.25 * life : 0,
      });
      continue;
    }
    const color = JUDGE_COLORS[judg];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 ${Math.round((judg === 0 ? 22 : 17) * Math.max(.75, tr.s / 1.6))}px "Space Grotesk", "Inter", system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = rgba(color, .8); ctx.shadowBlur = 10;
    ctx.fillStyle = rgba(color, 1);
    ctx.fillText(judg === 0 ? "✕" : String(judg), x, y - 10 * life);
    ctx.restore();
  }
}

function drawErrorBar(w, h) {
  const e0 = S.events[0] || S.events[1];
  if (!e0) return;
  const [w300, w100, w50] = e0.windows;
  const barW = Math.min(300, w * .3), barH = 5;
  const cx = w / 2, by = h - 20;
  const zone = (ms, color, a) => { const half = barW / 2 * Math.min(1, ms / w50); ctx.fillStyle = rgba(color, a); ctx.fillRect(cx - half, by, half * 2, barH); };
  zone(w50, JUDGE_COLORS[50], .35); zone(w100, JUDGE_COLORS[100], .45); zone(w300, JUDGE_COLORS[300], .6);
  ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fillRect(cx - 1, by - 5, 2, barH + 10);
  for (const slot of [0, 1]) {
    if (!S.events[slot]) continue;
    const evs = eventsWindow(slot, ERRORBAR_MS);
    let mean = 0, n = 0;
    for (const ev of evs) {
      if (ev[4] <= 0) continue;
      const age = (S.t - ev[0]) / ERRORBAR_MS;
      const off = clamp(ev[7] / w50, -1, 1);
      mean += off; n++;
      ctx.fillStyle = rgba(JUDGE_COLORS[ev[4]] || PLAYER_COLORS[slot], .9 * (1 - age));
      ctx.fillRect(cx + off * barW / 2 - 1, slot === 0 ? by - 9 : by + barH + 2, 2, 7);
    }
    if (n) {
      // average-error chevron
      const mx = cx + (mean / n) * barW / 2, my = slot === 0 ? by - 12 : by + barH + 12;
      ctx.fillStyle = rgba(PLAYER_COLORS[slot], 1);
      ctx.beginPath();
      if (slot === 0) { ctx.moveTo(mx - 5, my - 6); ctx.lineTo(mx + 5, my - 6); ctx.lineTo(mx, my); }
      else { ctx.moveTo(mx - 5, my + 6); ctx.lineTo(mx + 5, my + 6); ctx.lineTo(mx, my); }
      ctx.fill();
    }
  }
}

function drawKeyOverlay(f) {
  const box = 26, gap = 6;
  for (const p of f.players) {
    const frames = S.replays[p].frames;
    const keys = keysAt(frames, S.t);
    const k1 = !!(keys & 4), k2 = !!(keys & 8);
    const states = [["K1", k1], ["K2", k2], ["M1", !!(keys & 1) && !k1], ["M2", !!(keys & 2) && !k2]];
    const right = p === 0 || S.mode === "split";
    const x = right ? f.rect.x + f.rect.w - box - 14 : f.rect.x + 14;
    let y = f.rect.y + f.rect.h / 2 - (4 * box + 3 * gap) / 2;
    const color = PLAYER_COLORS[p];
    for (const [lbl, on] of states) {
      ctx.fillStyle = on ? rgba(color, .95) : "rgba(255,255,255,.05)";
      roundRect(x, y, box, box, 7); ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = on ? rgba(color, 1) : "rgba(255,255,255,.14)";
      roundRect(x + .5, y + .5, box - 1, box - 1, 7); ctx.stroke();
      ctx.font = `700 10px "Space Grotesk", "Inter", system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = on ? "#0b0b14" : "rgba(255,255,255,.45)";
      ctx.fillText(lbl, x + box / 2, y + box / 2 + .5);
      y += box + gap;
    }
  }
}

