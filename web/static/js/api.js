/* Backend adapter — the single seam between the UI and "the backend".
   The rest of the frontend talks only to this module, never fetch() directly,
   so the same code runs two ways:

     • server mode  — `python main.py --web` → thin wrappers over /api/*
     • static mode  — no Python server (GitHub Pages, file://, any static host)
                       → Pyodide runs `webcore.py` + the `src/` core entirely in
                       the browser; nothing is uploaded.

   The mode is auto-detected once by probing /api/status; static mode boots
   Pyodide lazily on the first file drop so the landing screen stays instant. */

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

// web/static/ root, resolved from this module's URL so it survives any
// deploy sub-path (GitHub Pages project sites, file://, etc.).
const STATIC_BASE = new URL("../", import.meta.url);

// Python sources fetched into Pyodide's FS, relative to the page. For a static
// deploy these must sit next to index.html (see web/build_static.py).
const PY_FILES = [
  "src/__init__.py", "src/mods.py", "src/curves.py",
  "src/beatmap.py", "src/replay.py", "src/scoring.py",
  "webcore.py",
];

const MIME = {
  mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
};

let _modePromise = null;          // Promise<"server" | "static">
let _py = null;                   // Pyodide instance (static mode)
let _pyPromise = null;            // Promise<pyodide> while booting
let _wc = null;                   // the imported `webcore` module proxy
const _blobUrls = [];             // object URLs to revoke on clear()

/* ── helpers ───────────────────────────────────────────────────────── */

async function errMsg(res) {
  let m = res.statusText;
  try { m = (await res.json()).error || m; } catch (e) {}
  return m;
}

function ext(name) { return name.toLowerCase().slice(name.lastIndexOf(".") + 1); }

async function detectMode() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    const j = await res.json();
    if (res.ok && typeof j === "object" && "busy" in j) return "server";
  } catch (e) { /* no server → static */ }
  return "static";
}

export function mode() {
  if (!_modePromise) _modePromise = detectMode();
  return _modePromise;
}

/* ── Pyodide boot (static mode) ────────────────────────────────────── */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(s);
  });
}

async function bootPyodide(onStatus) {
  onStatus && onStatus("Loading Python runtime…");
  if (!window.loadPyodide) await loadScript(PYODIDE_URL);
  const py = await window.loadPyodide();

  onStatus && onStatus("Installing replay parser…");
  await py.loadPackage("micropip");
  const micropip = py.pyimport("micropip");
  await micropip.install("osrparse");

  onStatus && onStatus("Loading viewer core…");
  for (const rel of PY_FILES) {
    const txt = await (await fetch(new URL(rel, STATIC_BASE), { cache: "no-store" })).text();
    const dest = "/home/pyodide/" + rel;
    const dir = dest.slice(0, dest.lastIndexOf("/"));
    py.FS.mkdirTree(dir);
    py.FS.writeFile(dest, txt);
  }
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
  _wc = py.pyimport("webcore");
  _py = py;
  return py;
}

function ensurePy(onStatus) {
  if (_py) return Promise.resolve(_py);
  if (!_pyPromise) _pyPromise = bootPyodide(onStatus);
  return _pyPromise;
}

// Run a webcore function that returns a JSON string and parse it.
function wcJson(fn, ...args) {
  const out = _wc[fn](...args);
  return JSON.parse(out);
}

function writeFile(path, buf) {
  _py.FS.mkdirTree("/work");
  _py.FS.writeFile(path, new Uint8Array(buf));
}

function blobFromFsPath(p) {
  if (!p) return null;
  const data = _py.FS.readFile(p);                 // Uint8Array
  const type = MIME[ext(p)] || "application/octet-stream";
  const url = URL.createObjectURL(new Blob([data], { type }));
  _blobUrls.push(url);
  return url;
}

/* ── client-side mirror download (static mode) ─────────────────────── */
// Ports src/mirror.py. Subject to CORS — callers fall back to manual on error.

const LOOKUP_URLS = ["https://osu.direct/api/v2/md5/", "https://catboy.best/api/v2/md5/"];
const DOWNLOAD_URLS = ["https://osu.direct/api/d/", "https://catboy.best/d/", "https://api.nerinyan.moe/d/"];

function extractSetId(data) {
  if (Array.isArray(data)) {
    for (const v of data) { const f = extractSetId(v); if (f) return f; }
  } else if (data && typeof data === "object") {
    for (const k of ["beatmapset_id", "set_id", "setId"]) {
      const v = data[k]; if (Number.isInteger(v) && v > 0) return v;
    }
    const st = data.set || data.beatmapset;
    if (st && typeof st === "object" && Number.isInteger(st.id) && st.id > 0) return st.id;
    for (const v of Object.values(data)) { const f = extractSetId(v); if (f) return f; }
  }
  return null;
}

async function mirrorDownload(md5, onStatus) {
  let sid = null;
  for (const base of LOOKUP_URLS) {
    const host = new URL(base).host;
    onStatus && onStatus(`Searching beatmap on ${host}…`);
    try {
      const data = await (await fetch(base + md5)).json();
      sid = extractSetId(data);
      if (sid) break;
    } catch (e) { /* try next mirror */ }
  }
  if (!sid) throw new Error("Beatmap not found on mirrors — drop the .osz manually.");

  for (const base of DOWNLOAD_URLS) {
    const host = new URL(base).host;
    onStatus && onStatus(`Downloading from ${host}…`);
    try {
      const res = await fetch(base + sid);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 1024) return buf;
    } catch (e) { /* try next mirror */ }
  }
  throw new Error("Beatmap download failed — drop the .osz manually.");
}

/* ── public API ────────────────────────────────────────────────────── */

export const api = {
  async postReplay(buf) {
    if (await mode() === "server") {
      const res = await fetch("/api/replay?slot=auto", { method: "POST", body: buf });
      if (!res.ok) throw new Error(await errMsg(res));
      return res.json();
    }
    await ensurePy();
    writeFile("/work/in.osr", buf);
    return wcJson("load_replay_path", "/work/in.osr", "auto");
  },

  async uploadMap(name, buf) {
    if (await mode() === "server") {
      const res = await fetch("/api/mapfile", {
        method: "POST", headers: { "X-Filename": name }, body: buf,
      });
      if (!res.ok) throw new Error(await errMsg(res));
      return res.json();
    }
    await ensurePy();
    const e = ext(name);
    if (e === "osu") { writeFile("/work/in.osu", buf); return wcJson("ingest_osu_path", "/work/in.osu"); }
    if (e === "osz") { writeFile("/work/in.osz", buf); return wcJson("ingest_osz_path", "/work/in.osz"); }
    throw new Error("unsupported file type: ." + e);
  },

  async getMap() {
    if (await mode() === "server") {
      const res = await fetch("/api/map");
      if (!res.ok) throw new Error(await errMsg(res));
      return res.json();
    }
    const m = wcJson("map_json");
    m.audio = blobFromFsPath(_wc.media_path("audio"));
    m.bg = blobFromFsPath(_wc.media_path("bg"));
    return m;
  },

  async getEvents(slot) {
    if (await mode() === "server") {
      const res = await fetch("/api/events?slot=" + slot);
      return res.ok ? res.json() : null;
    }
    try { return wcJson("events_json", slot); } catch (e) { return null; }
  },

  async autoDownload(md5, onStatus) {
    if (await mode() === "server") {
      const poll = setInterval(async () => {
        try { const st = await (await fetch("/api/status")).json(); if (st.status) onStatus && onStatus(st.status); }
        catch (e) {}
      }, 400);
      try {
        const res = await fetch("/api/auto?md5=" + encodeURIComponent(md5));
        if (!res.ok) throw new Error(await errMsg(res));
        return res.json();
      } finally { clearInterval(poll); }
    }
    await ensurePy(onStatus);
    const buf = await mirrorDownload(md5, onStatus);
    writeFile("/work/auto.osz", buf);
    return wcJson("ingest_osz_path", "/work/auto.osz");
  },

  async clear() {
    for (const u of _blobUrls.splice(0)) URL.revokeObjectURL(u);
    if (await mode() === "server") {
      try { await fetch("/api/clear", { method: "POST" }); } catch (e) {}
      return;
    }
    if (_wc) _wc.clear();
  },

  // Hit-sound sample as an ArrayBuffer, or null if unavailable.
  async getHitsound() {
    const url = (await mode() === "server")
      ? "/api/hitsound" : new URL("osu-hit-sound.mp3", STATIC_BASE);
    try { const r = await fetch(url); return r.ok ? r.arrayBuffer() : null; }
    catch (e) { return null; }
  },

  // Optional .osk skin metadata. Static mode has no skin (vector fallback).
  async getSkin() {
    if (await mode() === "server") {
      try { return await (await fetch("/api/skin")).json(); } catch (e) { return { present: false }; }
    }
    return { present: false };
  },
};
