/* Service worker for the static (Pyodide) build — makes repeat visits fast.

   • Pyodide runtime + packages (cdn.jsdelivr.net/pyodide/…) and PyPI wheels
     (files.pythonhosted.org): versioned, immutable URLs → cache-first. After
     the first visit the ~15 MB Python runtime never downloads again.
   • PyPI metadata (pypi.org/pypi/…/json, what micropip resolves against):
     stale-while-revalidate, so the install doesn't wait on the network.
   • The app itself (same origin): network-first, falling back to the cache
     when offline — a deploy shows up on the next load, never half-applied.

   build_static.py copies this file to the site root so its scope covers
   index.html. Bump VERSION to drop every cache it owns. */

const VERSION = "v1";
const RUNTIME = "orv-runtime-" + VERSION;
const APP = "orv-app-" + VERSION;
const OWN = [RUNTIME, APP];

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k.startsWith("orv-") && !k.startsWith("orv-maps") && !OWN.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isImmutable = u =>
  (u.hostname === "cdn.jsdelivr.net" && u.pathname.startsWith("/pyodide/")) ||
  u.hostname === "files.pythonhosted.org";
const isPypiMeta = u => u.hostname === "pypi.org" && u.pathname.startsWith("/pypi/");

const cacheable = r => r && r.ok && r.type !== "opaque" && r.status === 200;

async function cacheFirst(req) {
  const c = await caches.open(RUNTIME);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) c.put(req, res.clone()).catch(() => {});
  return res;
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(RUNTIME);
  const hit = await c.match(req, { ignoreVary: true });
  const net = fetch(req).then(res => {
    if (cacheable(res)) c.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

async function networkFirst(req) {
  const c = await caches.open(APP);
  try {
    const res = await fetch(req);
    if (cacheable(res)) c.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await c.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const u = new URL(req.url);
  if (isImmutable(u)) e.respondWith(cacheFirst(req));
  else if (isPypiMeta(u)) e.respondWith(staleWhileRevalidate(req));
  else if (u.origin === self.location.origin) e.respondWith(networkFirst(req));
  // everything else (beatmap mirrors, fonts…) goes straight to the network
});
