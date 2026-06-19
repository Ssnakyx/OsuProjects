/* Recent replays, persisted in IndexedDB (the raw .osr bytes are kept so a
   recent entry can be replayed without re-downloading the map). */

import { S, $, escapeHtml, chip, toast } from "./core.js";
import { postReplay, afterFilesChanged, clearSession } from "./session.js";

const DB = { db: null, ready: null };

export function openDB() {
  if (DB.ready) return DB.ready;
  DB.ready = new Promise(res => {
    let r;
    try { r = indexedDB.open("orv", 1); } catch (e) { return res(null); }
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains("replays")) db.createObjectStore("replays", { keyPath: "id" }); };
    r.onsuccess = () => { DB.db = r.result; res(r.result); };
    r.onerror = () => res(null);
  });
  return DB.ready;
}

export async function saveRecentReplays() {
  await openDB();
  if (!DB.db || !S.map) return;
  for (const slot of [0, 1]) {
    const r = S.replays[slot], buf = S.replayBytes[slot];
    if (!r || !buf) continue;
    const entry = {
      id: r.md5 + "|" + r.player + "|" + r.mods,
      player: r.player, mods: r.mods, modsStr: r.modsStr, md5: r.md5,
      title: `${S.map.artist} — ${S.map.title} [${S.map.version}]`,
      bytes: buf, date: Date.now(),
    };
    try {
      const tx = DB.db.transaction("replays", "readwrite");
      tx.objectStore("replays").put(entry);
    } catch (e) {}
  }
  trimRecent();
}

export async function getRecent() {
  await openDB();
  if (!DB.db) return [];
  return new Promise(res => {
    try {
      const rq = DB.db.transaction("replays", "readonly").objectStore("replays").getAll();
      rq.onsuccess = () => res((rq.result || []).sort((a, b) => b.date - a.date));
      rq.onerror = () => res([]);
    } catch (e) { res([]); }
  });
}

export async function clearRecent() {
  await openDB();
  if (DB.db) try { DB.db.transaction("replays", "readwrite").objectStore("replays").clear(); } catch (e) {}
  renderRecent([]);
}

async function trimRecent() {
  const all = await getRecent();
  if (all.length <= 12) { renderRecent(all); return; }
  const tx = DB.db.transaction("replays", "readwrite");
  for (const e of all.slice(12)) tx.objectStore("replays").delete(e.id);
  renderRecent(all.slice(0, 12));
}

export function renderRecent(list) {
  const box = $("recent"), ul = $("recent-list");
  if (!list || !list.length) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  ul.innerHTML = "";
  for (const e of list) {
    const div = document.createElement("div");
    div.className = "recent-item";
    div.innerHTML = `<span class="ri-dot"></span>
      <div class="ri-main"><div class="ri-title">${escapeHtml(e.title)}</div>
      <div class="ri-sub">${escapeHtml(e.player)}</div></div>
      <span class="ri-mods">${e.modsStr ? "+" + e.modsStr : ""}</span>`;
    div.onclick = () => watchRecent(e);
    ul.appendChild(div);
  }
}

async function watchRecent(e) {
  await clearSession();
  chip("chip-r0", e.player + (e.modsStr ? "  +" + e.modsStr : ""), "busy");
  try {
    const buf = e.bytes.slice ? e.bytes.slice(0) : e.bytes;
    const data = await postReplay(buf);
    S.replays[data.slot] = data;
    S.replayBytes[data.slot] = e.bytes;
    S.events[data.slot] = null;
    chip("chip-r" + data.slot, e.player + (e.modsStr ? "  +" + e.modsStr : ""), "ok");
    await afterFilesChanged();
  } catch (err) {
    chip("chip-r0", "failed to reload", "err");
    toast("Couldn't reload replay: " + err.message, "error");
  }
}
