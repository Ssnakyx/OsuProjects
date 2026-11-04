/* osu! skin (.osk) support — entirely in the browser.

   An .osk is a zip. We read it with a tiny zip reader (DecompressionStream,
   no library), parse skin.ini, and decode the gameplay sprites we draw.
   The same code serves both the local server and the static Netlify build:

     • a skin the user drops / picks (.osk) is kept in IndexedDB and reloaded
       on the next visit;
     • in server mode, an .osk sitting in the project folder is used when the
       user hasn't chosen one.

   Elements follow osu!stable conventions: "@2x" HD variants, animated
   "name-0, name-1…" frames, and 1×1 placeholder images meaning "hide this". */

import { SKIN, rgba } from "./core.js";
import { COMBO_COLORS } from "./config.js";
import { api } from "./api.js";

/* ── minimal zip reader ────────────────────────────────────────────── */

const td = new TextDecoder("utf-8");
const td437 = new TextDecoder("latin1");

function findEOCD(dv) {
  for (let i = dv.byteLength - 22; i >= Math.max(0, dv.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error("not a zip archive");
}

/* Returns Map(lowercased path → { name, read(): Promise<Uint8Array> }). */
export function readZip(buf) {
  const dv = new DataView(buf);
  const eocd = findEOCD(dv);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const raw = new Uint8Array(buf, p + 46, nlen);
    const name = ((flags & 0x800) ? td : td437).decode(raw).replace(/\\/g, "/");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    out.set(name.toLowerCase(), {
      name,
      async read() {
        const lnlen = dv.getUint16(loff + 26, true), lxlen = dv.getUint16(loff + 28, true);
        const data = new Uint8Array(buf, loff + 30 + lnlen + lxlen, csize);
        if (method === 0) return data;
        if (method !== 8) throw new Error("unsupported zip compression");
        const ds = new DecompressionStream("deflate-raw");
        const stream = new Blob([data]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
    });
  }
  return out;
}

/* ── skin.ini ──────────────────────────────────────────────────────── */

function parseColor(v) {
  const n = (v.split("//")[0].match(/\d+/g) || []).map(Number);
  return n.length >= 3 ? [Math.min(255, n[0]), Math.min(255, n[1]), Math.min(255, n[2])] : null;
}

export function parseIni(text) {
  const ini = {
    name: "", author: "", combo: {}, sliderBorder: null, sliderTrack: null, sliderBall: null,
    hitCirclePrefix: "default", hitCircleOverlap: -2,
    cursorRotate: true, cursorExpand: true, cursorCentre: true,
    allowSliderBallTint: false, sliderBallFlip: true, hitCircleOverlayAboveNumber: true,
    animationFramerate: -1, version: "1.0",
  };
  let section = "";
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("[") && line.endsWith("]")) { section = line.slice(1, -1).toLowerCase(); continue; }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    const bool = v.split("//")[0].trim() !== "0";
    const num = parseFloat(v);
    if (section === "general" || section === "") {
      if (k === "name" && !ini.name) ini.name = v;
      else if (k === "author") ini.author = v;
      else if (k === "version") ini.version = v;
      else if (k === "cursorrotate") ini.cursorRotate = bool;
      else if (k === "cursorexpand") ini.cursorExpand = bool;
      else if (k === "cursorcentre") ini.cursorCentre = bool;
      else if (k === "allowsliderballtint") ini.allowSliderBallTint = bool;
      else if (k === "sliderballflip") ini.sliderBallFlip = bool;
      else if (k === "hitcircleoverlayabovenumber" || k === "hitcircleoverlayabovenumer") ini.hitCircleOverlayAboveNumber = bool;
      else if (k === "animationframerate" && !isNaN(num)) ini.animationFramerate = num;
    } else if (section === "colours" || section === "colors") {
      const m = k.match(/^combo([1-8])$/);
      if (m) { const c = parseColor(v); if (c) ini.combo[+m[1]] = c; }
      else if (k === "sliderborder") ini.sliderBorder = parseColor(v);
      else if (k === "slidertrackoverride") ini.sliderTrack = parseColor(v);
      else if (k === "sliderball") ini.sliderBall = parseColor(v);
    } else if (section === "fonts") {
      if (k === "hitcircleprefix") ini.hitCirclePrefix = v.replace(/\\/g, "/");
      else if (k === "hitcircleoverlap" && !isNaN(num)) ini.hitCircleOverlap = num;
    }
  }
  return ini;
}

/* ── element catalogue ─────────────────────────────────────────────── */

const ELEMENTS = [
  "cursor", "cursormiddle", "cursortrail",
  "hitcircle", "hitcircleoverlay", "approachcircle",
  "sliderstartcircle", "sliderstartcircleoverlay", "sliderendcircle", "sliderendcircleoverlay",
  "sliderfollowcircle", "reversearrow", "followpoint",
  "sliderb", "sliderb-nd", "sliderb-spec",
  "hit0", "hit50", "hit100", "hit300",
  "spinner-circle", "spinner-approachcircle", "spinner-background",
  "spinner-top", "spinner-bottom", "spinner-middle", "spinner-middle2", "spinner-glow",
];
// Elements that may be animated as name-0, name-1, … (sliderb uses name0, name1…)
const ANIMATED = new Set(["hit0", "hit50", "hit100", "hit300", "sliderfollowcircle", "followpoint", "hitcircleoverlay"]);

function decodeImage(bytes) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadImage(files, prefix, base) {
  for (const [suffix, scale] of [["@2x.png", 2], [".png", 1], ["@2x.jpg", 2], [".jpg", 1]]) {
    const f = files.get((prefix + base + suffix).toLowerCase());
    if (!f) continue;
    try {
      const img = await decodeImage(await f.read());
      if (!img) continue;
      if (img.naturalWidth <= 2 && img.naturalHeight <= 2) return { hidden: true };
      return { img, scale, w: img.naturalWidth / scale, h: img.naturalHeight / scale };
    } catch (e) { /* corrupt entry: try the next variant */ }
  }
  return null;
}

async function loadElement(files, prefix, name) {
  const frames = [];
  if (ANIMATED.has(name) || name === "sliderb") {
    const sep = name === "sliderb" ? "" : "-";
    for (let i = 0; i < 120; i++) {
      const fr = await loadImage(files, prefix, `${name}${sep}${i}`);
      if (!fr) break;
      frames.push(fr);
    }
  }
  if (frames.length) {
    if (frames.every(f => f.hidden)) return { hidden: true };
    const vis = frames.filter(f => !f.hidden);
    return { ...vis[0], frames: vis };
  }
  return loadImage(files, prefix, name);
}

/* ── loading / persistence ─────────────────────────────────────────── */

const tintCache = new Map();

export function resetSkin() {
  for (const k of Object.keys(SKIN)) delete SKIN[k];
  Object.assign(SKIN, {
    present: false, name: "", author: "", source: "", el: {}, digits: [],
    colors: [], sliderBorder: null, sliderTrack: null, sliderBall: null, hitsound: null,
    ini: parseIni(""), palette: COMBO_COLORS,
  });
  tintCache.clear();
}
resetSkin();

/* Parse an .osk buffer into SKIN. Throws on anything that isn't a skin. */
export async function loadSkinBuffer(buf, fallbackName, source) {
  const files = readZip(buf);
  let iniKey = null;
  for (const k of [...files.keys()].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if (k === "skin.ini" || k.endsWith("/skin.ini")) { iniKey = k; break; }
  }
  // Skin root = where skin.ini lives; otherwise the folder holding hitcircle.png
  let prefix = iniKey ? iniKey.slice(0, -"skin.ini".length) : "";
  if (!iniKey) {
    const hc = [...files.keys()].find(k => /(^|\/)(hitcircle|cursor)(@2x)?\.png$/.test(k));
    if (hc) prefix = hc.slice(0, hc.lastIndexOf("/") + 1);
  }
  const ini = parseIni(iniKey ? td.decode(await files.get(iniKey).read()) : "");

  const el = {};
  await Promise.all(ELEMENTS.map(async name => {
    const e = await loadElement(files, prefix, name);
    if (e) el[name] = e;
  }));
  const numPrefix = ini.hitCirclePrefix.endsWith("/") ? ini.hitCirclePrefix : ini.hitCirclePrefix + "-";
  const digits = await Promise.all([...Array(10).keys()].map(d => loadImage(files, prefix, numPrefix + d)));

  // The skin's own hit sound (normal-hitnormal); blank/near-empty files are ignored.
  let hitsound = null;
  for (const ext of ["wav", "ogg", "mp3"]) {
    const f = files.get((prefix + "normal-hitnormal." + ext).toLowerCase());
    if (!f) continue;
    try { const b = await f.read(); if (b.byteLength > 2048) { hitsound = b.slice().buffer; break; } } catch (e) {}
  }

  const usable = Object.values(el).some(e => e && !e.hidden);
  if (!usable && !iniKey) throw new Error("no skin elements found in this file");

  resetSkin();
  SKIN.present = true;
  SKIN.source = source;
  SKIN.name = (ini.name || fallbackName || "skin").trim();
  SKIN.author = ini.author;
  SKIN.ini = ini;
  SKIN.el = el;
  SKIN.digits = digits.every(Boolean) ? digits : [];
  SKIN.colors = Object.keys(ini.combo).sort().map(k => ini.combo[k]);
  SKIN.palette = SKIN.colors.length ? SKIN.colors : COMBO_COLORS;
  SKIN.sliderBorder = ini.sliderBorder;
  SKIN.sliderTrack = ini.sliderTrack;
  SKIN.sliderBall = ini.sliderBall;
  SKIN.hitsound = hitsound;
  return SKIN;
}

const DBNAME = "orv-skin";
function skinDB() {
  return new Promise(res => {
    let r;
    try { r = indexedDB.open(DBNAME, 1); } catch (e) { return res(null); }
    r.onupgradeneeded = () => r.result.createObjectStore("skin");
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
}
async function dbDo(mode, fn) {
  const db = await skinDB();
  if (!db) return null;
  return new Promise(res => {
    try {
      const tx = db.transaction("skin", mode);
      const req = fn(tx.objectStore("skin"));
      tx.oncomplete = () => res(req ? req.result : null);
      tx.onerror = tx.onabort = () => res(null);
    } catch (e) { res(null); }
  });
}

/* User picked / dropped an .osk: load it, then remember it. */
export async function useSkinFile(file) {
  const buf = await file.arrayBuffer();
  const fallback = file.name.replace(/\.osk$/i, "");
  await loadSkinBuffer(buf, fallback, "user");
  await dbDo("readwrite", st => st.put({ name: fallback, buf }, "current"));
  return SKIN;
}

/* Forget the user's skin; fall back to the project skin (server) or none. */
export async function removeSkin() {
  await dbDo("readwrite", st => st.delete("current"));
  resetSkin();
  await loadProjectSkin();
  return SKIN;
}

async function loadProjectSkin() {
  try {
    const m = await api.getSkin();
    if (!m || !m.present || !m.url) return false;
    const buf = await (await fetch(m.url)).arrayBuffer();
    await loadSkinBuffer(buf, m.name, "project");
    return true;
  } catch (e) { return false; }
}

/* Boot: the user's saved skin wins, else the project-folder .osk. */
export async function loadSkin() {
  try {
    const saved = await dbDo("readonly", st => st.get("current"));
    if (saved && saved.buf) {
      try { await loadSkinBuffer(saved.buf, saved.name, "user"); return SKIN; }
      catch (e) { await dbDo("readwrite", st => st.delete("current")); }
    }
  } catch (e) { /* no IndexedDB: fine */ }
  await loadProjectSkin();
  return SKIN;
}

/* ── drawing helpers ───────────────────────────────────────────────── */

/* "img" | "hidden" | "none" — hidden means the skin deliberately blanks it. */
export function skinState(name) {
  const e = SKIN.el[name];
  if (!e) return "none";
  return e.hidden ? "hidden" : "img";
}

/* Frame of an (optionally animated) element. `ageMs` picks the frame. */
export function frameOf(name, ageMs = 0, loop = false) {
  const e = SKIN.el[name];
  if (!e || e.hidden) return null;
  if (!e.frames || e.frames.length < 2) return e;
  const fps = SKIN.ini.animationFramerate > 0 ? SKIN.ini.animationFramerate : 60;
  let i = Math.floor(Math.max(0, ageMs) / (1000 / fps));
  i = loop ? i % e.frames.length : Math.min(e.frames.length - 1, i);
  return e.frames[i];
}

/* Image (tinted by multiply when `color` is given), cached per colour. */
export function tinted(fr, color) {
  if (!fr || !fr.img) return null;
  if (!color) return fr.img;
  const key = fr.img.src + "|" + color.join();
  let c = tintCache.get(key);
  if (c) return c;
  const w = fr.img.naturalWidth, h = fr.img.naturalHeight;
  c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(fr.img, 0, 0);
  g.globalCompositeOperation = "multiply";
  g.fillStyle = rgba(color, 1);
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "destination-in";
  g.drawImage(fr.img, 0, 0);
  if (tintCache.size > 300) tintCache.clear();
  tintCache.set(key, c);
  return c;
}

/* Draw a skin element centred at (x, y). `k` = screen px per 1× skin px. */
export function drawEl(ctx, name, x, y, k, opt = {}) {
  const fr = opt.frame || frameOf(name, opt.age || 0, opt.loop);
  if (!fr) return false;
  const img = tinted(fr, opt.color);
  const w = fr.w * k * (opt.scale || 1), h = fr.h * k * (opt.scale || 1);
  ctx.save();
  ctx.globalAlpha *= opt.alpha == null ? 1 : opt.alpha;
  ctx.translate(x, y);
  if (opt.rot) ctx.rotate(opt.rot);
  if (opt.flipX) ctx.scale(-1, 1);
  if (opt.topLeft) ctx.drawImage(img, 0, 0, w, h);
  else ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return true;
}

/* Combo number from the skin's digit sprites. Returns false if unavailable. */
export function drawDigits(ctx, n, x, y, k, alpha) {
  if (!SKIN.digits.length) return false;
  const ds = String(n).split("").map(c => SKIN.digits[+c]);
  const overlap = SKIN.ini.hitCircleOverlap * k;
  const total = ds.reduce((s, d) => s + d.w * k, 0) - overlap * (ds.length - 1);
  let cx = x - total / 2;
  ctx.save();
  ctx.globalAlpha *= alpha;
  for (const d of ds) {
    const w = d.w * k, h = d.h * k;
    ctx.drawImage(d.img, cx, y - h / 2, w, h);
    cx += w - overlap;
  }
  ctx.restore();
  return true;
}
