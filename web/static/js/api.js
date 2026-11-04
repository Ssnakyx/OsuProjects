/* Backend adapter — the single seam between the UI and "the backend".
   The rest of the frontend talks only to this module, never fetch() directly,
   so the same code runs two ways:

     • server mode  — `python main.py --web` → thin wrappers over /api/*
     • static mode  — no Python server (GitHub Pages, file://, any static host)
                       → Pyodide runs `webcore.py` + the `src/` core entirely in
                       the browser; nothing is uploaded.

   The mode is auto-detected once by probing /api/status; static mode boots
   Pyodide lazily on the first file drop so the landing screen stays instant. */

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const PYODIDE_URL = PYODIDE_BASE + "pyodide.js";

// The heavy files loadPyodide() fetches. We prefetch them ourselves first,
// reading the bodies as streams, so the boot can show real download progress;
// the service worker (sw.js) then answers loadPyodide's own requests from its
// cache — and every later visit starts without downloading anything.
// Sizes are rough decoded byte counts, only used to weight the progress bar.
const RUNTIME_FILES = [
  ["pyodide.asm.wasm", 10.5e6], ["python_stdlib.zip", 2.4e6],
  ["pyodide.asm.js", 1.2e6], ["pyodide-lock.json", 0.15e6],
];

// web/static/ root, resolved from this module's URL so it survives any
// deploy sub-path (GitHub Pages project sites, file://, etc.).
const STATIC_BASE = new URL("../", import.meta.url);

// Python sources fetched into Pyodide's FS, relative to the page. For a static
// deploy these must sit next to index.html (see web/build_static.py).
const PY_FILES = [
  "src/__init__.py", "src/mods.py", "src/curves.py",
  "src/beatmap.py", "src/replay.py", "src/scoring.py", "src/webjson.py",
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

// Engine (Pyodide) boot state, for the landing's progress line.
// { state: "idle" | "busy" | "ok" | "err", text, pct }
let _engine = { state: "idle", text: "starts when you load something", pct: 0 };
const _engineCbs = new Set();
function setEngine(state, text, pct) {
  _engine = { state, text, pct: pct == null ? _engine.pct : pct };
  for (const cb of _engineCbs) { try { cb(_engine); } catch (e) {} }
}

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

const MB = n => (n / 1e6).toFixed(1);

// Fetch the runtime's big files with byte progress (into the HTTP / SW cache).
async function prefetchRuntime(report) {
  const loaded = RUNTIME_FILES.map(() => 0);
  const total = RUNTIME_FILES.reduce((a, [, n]) => a + n, 0);
  const tick = () => {
    const frac = RUNTIME_FILES.reduce((a, [, n], i) => a + Math.min(1, loaded[i] / n) * n, 0) / total;
    const got = loaded.reduce((a, b) => a + b, 0);
    report(frac, got);
  };
  await Promise.all(RUNTIME_FILES.map(async ([name, size], i) => {
    try {
      const res = await fetch(PYODIDE_BASE + name);
      if (!res.ok || !res.body) { loaded[i] = size; tick(); return; }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded[i] += value.byteLength; tick();
      }
      loaded[i] = Math.max(loaded[i], size); tick();
    } catch (e) {
      // Prefetch is only an optimisation — loadPyodide fetches for real.
      loaded[i] = size; tick();
    }
  }));
}

async function bootPyodide(onStatus) {
  const t0 = performance.now();
  const step = (text, pct) => { setEngine("busy", text, pct); onStatus && onStatus(text); };
  try {
    const cached = await runtimeCached();
    step(cached ? "starting from cache…" : "downloading Python runtime…", 2);
    // pyodide.js, the core .py files and the runtime download all at once.
    const scriptP = window.loadPyodide ? Promise.resolve() : loadScript(PYODIDE_URL);
    const filesP = Promise.all(PY_FILES.map(async rel => {
      const r = await fetch(new URL(rel, STATIC_BASE), { cache: "no-cache" });
      if (!r.ok) throw new Error(`couldn't load ${rel} (HTTP ${r.status})`);
      return [rel, await r.text()];
    }));
    filesP.catch(() => {});                 // surfaced when awaited below
    await prefetchRuntime((frac, got) => {
      if (!cached) step(`downloading Python runtime… ${MB(got)} MB`, 2 + frac * 58);
    });
    await scriptP;

    step("starting Python…", 62);
    const py = await window.loadPyodide({ indexURL: PYODIDE_BASE });

    step("installing replay parser…", 74);
    // `lzma` is unvendored from Pyodide's stdlib and must be loaded explicitly —
    // osrparse uses it to decompress the replay's cursor data.
    await py.loadPackage(["micropip", "lzma"]);
    step("installing replay parser…", 84);
    // Install + verify osrparse through Python's own event loop. Awaiting the
    // coroutine via `await micropip.install(...)` from JS doesn't reliably
    // suspend, so webcore could import (and replay.py do `import osrparse`)
    // before the install finished — leaving osrparse unimportable. runPythonAsync
    // awaits properly and the trailing `import osrparse` surfaces real failures.
    await py.runPythonAsync(
      "import micropip\n" +
      "await micropip.install('osrparse')\n" +
      "import osrparse\n"
    );

    step("loading viewer core…", 94);
    for (const [rel, txt] of await filesP) {
      const dest = "/home/pyodide/" + rel;
      py.FS.mkdirTree(dest.slice(0, dest.lastIndexOf("/")));
      py.FS.writeFile(dest, txt);
    }
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
    _wc = py.pyimport("webcore");
    _py = py;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    setEngine("ok", `ready in ${secs} s` + (sw ? " · cached for next time" : ""), 100);
    return py;
  } catch (e) {
    _pyPromise = null;                      // allow a retry on the next drop
    // Python errors arrive as a whole traceback: keep its last line.
    const msg = String(e.message || e).trim().split("\n").pop();
    setEngine("err", "failed to start — " + msg + " · drop a file to retry", 0);
    throw e;
  }
}

// Is the runtime already in the service worker's cache? (→ a fast boot)
async function runtimeCached() {
  try {
    if (!self.caches) return false;
    return !!(await caches.match(PYODIDE_BASE + "pyodide.asm.wasm"));
  } catch (e) { return false; }
}

function ensurePy(onStatus) {
  if (_py) return Promise.resolve(_py);
  if (!_pyPromise) _pyPromise = bootPyodide(onStatus);
  else if (onStatus) {
    // Already booting (e.g. warmed up in the background): relay progress.
    const cb = e => { if (e.state === "busy") onStatus(e.text); };
    _engineCbs.add(cb);
    _pyPromise.finally(() => _engineCbs.delete(cb)).catch(() => {});
  }
  return _pyPromise;
}

async function serverGetBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errMsg(res));
  return res.arrayBuffer();
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

const BID_URLS = ["https://osu.direct/api/v2/b/", "https://catboy.best/api/v2/b/"];

async function mirrorLookup(bases, key, onStatus) {
  for (const base of bases) {
    const host = new URL(base).host;
    onStatus && onStatus(`Searching beatmap on ${host}…`);
    try {
      const sid = extractSetId(await (await fetch(base + key)).json());
      if (sid) return sid;
    } catch (e) { /* try next mirror */ }
  }
  return null;
}

// Downloaded sets are kept in Cache Storage (by set id), so rewatching a map —
// or a second replay on it — doesn't download it again.
const MAP_CACHE = "orv-maps-v1";
const MAP_CACHE_MAX = 12;
const mapKey = sid => `https://orv.cache/maps/${sid}.osz`;

async function cachedSet(sid) {
  try {
    if (!self.caches) return null;
    const r = await (await caches.open(MAP_CACHE)).match(mapKey(sid));
    return r ? await r.arrayBuffer() : null;
  } catch (e) { return null; }
}

async function rememberSet(sid, buf) {
  try {
    if (!self.caches) return;
    const c = await caches.open(MAP_CACHE);
    await c.delete(mapKey(sid));            // re-insert → most recent last
    await c.put(mapKey(sid), new Response(buf, { headers: { "Content-Type": "application/zip" } }));
    const keys = await c.keys();
    for (const k of keys.slice(0, Math.max(0, keys.length - MAP_CACHE_MAX))) await c.delete(k);
  } catch (e) { /* quota / private mode: fine, just not cached */ }
}

async function readWithProgress(res, onProgress) {
  const total = +res.headers.get("Content-Length") || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.byteLength;
    onProgress(got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out.buffer;
}

async function mirrorFetchSet(sid, onStatus) {
  const hit = await cachedSet(sid);
  if (hit) { onStatus && onStatus("Loaded from cache."); return hit; }
  for (const base of DOWNLOAD_URLS) {
    const host = new URL(base).host;
    onStatus && onStatus(`Downloading from ${host}…`);
    try {
      const res = await fetch(base + sid);
      if (!res.ok) continue;
      const buf = await readWithProgress(res, (got, total) => onStatus && onStatus(total
        ? `Downloading from ${host}… ${Math.round(100 * got / total)}%`
        : `Downloading from ${host}… ${Math.round(got / 1024)} KB`));
      if (buf.byteLength > 1024) { rememberSet(sid, buf); return buf; }
    } catch (e) { /* try next mirror */ }
  }
  throw new Error("Beatmap download failed — drop the .osz manually.");
}

async function mirrorDownload(md5, onStatus) {
  const sid = await mirrorLookup(LOOKUP_URLS, md5, onStatus);
  if (!sid) throw new Error("Beatmap not found on mirrors — drop the .osz manually.");
  return mirrorFetchSet(sid, onStatus);
}

/* ── public API ────────────────────────────────────────────────────── */

export const api = {
  // `slot` is chosen by the UI (0 or 1) so a stale server session can never
  // push the first replay into the second slot.
  async postReplay(buf, slot = "auto") {
    if (await mode() === "server") {
      const res = await fetch("/api/replay?slot=" + slot, { method: "POST", body: buf });
      if (!res.ok) throw new Error(await errMsg(res));
      return res.json();
    }
    await ensurePy();
    writeFile("/work/in.osr", buf);
    return wcJson("load_replay_path", "/work/in.osr", String(slot));
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
    const pyP = ensurePy();                 // boot while the map downloads
    const buf = await mirrorDownload(md5, onStatus);
    await pyP;
    writeFile("/work/auto.osz", buf);
    return wcJson("ingest_osz_path", "/work/auto.osz");
  },

  /* ── links ── */

  // What this backend can do with links: score links need the local server
  // with an osu! API app configured (see src/osuapi.py).
  async capabilities() {
    if (await mode() === "server") {
      try { const st = await (await fetch("/api/status")).json(); return { osuApi: !!st.osuApi }; }
      catch (e) { return { osuApi: false }; }
    }
    return { osuApi: false };
  },

  // Download + load a beatmap set from a link ({sid} and/or {bid}).
  async loadMapLink({ sid, bid }, onStatus) {
    if (await mode() === "server") {
      const poll = setInterval(async () => {
        try { const st = await (await fetch("/api/status")).json(); if (st.status) onStatus && onStatus(st.status); }
        catch (e) {}
      }, 400);
      try {
        const res = await fetch(`/api/link/map?sid=${sid || ""}&bid=${bid || ""}`);
        if (!res.ok) throw new Error(await errMsg(res));
        return res.json();
      } finally { clearInterval(poll); }
    }
    const pyP = ensurePy();                 // boot while the map downloads
    let set = sid;
    if (!set) set = await mirrorLookup(BID_URLS, bid, onStatus);
    if (!set) throw new Error(`Beatmap ${bid} not found on mirrors.`);
    const buf = await mirrorFetchSet(set, onStatus);
    await pyP;
    writeFile("/work/link.osz", buf);
    return wcJson("ingest_osz_path", "/work/link.osz", bid || 0);
  },

  // Bytes of an .osr shared by direct link. The server fetches it (no CORS);
  // the static build can only read hosts that allow cross-origin requests.
  async fetchOsr(url) {
    if (await mode() === "server") return serverGetBytes("/api/link/osr?url=" + encodeURIComponent(url));
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new Error("this site doesn't allow other pages to download its files — save the .osr and drop it here"); }
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    return res.arrayBuffer();
  },

  async scoreInfo(id, ruleset) {
    const res = await fetch(`/api/link/score?id=${id}&ruleset=${ruleset || ""}`);
    if (!res.ok) throw new Error(await errMsg(res));
    return res.json();
  },

  async scoreReplay(id, ruleset) {
    return serverGetBytes(`/api/link/score/osr?id=${id}&ruleset=${ruleset || ""}`);
  },

  /* ── engine (static mode) ── */

  // Start Pyodide in the background. `onlyIfCached`: skip unless the runtime
  // is already cached, so first-time visitors don't download it unasked.
  async warmup({ onlyIfCached = false } = {}) {
    if (await mode() !== "static" || _py || _pyPromise) return;
    if (onlyIfCached && !(await runtimeCached())) return;
    ensurePy().catch(() => {});
  },

  onEngine(cb) { _engineCbs.add(cb); cb(_engine); return () => _engineCbs.delete(cb); },

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
