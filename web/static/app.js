/* ════════════════════════════════════════════════════════════════════
   osu! Replay Viewer — browser frontend
   The Python server parses .osr/.osu/.osz and simulates scoring;
   this file only renders and plays back.
   ════════════════════════════════════════════════════════════════════ */
"use strict";

/* ── constants ─────────────────────────────────────────────────────── */

const COMBO_COLORS = [
  [255, 160, 55], [60, 210, 90], [60, 148, 255],
  [255, 60, 90], [175, 60, 218], [255, 218, 50],
];
const PLAYER_COLORS = [[255, 102, 170], [100, 174, 255]];
const JUDGE_COLORS = { 300: [80, 170, 255], 100: [90, 220, 110], 50: [255, 175, 70], 0: [255, 70, 90] };
const HIT_LINGER = 200;
const JUDGE_POPUP_MS = 650;
const ERRORBAR_MS = 4000;

const MOD = { NF: 1, EZ: 2, HD: 8, HR: 16, DT: 64, HT: 256, NC: 512 };

/* ── skin ──────────────────────────────────────────────────────────── */

let PALETTE = COMBO_COLORS;
const SKIN = { present: false, el: {}, colors: [], sliderBorder: null, sliderTrack: null };
const tintCache = new Map();
const CURSOR_SKIN_SCALE = 0.6;     // skin cursors are huge — shrink them

async function loadSkin() {
  try {
    const m = await (await fetch("/api/skin")).json();
    if (!m.present) return;
    SKIN.present = true;
    SKIN.colors = m.comboColors || [];
    SKIN.sliderBorder = m.sliderBorder;
    SKIN.sliderTrack = m.sliderTrack;
    for (const [name, info] of Object.entries(m.elements)) {
      const img = new Image();
      img.src = info.url;
      SKIN.el[name] = { img, scale: info.scale, w: info.w, h: info.h };
    }
    if (SKIN.colors.length) PALETTE = SKIN.colors;
  } catch (e) { /* run unskinned */ }
}
loadSkin();

/* Scaled (and optionally colour-tinted) skin sprite, cached on a canvas. */
function sprite(name, wpx, color) {
  const e = SKIN.el[name];
  if (!e || !e.img.complete || !e.img.naturalWidth) return null;
  wpx = Math.max(2, Math.round(wpx));
  const key = name + "|" + wpx + "|" + (color ? color.join() : "");
  let c = tintCache.get(key);
  if (c) return c;
  const h = Math.max(2, Math.round(wpx * e.img.naturalHeight / e.img.naturalWidth));
  c = document.createElement("canvas");
  c.width = wpx;
  c.height = h;
  const g = c.getContext("2d");
  g.drawImage(e.img, 0, 0, wpx, h);
  if (color) {
    g.globalCompositeOperation = "multiply";
    g.fillStyle = rgba(color, 1);
    g.fillRect(0, 0, wpx, h);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(e.img, 0, 0, wpx, h);
  }
  if (tintCache.size > 600) tintCache.clear();
  tintCache.set(key, c);
  return c;
}

function clockRate(mods) {
  if (mods & (MOD.DT | MOD.NC)) return 1.5;
  if (mods & MOD.HT) return 0.75;
  return 1.0;
}
function adjDifficulty(cs, ar, od, mods) {
  if (mods & MOD.HR) { cs = Math.min(10, cs * 1.3); ar = Math.min(10, ar * 1.4); od = Math.min(10, od * 1.4); }
  else if (mods & MOD.EZ) { cs *= .5; ar *= .5; od *= .5; }
  return [cs, ar, od];
}
function preemptMs(ar) {
  if (ar < 5) return 1200 + 600 * (5 - ar) / 5;
  if (ar === 5) return 1200;
  return 1200 - 750 * (ar - 5) / 5;
}
const circleRadius = cs => 54.4 - 4.48 * cs;
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ── state ─────────────────────────────────────────────────────────── */

const S = {
  replays: [null, null],     // {slot, player, mods, modsStr, md5, frames}
  events:  [null, null],     // {events, windows}
  map: null,
  audio: null,
  audioBlocked: false,
  actx: null, hitBuf: null, sfxGain: null,
  started: false,
  playing: false,
  t: 0, lastNow: 0, speed: 1,
  origin: 0, endT: 1,
  radius: 32, preempt: 1200,
  mode: "overlay",
  hitIdx: 0,
  seeking: false,
  mapFetching: false,
};

/* ── tiny DOM helpers ──────────────────────────────────────────────── */

const $ = id => document.getElementById(id);
const landing = $("landing"), player = $("player");
const canvas = $("field"), ctx = canvas.getContext("2d");

function toast(msg, kind = "info", ms = 4200) {
  const el = document.createElement("div");
  el.className = "toast" + (kind !== "info" ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function chip(id, value, state) {
  const el = $(id);
  el.querySelector(".chip-value").textContent = value;
  el.classList.remove("ok", "err", "busy");
  if (state) el.classList.add(state);
}

/* ── file intake ───────────────────────────────────────────────────── */

async function handleFiles(files) {
  for (const f of files) {
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf("."));
    if (ext === ".osr") await uploadReplay(f);
    else if (ext === ".osu" || ext === ".osz") await uploadMap(f);
    else toast(`Unsupported file: ${f.name}`, "error");
  }
}

async function uploadReplay(file) {
  try {
    const res = await fetch("/api/replay?slot=auto", { method: "POST", body: await file.arrayBuffer() });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const data = await res.json();
    S.replays[data.slot] = data;
    S.events[data.slot] = null;
    const label = data.player + (data.modsStr ? `  +${data.modsStr}` : "");
    chip("chip-r" + data.slot, label, "ok");
    if (S.replays[0] && S.replays[1] && S.replays[0].md5 !== S.replays[1].md5)
      toast("Warning: the two replays are from different beatmaps!", "warn");
  } catch (e) {
    toast("Replay error: " + e.message, "error");
    return;
  }
  await afterFilesChanged();
}

async function uploadMap(file) {
  chip("chip-map", "uploading " + file.name + "…", "busy");
  try {
    const res = await fetch("/api/mapfile", {
      method: "POST",
      headers: { "X-Filename": file.name },
      body: await file.arrayBuffer(),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    await fetchMap();
  } catch (e) {
    chip("chip-map", "failed — " + e.message, "err");
    toast("Beatmap error: " + e.message, "error");
    return;
  }
  await afterFilesChanged();
}

async function fetchMap() {
  const res = await fetch("/api/map");
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  S.map = await res.json();
  S.events = [null, null];     // depend on the beatmap → recompute
  const t = `${S.map.artist} — ${S.map.title} [${S.map.version}]`;
  chip("chip-map", t, "ok");
  if (!S.map.md5Match)
    toast("Exact difficulty not found (MD5 mismatch) — using closest one.", "warn");
}

async function autoFetch(md5) {
  if (S.mapFetching) return;
  S.mapFetching = true;
  chip("chip-map", "searching mirrors…", "busy");
  const poll = setInterval(async () => {
    try {
      const st = await (await fetch("/api/status")).json();
      if (st.status) chip("chip-map", st.status, "busy");
    } catch (e) { /* ignore */ }
  }, 450);
  try {
    const res = await fetch("/api/auto?md5=" + encodeURIComponent(md5));
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    await fetchMap();
    await afterFilesChanged();
  } catch (e) {
    chip("chip-map", "not found — drop the .osz manually", "err");
    toast(e.message, "error", 6000);
  } finally {
    clearInterval(poll);
    S.mapFetching = false;
  }
}

async function afterFilesChanged() {
  if (!S.map && S.replays[0] && !S.mapFetching) {
    autoFetch(S.replays[0].md5);          // fire and forget
    return;
  }
  if (S.map) {
    for (const slot of [0, 1]) {
      if (S.replays[slot] && !S.events[slot]) {
        try {
          const res = await fetch("/api/events?slot=" + slot);
          if (res.ok) S.events[slot] = await res.json();
        } catch (e) { /* ignore */ }
      }
    }
  }
  maybeStart();
}

function maybeStart() {
  if (!S.map || !S.replays.some(Boolean)) return;
  for (const slot of [0, 1])
    if (S.replays[slot] && !S.events[slot]) return;
  if (S.started) {            // already watching — apply new files live
    enterPlayer();
    return;
  }
  $("btn-watch").classList.remove("hidden");   // wait for the user
}

/* ── player setup ──────────────────────────────────────────────────── */

function prepareSliders() {
  for (const o of S.map.objects) {
    if (o.k !== "s" || !o.path || o.path.length < 2) continue;
    const pre = [0];
    let acc = 0;
    for (let i = 1; i < o.path.length; i++) {
      acc += Math.hypot(o.path[i][0] - o.path[i - 1][0], o.path[i][1] - o.path[i - 1][1]);
      pre.push(acc);
    }
    o.plen = pre;
    o.ptotal = acc;
  }
}

function pathAt(o, t01) {
  const pts = o.path, pre = o.plen;
  if (!pts || !pts.length) return [o.x, o.y];
  if (t01 <= 0 || !o.ptotal) return pts[0];
  if (t01 >= 1) return pts[pts.length - 1];
  const target = t01 * o.ptotal;
  let lo = 0, hi = pre.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (pre[mid] <= target) lo = mid; else hi = mid;
  }
  const seg = pre[hi] - pre[lo] || 1;
  const s = (target - pre[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * s,
          pts[lo][1] + (pts[hi][1] - pts[lo][1]) * s];
}

function enterPlayer() {
  const mods0 = S.replays[0] ? S.replays[0].mods : 0;
  const [cs, ar] = adjDifficulty(S.map.cs, S.map.ar, S.map.od, mods0);
  S.radius = circleRadius(cs);
  S.preempt = preemptMs(ar);
  prepareSliders();

  const objs = S.map.objects;
  S.origin = objs.length ? objs[0].t - S.preempt - 1500 : -2000;
  S.endT = objs.length
    ? Math.max(...objs.map(o => o.k === "s" ? o.t + o.dur : o.k === "p" ? o.end : o.t)) + 2000
    : 1;

  // HUD identity
  for (const slot of [0, 1]) {
    const r = S.replays[slot];
    $("panel-" + slot).classList.toggle("hidden", !r);
    if (r) {
      $(`p${slot}-name`).textContent = r.player;
      $(`p${slot}-mods`).textContent = r.modsStr ? "+" + r.modsStr : "";
    }
  }
  $("map-title").textContent =
    `${S.map.artist} — ${S.map.title} [${S.map.version}]  ·  mapped by ${S.map.creator}`;
  $("btn-mode").classList.toggle("hidden", !(S.replays[0] && S.replays[1]));

  // Background + audio
  $("bg-layer").style.backgroundImage = S.map.bg ? `url(${S.map.bg})` : "none";
  if (S.audio) { S.audio.pause(); S.audio = null; }
  if (S.map.audio) {
    S.audio = new Audio(S.map.audio);
    S.audio.preload = "auto";
    S.audio.volume = $("vol-music").value / 100;
    try { S.audio.preservesPitch = true; } catch (e) { /* older browsers */ }
  } else {
    toast("No audio file in this beatmap — playing silently.", "warn");
  }
  initSfx();

  // DT/HT replays: default to the real-time experience
  const rate = clockRate(mods0);
  S.speed = rate;
  $("speed").value = String(rate);
  if (rate !== 1) toast(`${S.replays[0].modsStr} replay — speed set to ${rate}×`, "info");

  S.t = S.origin;
  S.hitIdx = 0;
  landing.classList.add("hidden");
  player.classList.remove("hidden");
  setPlaying(true);

  if (!S.started) {
    S.started = true;
    S.lastNow = performance.now();
    requestAnimationFrame(tick);
  }
}

function initSfx() {
  if (S.actx) return;
  try {
    S.actx = new (window.AudioContext || window.webkitAudioContext)();
    S.sfxGain = S.actx.createGain();
    S.sfxGain.gain.value = $("vol-sfx").value / 100;
    S.sfxGain.connect(S.actx.destination);
    fetch("/api/hitsound")
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject())
      .then(b => S.actx.decodeAudioData(b))
      .then(buf => { S.hitBuf = buf; })
      .catch(() => { /* no hit sound available */ });
  } catch (e) { /* WebAudio unavailable */ }
}

function playHitSound() {
  if (!S.hitBuf || !S.actx) return;
  if (S.actx.state === "suspended") S.actx.resume();
  const src = S.actx.createBufferSource();
  src.buffer = S.hitBuf;
  src.connect(S.sfxGain);
  src.start();
}

/* ── playback ──────────────────────────────────────────────────────── */

function setPlaying(p) {
  S.playing = p;
  $("btn-play").textContent = p ? "⏸" : "▶";
  if (!p) { if (S.audio) S.audio.pause(); }
  else { S.lastNow = performance.now(); syncAudio(true); }
}

function syncAudio(force) {
  const a = S.audio;
  if (!a) return;
  const target = S.t / 1000;
  if (!S.playing || target < 0 || (a.duration && target >= a.duration)) {
    if (!a.paused) a.pause();
    return;
  }
  a.playbackRate = S.speed;
  if (force || a.paused || Math.abs(a.currentTime - target) > 0.12) {
    try { a.currentTime = Math.max(0, target); } catch (e) { /* not ready yet */ }
    a.play().then(() => { S.audioBlocked = false; })
            .catch(() => { S.audioBlocked = true; });
  }
}

function seekTo(t) {
  S.t = clamp(t, S.origin, S.endT);
  const evs = S.events[0] ? S.events[0].events : [];
  S.hitIdx = upperBound(evs, S.t);
  syncAudio(true);
}

function upperBound(events, t) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid][0] <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function setSpeed(v) {
  S.speed = v;
  $("speed").value = String(v);
  if (S.audio) S.audio.playbackRate = v;
}

function fireHitSounds() {
  const e0 = S.events[0];
  if (!e0) return;
  const evs = e0.events;
  let n = 0;
  while (S.hitIdx < evs.length && evs[S.hitIdx][0] <= S.t) {
    if (evs[S.hitIdx][4] > 0 && n < 6) { playHitSound(); n++; }
    S.hitIdx++;
  }
}

function tick(now) {
  if (S.playing && !S.seeking) {
    S.t += (now - S.lastNow) * S.speed;
    const a = S.audio;
    if (a && !a.paused && a.duration) {
      const at = a.currentTime * 1000;
      if (Math.abs(at - S.t) > 60) S.t = at;        // audio is the master clock
    } else if (a && S.t >= 0) {
      syncAudio(false);
    }
    if (S.t >= S.endT) { S.t = S.endT; setPlaying(false); }
    fireHitSounds();
  }
  S.lastNow = now;
  draw();
  updateHUD();
  requestAnimationFrame(tick);
}

/* ── canvas helpers ────────────────────────────────────────────────── */

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [w, h];
}

function fieldTransform(rect) {
  const s = Math.min(rect.w / 512, rect.h / 384) * 0.92;
  const ox = rect.x + (rect.w - 512 * s) / 2;
  const oy = rect.y + (rect.h - 384 * s) / 2;
  return { s, ox, oy };
}
const tx = (tr, x) => tr.ox + x * tr.s;
const ty = (tr, y) => tr.oy + y * tr.s;

function objectAlpha(dt) {
  const FADE = 400;
  if (dt > S.preempt) return 0;
  if (dt > S.preempt - FADE) return (S.preempt - dt) / FADE;
  if (dt >= -HIT_LINGER) return 1;
  return 0;
}

/* ── drawing ───────────────────────────────────────────────────────── */

function activeFields(w, h) {
  const both = S.replays[0] && S.replays[1];
  if (S.mode === "split" && both) {
    return [
      { rect: { x: 0, y: 0, w: w / 2 - 1, h }, players: [0] },
      { rect: { x: w / 2 + 1, y: 0, w: w / 2 - 1, h }, players: [1] },
    ];
  }
  const players = [0, 1].filter(i => S.replays[i]);
  return [{ rect: { x: 0, y: 0, w, h }, players }];
}

function draw() {
  const [w, h] = fitCanvas();
  ctx.clearRect(0, 0, w, h);
  if (!S.map) return;

  const fields = activeFields(w, h);
  if (fields.length === 2) {
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
  }
  for (const f of fields) drawField(f);
  drawErrorBar(w, h);
}

function drawField(f) {
  const tr = fieldTransform(f.rect);
  const r = Math.max(4, S.radius * tr.s);

  // Playfield border
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  roundRect(tx(tr, 0) - 10, ty(tr, 0) - 10, 512 * tr.s + 20, 384 * tr.s + 20, 8);
  ctx.stroke();

  // Visible objects
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

  for (const p of f.players) drawJudgments(p, tr, f.players.length);
  for (const p of f.players) drawCursor(p, tr, f.rect);
  drawKeyOverlay(f);
}

function roundRect(x, y, w, h, rad) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
  ctx.rect(x, y, w, h);
}

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
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color.map(c => c * .5), alpha);
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 4.6);
  ctx.strokeStyle = rgba(color, alpha);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = rgba([255, 255, 255], alpha);
  ctx.stroke();
}

function drawComboNumber(o, x, y, r, alpha) {
  ctx.fillStyle = rgba([255, 255, 255], alpha);
  ctx.font = `700 ${Math.max(9, r * .85)}px -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(o.cn), x, y + 1);
}

function drawApproach(x, y, ar, color, alpha) {
  if (ar > 1100) return;
  // size quantized so the sprite cache stays small
  const img = sprite("approachcircle", Math.max(8, Math.round(ar * 2 / 6) * 6), color);
  if (img) {
    ctx.globalAlpha = alpha * .95;
    ctx.drawImage(img, x - img.width / 2, y - img.height / 2);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.beginPath();
  ctx.arc(x, y, ar, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = rgba(color, alpha * .9);
  ctx.stroke();
}

function drawCircle(o, tr, r) {
  const dt = o.t - S.t;
  if (dt < -HIT_LINGER) return;
  const alpha = objectAlpha(dt);
  const color = PALETTE[o.ci % PALETTE.length];
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
  const color = PALETTE[o.ci % PALETTE.length];

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(tx(tr, o.path[0][0]), ty(tr, o.path[0][1]));
  for (let i = 1; i < o.path.length; i++)
    ctx.lineTo(tx(tr, o.path[i][0]), ty(tr, o.path[i][1]));
  ctx.lineWidth = r * 2;
  ctx.strokeStyle = rgba(SKIN.sliderBorder || [255, 255, 255], alpha * .8);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, r * 2 - 7);
  ctx.strokeStyle = rgba(SKIN.sliderTrack || [38, 37, 56], alpha * .94);
  ctx.stroke();

  // tail + head
  const tailPt = o.slides % 2 === 0 ? o.path[0] : o.path[o.path.length - 1];
  drawCircleShape(tx(tr, tailPt[0]), ty(tr, tailPt[1]), r, color, alpha);
  const hx = tx(tr, o.x), hy = ty(tr, o.y);
  drawCircleShape(hx, hy, r, color, alpha);
  drawComboNumber(o, hx, hy, r, alpha);
  if (dt > 0) drawApproach(hx, hy, r * (1 + 3 * dt / S.preempt), color, alpha);

  // ball
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
      ctx.beginPath(); ctx.arc(bsx, bsy, Math.max(2, r * .45), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.9)"; ctx.fill();
      ctx.drawImage(follow, bsx - follow.width / 2, bsy - follow.height / 2);
    } else {
      ctx.beginPath(); ctx.arc(bsx, bsy, r * 1.35, 0, Math.PI * 2);
      ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke();
      ctx.beginPath(); ctx.arc(bsx, bsy, r * .82, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color, 1); ctx.fill();
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
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(200,200,210,.8)";
  ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, Math.PI * 2); ctx.stroke();
  if (innerR > 2) {
    ctx.strokeStyle = "rgba(255,255,255,.85)";
    ctx.beginPath(); ctx.arc(cx, cy, innerR, 0, Math.PI * 2); ctx.stroke();
  }
}

/* ── replay lookups ────────────────────────────────────────────────── */

function frameIndexAt(frames, t) {
  let lo = 0, hi = frames.length - 1;
  if (t <= frames[0][0]) return 0;
  if (t >= frames[hi][0]) return hi;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid][0] <= t) lo = mid; else hi = mid;
  }
  return lo;
}

function cursorAt(frames, t) {
  if (!frames.length) return [256, 192];
  const i = frameIndexAt(frames, t);
  const f0 = frames[i], f1 = frames[Math.min(i + 1, frames.length - 1)];
  if (t <= f0[0] || f1[0] === f0[0]) return [f0[1], f0[2]];
  if (t >= f1[0]) return [f1[1], f1[2]];
  const s = (t - f0[0]) / (f1[0] - f0[0]);
  return [f0[1] + (f1[1] - f0[1]) * s, f0[2] + (f1[2] - f0[2]) * s];
}

function keysAt(frames, t) {
  if (!frames.length || t < frames[0][0]) return 0;
  return frames[frameIndexAt(frames, t)][3];
}

function drawCursor(p, tr, rect) {
  const frames = S.replays[p].frames;
  const color = PLAYER_COLORS[p];
  // Tint only when comparing two players — single replay keeps the skin look
  const tint = (S.replays[0] && S.replays[1]) ? color : null;

  if (SKIN.el.cursor) {
    const pxOf = name => {
      const e = SKIN.el[name];
      return Math.max(8, (e.w / e.scale) * (rect.h / 768) * CURSOR_SKIN_SCALE);
    };
    const trailImg = SKIN.el.cursortrail ? sprite("cursortrail", pxOf("cursortrail"), tint) : null;
    if (trailImg) {
      const N = 14;
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

  const TRAIL = 26;
  for (let k = TRAIL; k > 0; k--) {
    const [px, py] = cursorAt(frames, S.t - k * 10);
    const frac = k / TRAIL;
    ctx.beginPath();
    ctx.arc(tx(tr, px), ty(tr, py), Math.max(1, 9 * tr.s * 1.45 * frac * .5), 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, Math.pow(1 - frac, .35) * .35);
    ctx.fill();
  }
  const [px, py] = cursorAt(frames, S.t);
  const x = tx(tr, px), y = ty(tr, py);
  const cr = Math.max(5, 9 * tr.s * 1.45);
  ctx.save();
  ctx.shadowColor = rgba(color, .9);
  ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 1); ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.beginPath(); ctx.arc(x, y, cr, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "#fff"; ctx.fill();
}

/* ── judgments / error bar / key overlay ───────────────────────────── */

function eventsWindow(slot, windowMs) {
  const ed = S.events[slot];
  if (!ed) return [];
  const evs = ed.events;
  const hi = upperBound(evs, S.t);
  const out = [];
  for (let i = hi - 1; i >= 0; i--) {
    if (S.t - evs[i][0] > windowMs) break;
    out.push(evs[i]);
  }
  return out;
}

function drawJudgments(slot, tr, nPlayers) {
  for (const ev of eventsWindow(slot, JUDGE_POPUP_MS)) {
    const judg = ev[4];
    if (judg === 300) continue;                 // perfect hits stay clean
    const life = clamp((S.t - ev[0]) / JUDGE_POPUP_MS, 0, 1);
    const alpha = 1 - Math.pow(life, 1.5);
    const color = JUDGE_COLORS[judg];
    let x = tx(tr, ev[5]), y = ty(tr, ev[6]) - 10 * life;
    if (nPlayers === 2) x += slot === 0 ? -14 : 14;
    ctx.font = `800 ${judg === 0 ? 19 : 15}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = rgba(color, alpha);
    ctx.fillText(judg === 0 ? "✕" : String(judg), x, y);
  }
}

function drawErrorBar(w, h) {
  const e0 = S.events[0];
  if (!e0) return;
  const [w300, w100, w50] = e0.windows;
  const barW = Math.min(260, w * .3), barH = 6;
  const cx = w / 2, by = h - 18;

  const zone = (ms, color, a) => {
    const half = barW / 2 * Math.min(1, ms / w50);
    ctx.fillStyle = rgba(color, a);
    ctx.fillRect(cx - half, by, half * 2, barH);
  };
  zone(w50, JUDGE_COLORS[50], .30);
  zone(w100, JUDGE_COLORS[100], .35);
  zone(w300, JUDGE_COLORS[300], .45);
  ctx.fillStyle = "rgba(255,255,255,.9)";
  ctx.fillRect(cx - .5, by - 3, 1, barH + 6);

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
    const states = [["K1", k1], ["K2", k2],
                    ["M1", !!(keys & 1) && !k1], ["M2", !!(keys & 2) && !k2]];
    const right = p === 0 || S.mode === "split";
    const x = right ? f.rect.x + f.rect.w - box - 10 : f.rect.x + 10;
    let y = f.rect.y + f.rect.h / 2 - (4 * box + 3 * gap) / 2;
    const color = PLAYER_COLORS[p];
    for (const [lbl, on] of states) {
      ctx.fillStyle = on ? rgba(color, .9) : "rgba(255,255,255,.06)";
      roundRect(x, y, box, box, 6); ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = on ? rgba(color, 1) : "rgba(255,255,255,.18)";
      roundRect(x, y, box, box, 6); ctx.stroke();
      ctx.font = "700 10px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = on ? "#15141f" : "rgba(255,255,255,.4)";
      ctx.fillText(lbl, x + box / 2, y + box / 2 + .5);
      y += box + gap;
    }
  }
}

/* ── HUD ───────────────────────────────────────────────────────────── */

function fmtTime(ms) {
  const neg = ms < 0;
  const s = Math.abs(ms) / 1000;
  return `${neg ? "-" : ""}${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function updateHUD() {
  if (!S.map) return;
  const cs = Math.abs(S.t / 1000);
  $("clock").textContent =
    `${S.t < 0 ? "-" : ""}${String(Math.floor(cs / 60)).padStart(2, "0")}:${(cs % 60).toFixed(2).padStart(5, "0")}`;

  for (const slot of [0, 1]) {
    if (!S.replays[slot] || !S.events[slot]) continue;
    const evs = S.events[slot].events;
    const i = upperBound(evs, S.t) - 1;
    const ev = i >= 0 ? evs[i] : null;
    $(`p${slot}-score`).textContent = (ev ? ev[1] : 0).toLocaleString("en-US");
    $(`p${slot}-combo`).textContent = (ev ? ev[2] : 0) + "x";
    $(`p${slot}-acc`).textContent = (ev ? ev[3] : 100).toFixed(2) + "%";
    $(`p${slot}-counts`).textContent =
      ev ? `100×${ev[9]}  50×${ev[10]}  ✕${ev[11]}` : "";
  }

  if (!S.seeking) {
    const frac = (S.t - S.origin) / (S.endT - S.origin);
    $("seek").value = Math.round(clamp(frac, 0, 1) * 1000);
  }
  $("time-label").textContent = `${fmtTime(S.t - S.origin)} / ${fmtTime(S.endT - S.origin)}`;

  const first = S.map.objects.length ? S.map.objects[0].t : 0;
  $("btn-skip").classList.toggle(
    "hidden", !(S.t < first - S.preempt - 1000 && S.playing));

  $("state-line").textContent =
    !S.playing && S.t < S.endT ? "PAUSED"
    : S.audioBlocked ? "click anywhere to enable audio"
    : "";
}

/* ── UI wiring ─────────────────────────────────────────────────────── */

function skipIntro() {
  const first = S.map && S.map.objects.length ? S.map.objects[0].t : null;
  if (first !== null && S.t < first - S.preempt - 1000)
    seekTo(first - S.preempt - 600);
}

function toggleMode() {
  if (!(S.replays[0] && S.replays[1])) return;
  S.mode = S.mode === "overlay" ? "split" : "overlay";
  $("btn-mode").textContent = S.mode === "overlay" ? "SPLIT" : "OVERLAY";
}

window.addEventListener("dragover", e => {
  e.preventDefault();
  $("dropzone").classList.add("drag");
});
window.addEventListener("dragleave", e => {
  if (!e.relatedTarget) $("dropzone").classList.remove("drag");
});
window.addEventListener("drop", e => {
  e.preventDefault();
  $("dropzone").classList.remove("drag");
  if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
});

$("btn-replays").onclick = () => $("file-replays").click();
$("btn-map").onclick = () => $("file-map").click();
$("file-replays").onchange = e => { handleFiles([...e.target.files]); e.target.value = ""; };
$("file-map").onchange = e => { handleFiles([...e.target.files]); e.target.value = ""; };

$("btn-clear").onclick = async () => {
  await fetch("/api/clear", { method: "POST" });
  S.replays = [null, null];
  S.events = [null, null];
  S.map = null;
  $("btn-watch").classList.add("hidden");
  chip("chip-r0", "waiting for file…");
  chip("chip-r1", "optional");
  chip("chip-map", "auto-download after replay");
  toast("Session cleared.");
};

$("btn-watch").onclick = () => {
  $("btn-watch").classList.add("hidden");
  enterPlayer();
};

$("btn-play").onclick = () => setPlaying(!S.playing);
$("btn-restart").onclick = () => { seekTo(S.origin); setPlaying(true); };
$("btn-skip").onclick = skipIntro;
$("btn-mode").onclick = toggleMode;
$("btn-files").onclick = () => { setPlaying(false); landing.classList.remove("hidden"); player.classList.add("hidden"); };
$("btn-full").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
};
$("btn-help").onclick = () => $("help-modal").classList.toggle("hidden");
$("help-modal").onclick = () => $("help-modal").classList.add("hidden");

$("speed").onchange = e => setSpeed(parseFloat(e.target.value));
$("vol-music").oninput = e => { if (S.audio) S.audio.volume = e.target.value / 100; };
$("vol-sfx").oninput = e => { if (S.sfxGain) S.sfxGain.gain.value = e.target.value / 100; };

const seekEl = $("seek");
seekEl.addEventListener("pointerdown", () => { S.seeking = true; });
seekEl.addEventListener("input", () => {
  const frac = seekEl.value / 1000;
  S.t = S.origin + frac * (S.endT - S.origin);
});
seekEl.addEventListener("change", () => {
  S.seeking = false;
  seekTo(S.t);
});

document.addEventListener("click", () => {
  if (S.audioBlocked && S.playing) syncAudio(true);
  if (S.actx && S.actx.state === "suspended") S.actx.resume();
});

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
    if (e.code === "Space") e.target.blur(); else return;
  }
  if (!S.started) {
    if (e.code === "Escape" && S.map) maybeStart();
    return;
  }
  switch (e.code) {
    case "Space": e.preventDefault(); setPlaying(!S.playing); break;
    case "KeyR": seekTo(S.origin); setPlaying(true); break;
    case "KeyS": skipIntro(); break;
    case "Tab": e.preventDefault(); toggleMode(); break;
    case "ArrowLeft": seekTo(S.t - 5000); break;
    case "ArrowRight": seekTo(S.t + 5000); break;
    case "Minus": case "NumpadSubtract": {
      const opts = [.5, .75, 1, 1.25, 1.5, 2];
      const i = Math.max(0, opts.indexOf(S.speed) - 1);
      setSpeed(opts[i < 0 ? 2 : i]); break;
    }
    case "Equal": case "NumpadAdd": {
      const opts = [.5, .75, 1, 1.25, 1.5, 2];
      const idx = opts.indexOf(S.speed);
      setSpeed(opts[Math.min(opts.length - 1, idx < 0 ? 2 : idx + 1)]); break;
    }
    case "KeyF": $("btn-full").click(); break;
    case "KeyH": $("btn-help").click(); break;
    case "Escape":
      if (!$("help-modal").classList.contains("hidden")) $("help-modal").classList.add("hidden");
      else if (landing.classList.contains("hidden")) $("btn-files").click();
      else if (S.map && S.replays.some(Boolean)) { landing.classList.add("hidden"); player.classList.remove("hidden"); setPlaying(true); }
      break;
  }
});
