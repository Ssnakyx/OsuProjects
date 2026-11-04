/* Clip export: record part or all of a replay as a video (MP4 where the
   browser can encode it, WebM otherwise) or as an animated GIF.

   Both paths draw the playfield at a fixed 16:9 layout (S.exportView makes
   render.js lay the field out at 1280×720 logical px, whatever the window
   size), then compose background + field + a score overlay into an
   offscreen canvas:

     • video: real-time. The replay plays from "from" to "to" while
       MediaRecorder captures that canvas, plus the music and hit sounds
       routed through WebAudio;
     • GIF: offline. Each frame is rendered at its exact time, so it is
       smooth whatever the machine, and encoded by gif.js. */

import { $, S, OPT, toast, clamp, canvas, rgba } from "./core.js";
import { PLAYER_COLORS, JUDGE_COLORS } from "./config.js";
import { draw } from "./render.js";
import { updateHUD } from "./stats.js";
import { setPlaying, seekTo, initSfx } from "./playback.js";
import { closeResults } from "./screens.js";
import { GifEncoder } from "./gif.js";

const MAX_GIF_MS = 20000;
const VIDEO_TYPES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const GIF_SIZES = { s: { w: 360, fps: 20 }, m: { w: 480, fps: 20 }, l: { w: 640, fps: 25 } };

let videoMime;
function videoType() {
  if (videoMime !== undefined) return videoMime;
  videoMime = null;
  if (window.MediaRecorder && HTMLCanvasElement.prototype.captureStream) {
    for (const t of VIDEO_TYPES) { try { if (MediaRecorder.isTypeSupported(t)) { videoMime = t; break; } } catch (e) {} }
  }
  return videoMime;
}
const videoExt = () => (videoType() || "").startsWith("video/mp4") ? "mp4" : "webm";

/* ── state ─────────────────────────────────────────────────────────── */

const X = {
  from: 0, to: 0,
  format: "video",
  job: null,          // { cancelled } while rendering
  url: null, name: "",
};

const rel = t => t - S.origin;                     // times shown to the user
function fmtClock(ms) {
  const neg = ms < 0, s = Math.abs(ms) / 1000;
  return `${neg ? "-" : ""}${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}
function parseClock(str) {
  const m = String(str).trim().match(/^(-)?(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const v = ((+m[2] || 0) * 60 + parseFloat(m[3].replace(",", "."))) * 1000;
  return m[1] ? -v : v;
}

/* ── modal ─────────────────────────────────────────────────────────── */

function view(which) {
  for (const id of ["ex-form", "ex-busy", "ex-done"]) $(id).classList.toggle("hidden", id !== which);
  $("ex-cancel").textContent = which === "ex-busy" ? "Stop" : which === "ex-done" ? "New clip" : "Cancel";
  $("ex-go").classList.toggle("hidden", which === "ex-busy");
  $("ex-go").textContent = which === "ex-done" ? "Download" : X.format === "gif" ? "Make GIF" : "Record";
}

export function openExport() {
  if (!S.map || !S.map.objects) { toast("Load a replay first.", "info"); return; }
  if (X.job) { $("export-modal").classList.remove("hidden"); return; }
  closeResults();
  setPlaying(false);
  // Default range: the whole replay when we're at the start, else the
  // seconds just before the current moment (the thing you want to share).
  if (S.t - S.origin < 2000) { X.from = S.origin; X.to = S.endT; }
  else { X.from = Math.max(S.origin, S.t - 8000); X.to = Math.min(S.endT, S.t + 2000); }
  if (!videoType()) X.format = "gif";
  syncForm();
  view("ex-form");
  $("export-modal").classList.remove("hidden");
}

export function closeExport() {
  if (X.job) { X.job.cancelled = true; return; }
  $("export-modal").classList.add("hidden");
  $("ex-video").removeAttribute("src"); $("ex-video").load();
}
export const exportOpen = () => !$("export-modal").classList.contains("hidden");

function syncForm() {
  $("ex-from").value = fmtClock(rel(X.from));
  $("ex-to").value = fmtClock(rel(X.to));
  document.querySelectorAll(".ex-fmt").forEach(b => b.classList.toggle("active", b.dataset.fmt === X.format));
  const vid = !!videoType();
  $("ex-fmt-video").classList.toggle("disabled", !vid);
  $("ex-fmt-video-sub").textContent = vid ? `${videoExt().toUpperCase()} · with sound` : "not supported by this browser";
  const gif = X.format === "gif";
  $("ex-res-row").classList.toggle("hidden", gif);
  $("ex-gif-row").classList.toggle("hidden", !gif);
  $("ex-audio-wrap").classList.toggle("hidden", gif);
  const len = X.to - X.from;
  const speed = S.speed !== 1 ? ` · played at ${S.speed}×` : "";
  let note = `Length ${fmtClock(len / S.speed)}${speed}.`;
  if (gif) {
    note += len > MAX_GIF_MS ? ` GIFs are limited to ${MAX_GIF_MS / 1000} s — the clip will be cut.` : " Rendered frame by frame, no sound.";
  } else {
    note += " Recording runs in real time: keep this tab in front until it's done.";
  }
  $("ex-note").textContent = note;
  $("ex-go").textContent = gif ? "Make GIF" : "Record";
  document.querySelectorAll(".ex-preset").forEach(b => b.classList.remove("active"));
}

function readRange() {
  const f = parseClock($("ex-from").value), t = parseClock($("ex-to").value);
  if (f !== null) X.from = clamp(S.origin + f, S.origin, S.endT);
  if (t !== null) X.to = clamp(S.origin + t, S.origin, S.endT);
  if (X.to - X.from < 500) X.to = Math.min(S.endT, X.from + 500);
}

function preset(kind) {
  if (kind === "all") { X.from = S.origin; X.to = S.endT; }
  else if (kind === "before") { X.to = clamp(S.t, S.origin + 1000, S.endT); X.from = Math.max(S.origin, X.to - 10000); }
  else if (kind === "after") { X.from = clamp(S.t, S.origin, S.endT - 1000); X.to = Math.min(S.endT, X.from + 10000); }
  syncForm();
  const b = document.querySelector(`.ex-preset[data-p="${kind}"]`);
  if (b) b.classList.add("active");
}

/* ── composing a frame ─────────────────────────────────────────────── */

function loadImg(url) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
}

/* Map background, cover-fitted, dimmed and blurred like the player's. */
async function backgroundLayer(W, H) {
  if (!S.map.bg) return null;
  const img = await loadImg(S.map.bg);
  if (!img) return null;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const s = Math.max(W / img.width, H / img.height) * 1.04;
  const dim = (100 - OPT.bgDim) / 100;
  const canFilter = "filter" in g;
  if (canFilter) g.filter = `brightness(${dim}) blur(${OPT.bgBlur * H / 720}px)`;
  g.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s);
  if (!canFilter) { g.fillStyle = `rgba(0,0,0,${1 - dim})`; g.fillRect(0, 0, W, H); }
  return c;
}

const txt = id => ($(id) ? $(id).textContent : "");

function drawHud(g, W, H) {
  const u = H / 720;
  const font = (wt, px) => `${wt} ${Math.round(px * u)}px "Outfit", "Inter", system-ui, sans-serif`;
  g.save();
  g.shadowColor = "rgba(0,0,0,.6)"; g.shadowBlur = 8 * u;
  g.textBaseline = "top";
  for (const slot of [0, 1]) {
    if (!S.replays[slot]) continue;
    const right = slot === 1;
    const x = right ? W - 30 * u : 30 * u, dir = right ? -1 : 1;
    let y = 26 * u;
    g.textAlign = right ? "right" : "left";
    g.fillStyle = rgba(PLAYER_COLORS[slot], 1);
    g.fillRect(right ? x - 4 * u : x, y + 1 * u, 4 * u, 19 * u);
    const mods = (txt(`p${slot}-mods`).match(/../g) || []).join(" ");
    g.font = font(600, 18); g.fillStyle = "#fff";
    g.fillText(txt(`p${slot}-name`) + (mods ? `  +${mods}` : ""), x + dir * 12 * u, y);
    y += 30 * u;
    g.font = font(700, 40);
    g.fillText(txt(`p${slot}-score`), x, y);
    y += 48 * u;
    g.font = font(600, 19); g.fillStyle = "rgba(255,255,255,.92)";
    g.fillText(`${txt(`p${slot}-acc`)}   ${txt(`p${slot}-combo`)}`, x, y);
    y += 28 * u;
    // judgment counts, coloured like the HUD
    g.font = font(600, 15);
    const parts = [[txt(`n300_${slot}`), JUDGE_COLORS[300]], [txt(`n100_${slot}`), JUDGE_COLORS[100]],
                   [txt(`n50_${slot}`), JUDGE_COLORS[50]], [txt(`nx_${slot}`) + "×", JUDGE_COLORS[0]]];
    const gap = 14 * u;
    if (right) parts.reverse();
    let cx = x;
    for (const [s, col] of parts) {
      const w = g.measureText(s).width;
      g.fillStyle = rgba(col, 1);
      g.fillText(s, cx, y);
      cx += dir * (w + gap);
    }
  }
  // map line, bottom-left
  const m = S.map;
  let title = `${m.artist} - ${m.title} [${m.version}]`;
  g.font = font(500, 14); g.textAlign = "left"; g.textBaseline = "bottom";
  g.fillStyle = "rgba(255,255,255,.72)";
  const maxW = W * 0.36;
  while (title.length > 8 && g.measureText(title).width > maxW) title = title.slice(0, -2);
  if (title !== `${m.artist} - ${m.title} [${m.version}]`) title = title.trimEnd() + "…";
  g.fillText(title, 30 * u, H - 22 * u);
  g.restore();
}

function compose(g, W, H, bg, hud) {
  g.fillStyle = "#0c0a10";
  g.fillRect(0, 0, W, H);
  if (bg) g.drawImage(bg, 0, 0);
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, W, H);
  if (hud) drawHud(g, W, H);
}

/* ── video (MediaRecorder, real time) ──────────────────────────────── */

const mediaNodes = new WeakMap();   // an <audio> can only be wrapped once
function mediaNode(a) {
  if (!a || !S.actx) return null;
  let n = mediaNodes.get(a);
  if (!n) {
    n = S.actx.createMediaElementSource(a);
    n.connect(S.actx.destination);   // keep it audible in the page
    mediaNodes.set(a, n);
  }
  return n;
}

function seekAudio(ms) {
  return new Promise(res => {
    const a = S.audio;
    if (!a) return res();
    const done = () => res();
    a.addEventListener("seeked", done, { once: true });
    setTimeout(done, 2000);
    try { a.currentTime = Math.max(0, ms / 1000); } catch (e) { res(); }
  });
}

async function recordVideo(job, from, to, opt) {
  const H = opt.h, W = Math.round(H * 16 / 9);
  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const g = rc.getContext("2d");
  const bg = await backgroundLayer(W, H);
  S.exportView = { w: 1280, h: 720, dpr: H / 720 };
  showPreview(rc);

  // sound: music element + hit sounds → a MediaStream for the recorder
  let dest = null;
  const tapped = [];
  if (opt.audio) {
    try {
      initSfx();
      if (S.actx.state === "suspended") await S.actx.resume();
      dest = S.actx.createMediaStreamDestination();
      const m = mediaNode(S.audio);
      if (m) { m.connect(dest); tapped.push(m); }
      if (S.sfxGain) { S.sfxGain.connect(dest); tapped.push(S.sfxGain); }
    } catch (e) { dest = null; toast("Couldn't capture the sound — the video will be silent.", "warn"); }
  }

  const vstream = rc.captureStream(60);
  const tracks = [...vstream.getVideoTracks(), ...(dest ? dest.stream.getAudioTracks() : [])];
  const mime = videoType();
  const rec = new MediaRecorder(new MediaStream(tracks), {
    mimeType: mime, videoBitsPerSecond: H >= 1080 ? 16e6 : 8e6, audioBitsPerSecond: 192000,
  });
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise(r => { rec.onstop = r; });

  setPlaying(false);
  seekTo(from);
  await seekAudio(from);
  draw(); updateHUD(); compose(g, W, H, bg, opt.hud);
  // stop just before the end so the results screen doesn't pop mid-record
  const end = Math.min(to, S.endT - 30);
  rec.start(500);
  setPlaying(true);

  await new Promise(resolve => {
    const loop = () => {
      if (job.cancelled || S.t >= end || !S.playing) return resolve();
      compose(g, W, H, bg, opt.hud);
      progress((S.t - from) / (end - from), `Recording… ${fmtClock(Math.max(0, S.t - from) / S.speed)} / ${fmtClock((end - from) / S.speed)}`);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  compose(g, W, H, bg, opt.hud);
  setPlaying(false);
  await new Promise(r => setTimeout(r, 120));      // let the last frame land
  rec.stop();
  await stopped;
  for (const n of tapped) { try { n.disconnect(dest); } catch (e) {} }
  vstream.getTracks().forEach(t => t.stop());
  S.exportView = null;
  closeResults();
  if (job.cancelled) return null;
  return new Blob(chunks, { type: mime.split(";")[0] });
}

/* ── GIF (offline, frame by frame) ─────────────────────────────────── */

async function renderGif(job, from, to, size) {
  const { w: W, fps } = GIF_SIZES[size] || GIF_SIZES.m;
  const H = Math.round(W * 9 / 16);
  to = Math.min(to, from + MAX_GIF_MS);
  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const g = rc.getContext("2d", { willReadFrequently: true });
  const bg = await backgroundLayer(W, H);
  const t0 = S.t;
  setPlaying(false);
  S.exportView = { w: 1280, h: 720, dpr: H / 720 };
  showPreview(rc);

  const hud = $("ex-hud").checked;
  const frameAt = t => {
    S.t = t;
    updateHUD(); draw(); compose(g, W, H, bg, hud);
    return g.getImageData(0, 0, W, H).data;
  };
  const step = 1000 / fps * S.speed;                 // song ms per GIF frame
  const n = Math.max(1, Math.floor((to - from) / step) + 1);
  const enc = new GifEncoder(W, H);
  try {
    // palette from a handful of frames spread over the clip
    for (let i = 0; i < 8; i++) enc.addSample(frameAt(from + (to - from) * i / 7));
    enc.buildPalette();
    const delay = Math.round(100 / fps);
    for (let i = 0; i < n; i++) {
      if (job.cancelled) break;
      enc.addFrame(frameAt(from + i * step), delay);
      if (i % 2 === 0) {
        progress(i / n, `Rendering GIF… frame ${i + 1} / ${n}`);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    S.exportView = null;
    seekTo(t0);
  }
  if (job.cancelled) return null;
  progress(1, "Finishing…");
  return enc.finish();
}

/* ── running a job ─────────────────────────────────────────────────── */

function showPreview(rc) {
  const box = $("ex-preview");
  box.innerHTML = "";
  rc.className = "ex-live";
  box.appendChild(rc);
}

function progress(f, label) {
  $("ex-bar").style.width = clamp(f, 0, 1) * 100 + "%";
  if (label) $("ex-status").textContent = label;
}

const fmtBytes = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
const safe = s => String(s || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();

function fileName(ext) {
  const r = S.replays[0] || S.replays[1];
  const who = r && r.player ? safe(r.player) + " - " : "";
  const m = S.map;
  return `${who}${safe(m.artist)} - ${safe(m.title)} [${safe(m.version)}].${ext}`.slice(0, 180);
}

async function start() {
  readRange();
  const gif = X.format === "gif";
  if (!gif && !videoType()) { toast("This browser can't record video — try the GIF format.", "error"); return; }
  const job = { cancelled: false };
  X.job = job;
  view("ex-busy");
  progress(0, gif ? "Preparing GIF…" : "Starting…");
  let blob = null;
  try {
    blob = gif
      ? await renderGif(job, X.from, X.to, $("ex-gif").value)
      : await recordVideo(job, X.from, X.to, { h: +$("ex-res").value, audio: $("ex-audio").checked, hud: $("ex-hud").checked });
  } catch (e) {
    console.error(e);
    toast("Export failed: " + (e && e.message ? e.message : e), "error", 6000);
  }
  S.exportView = null;
  X.job = null;
  if (!blob || !blob.size) { view("ex-form"); syncForm(); if (job.cancelled) toast("Export cancelled.", "info", 2000); return; }

  if (X.url) URL.revokeObjectURL(X.url);
  X.url = URL.createObjectURL(blob);
  X.name = fileName(gif ? "gif" : videoExt());
  const vid = $("ex-video"), img = $("ex-img");
  vid.classList.toggle("hidden", gif); img.classList.toggle("hidden", !gif);
  if (gif) img.src = X.url; else { vid.src = X.url; }
  $("ex-file").textContent = `${X.name} · ${fmtBytes(blob.size)}`;
  view("ex-done");
}

function download() {
  if (!X.url) return;
  const a = document.createElement("a");
  a.href = X.url; a.download = X.name;
  document.body.appendChild(a); a.click(); a.remove();
}

export function bindExport() {
  $("btn-export").onclick = openExport;
  $("export-close").onclick = closeExport;
  $("export-modal").onclick = e => { if (e.target === $("export-modal") && !X.job) closeExport(); };
  $("ex-cancel").onclick = () => {
    if (X.job) { X.job.cancelled = true; return; }
    if (!$("ex-done").classList.contains("hidden")) { $("ex-video").pause(); view("ex-form"); syncForm(); return; }
    closeExport();
  };
  $("ex-go").onclick = () => { if (!$("ex-done").classList.contains("hidden")) download(); else start(); };
  document.querySelectorAll(".ex-fmt").forEach(b => {
    b.onclick = () => { if (b.classList.contains("disabled")) return; readRange(); X.format = b.dataset.fmt; syncForm(); };
  });
  document.querySelectorAll(".ex-preset").forEach(b => { b.onclick = () => preset(b.dataset.p); });
  $("ex-from-now").onclick = () => { readRange(); X.from = clamp(S.t, S.origin, S.endT - 500); if (X.to <= X.from) X.to = Math.min(S.endT, X.from + 10000); syncForm(); };
  $("ex-to-now").onclick = () => { readRange(); X.to = clamp(S.t, S.origin + 500, S.endT); if (X.from >= X.to) X.from = Math.max(S.origin, X.to - 10000); syncForm(); };
  for (const id of ["ex-from", "ex-to"]) $(id).addEventListener("change", () => { readRange(); syncForm(); });
}
