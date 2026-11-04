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
    cursorRotate: true, cursorExpand: true, cursorCentre: true, cursorTrailRotate: true,
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
      else if (k === "cursortrailrotate") ini.cursorTrailRotate = bool;
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
    present: false, id: "builtin", name: "", author: "", source: "", el: {}, digits: [],
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

/* ── skin library (IndexedDB) ──────────────────────────────────────
   Every .osk the user loads is kept in the browser so they can switch
   between skins in one click. Stores (db "orv-skin", v2):
     meta  : id → { id, name, author, size, added, thumb }   (small, listed)
     data  : id → ArrayBuffer of the .osk                    (big, read on use)
     skin  : "current" → { id }  ("builtin" = no skin, "project" = folder .osk)
   v1 kept one skin as skin["current"] = { name, buf }; it is migrated into
   the library on first boot. */

const DBNAME = "orv-skin", DBVER = 2;
let dbPromise = null;
function skinDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(res => {
    let r;
    try { r = indexedDB.open(DBNAME, DBVER); } catch (e) { return res(null); }
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const st of ["skin", "meta", "data"]) if (!db.objectStoreNames.contains(st)) db.createObjectStore(st);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
  });
  return dbPromise;
}

/* Run `fn(tx)` in a transaction. Resolves with what `fn` returned (an
   IDBRequest's result is unwrapped); rejects if the transaction fails
   (quota exceeded…). Without IndexedDB it resolves to null. */
async function dbTx(stores, mode, fn) {
  const db = await skinDB();
  if (!db) return null;
  return new Promise((res, rej) => {
    let out;
    try {
      const tx = db.transaction(stores, mode);
      out = fn(tx);
      tx.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      tx.onerror = tx.onabort = () => rej(tx.error || new Error("storage error"));
    } catch (e) { rej(e); }
  });
}
const dbGet = (store, key) => dbTx(store, "readonly", tx => tx.objectStore(store).get(key)).catch(() => null);
const setCurrent = id => dbTx("skin", "readwrite", tx => { tx.objectStore("skin").put({ id }, "current"); }).catch(() => {});

/* Parsed skins kept in memory so switching back is instant (a few at most:
   decoded sprites are heavy). */
const parsed = new Map();
const MAX_PARSED = 4;
function remember(id) {
  parsed.delete(id);
  parsed.set(id, { ...SKIN });
  while (parsed.size > MAX_PARSED) parsed.delete(parsed.keys().next().value);
}
function restore(id) {
  const snap = parsed.get(id);
  if (!snap) return false;
  resetSkin();
  Object.assign(SKIN, snap);
  remember(id);
  return true;
}

/* A small preview of the active skin: a hit circle with its combo colour,
   number and the cursor. Stored as a data URL alongside the metadata. */
function makeThumb() {
  try {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 96;
    const g = c.getContext("2d");
    const col = SKIN.colors[0] || COMBO_COLORS[0];
    const k = 0.58, x = 54, y = 48;
    if (SKIN.el.hitcircle && !SKIN.el.hitcircle.hidden) {
      drawEl(g, "hitcircle", x, y, k, { color: col });
      drawEl(g, "hitcircleoverlay", x, y, k);
    } else {
      g.beginPath(); g.arc(x, y, 34, 0, Math.PI * 2);
      g.fillStyle = rgba(col, 1); g.fill();
      g.lineWidth = 5; g.strokeStyle = "#fff"; g.stroke();
    }
    if (!drawDigits(g, 1, x, y, k * 0.8, 1)) {
      g.fillStyle = "#fff"; g.font = "800 30px system-ui, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("1", x, y + 1);
    }
    if (SKIN.el.cursor && !SKIN.el.cursor.hidden) drawEl(g, "cursor", 100, 66, 0.5);
    if (SKIN.el.cursormiddle && !SKIN.el.cursormiddle.hidden) drawEl(g, "cursormiddle", 100, 66, 0.5);
    return c.toDataURL("image/png");
  } catch (e) { return ""; }
}

/* Library entries, oldest first (no .osk bytes). */
export async function listSkins() {
  const all = await dbTx("meta", "readonly", tx => tx.objectStore("meta").getAll()).catch(() => null);
  return (all || []).sort((a, b) => a.added - b.added);
}

const newId = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* Save the skin currently in SKIN (parsed from `buf`) into the library.
   The same skin added twice (same name and size) replaces the old entry.
   Returns false when the browser refused to store it. */
async function saveToLibrary(buf, fileName) {
  const existing = (await listSkins()).find(m => m.name === SKIN.name && m.size === buf.byteLength);
  const id = existing ? existing.id : newId();
  const meta = {
    id, name: SKIN.name, author: SKIN.author || "", size: buf.byteLength,
    file: fileName || "", added: existing ? existing.added : Date.now(), thumb: makeThumb(),
  };
  SKIN.id = id;
  remember(id);
  try {
    await dbTx(["meta", "data", "skin"], "readwrite", tx => {
      tx.objectStore("data").put(buf, id);
      tx.objectStore("meta").put(meta, id);
      tx.objectStore("skin").put({ id }, "current");
    });
    return true;
  } catch (e) { return false; }
}

/* User picked / dropped an .osk: load it, add it to the library and use it.
   Resolves to { skin, saved }. */
export async function useSkinFile(file) {
  const buf = await file.arrayBuffer();
  const fallback = file.name.replace(/\.(osk|zip)$/i, "");
  await loadSkinBuffer(buf, fallback, "user");
  const saved = await saveToLibrary(buf, file.name);
  return { skin: SKIN, saved };
}

function useBuiltin() {
  resetSkin();
  SKIN.id = "builtin";
}

async function loadProjectSkin() {
  try {
    const m = await api.getSkin();
    if (!m || !m.present || !m.url) return false;
    if (restore("project")) return true;
    const buf = await (await fetch(m.url)).arrayBuffer();
    await loadSkinBuffer(buf, m.name, "project");
    SKIN.id = "project";
    remember("project");
    return true;
  } catch (e) { return false; }
}

/* Is there an .osk in the project folder (server mode)? Cached. */
let projectInfo;
export async function projectSkinInfo() {
  if (projectInfo === undefined) {
    try { const m = await api.getSkin(); projectInfo = m && m.present && m.url ? { name: m.name } : null; }
    catch (e) { projectInfo = null; }
  }
  return projectInfo;
}

/* Switch to a library skin, "builtin" or "project". Throws if the saved
   .osk can no longer be read. */
export async function switchSkin(id) {
  if (id === "builtin") useBuiltin();
  else if (id === "project") { if (!(await loadProjectSkin())) throw new Error("no skin in the project folder"); }
  else if (!restore(id)) {
    const buf = await dbGet("data", id);
    if (!buf) throw new Error("this skin is no longer saved");
    const meta = await dbGet("meta", id);
    await loadSkinBuffer(buf, meta ? meta.name : "skin", "user");
    SKIN.id = id;
    remember(id);
  }
  await setCurrent(id);
  return SKIN;
}

/* Default when nothing is chosen: the project-folder skin, else built-in. */
async function useDefault() {
  if (!(await loadProjectSkin())) useBuiltin();
}

/* Delete a library skin. If it was in use, fall back to the default. */
export async function deleteSkin(id) {
  parsed.delete(id);
  await dbTx(["meta", "data"], "readwrite", tx => {
    tx.objectStore("meta").delete(id);
    tx.objectStore("data").delete(id);
  }).catch(() => {});
  if (SKIN.id === id) {
    await useDefault();
    await dbTx("skin", "readwrite", tx => { tx.objectStore("skin").delete("current"); }).catch(() => {});
  }
  return SKIN;
}

/* Stop using the user's skin (kept in the library): project skin or built-in. */
export async function removeSkin() {
  await useDefault();
  await setCurrent(SKIN.id);
  return SKIN;
}

/* Boot: the skin chosen last time, else the project-folder .osk. */
export async function loadSkin() {
  let cur = null;
  try { cur = await dbGet("skin", "current"); } catch (e) { /* no IndexedDB: fine */ }
  // v1 → v2: the single saved skin becomes the first library entry.
  if (cur && cur.buf) {
    try {
      await loadSkinBuffer(cur.buf, cur.name, "user");
      await saveToLibrary(cur.buf, cur.name + ".osk");   // on failure the v1 record stays
      return SKIN;
    } catch (e) { cur = null; }
  }
  if (cur && cur.id) {
    try { return await switchSkin(cur.id); } catch (e) { /* deleted / corrupt */ }
  }
  await useDefault();
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
