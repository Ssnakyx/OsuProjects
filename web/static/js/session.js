/* File intake (replays + beatmaps), auto-download orchestration, and
   entering / leaving the player. */

import {
  S, OPT, $, toast, chip, landing, player,
  clockRate, adjDifficulty, circleRadius, preemptMs,
} from "./core.js";
import { prepareSliders } from "./render.js";
import { prepStats } from "./stats.js";
import { setPlaying, setSpeed, initSfx, tick } from "./playback.js";
import { applySettings, startParticles, stopParticles } from "./settings.js";
import { saveRecentReplays } from "./recent.js";

/* ── file intake ───────────────────────────────────────────────────── */

export async function handleFiles(files) {
  for (const f of files) {
    const ext = f.name.toLowerCase().slice(f.name.lastIndexOf("."));
    if (ext === ".osr") await uploadReplay(f);
    else if (ext === ".osu" || ext === ".osz") await uploadMap(f);
    else toast(`Unsupported file: ${f.name}`, "error");
  }
}

export async function postReplay(buf) {
  const res = await fetch("/api/replay?slot=auto", { method: "POST", body: buf });
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error; } catch (e) {} throw new Error(m); }
  return res.json();
}

// md5 of the beatmap the current session is built around (driven by replays).
function currentBeatmapMd5() {
  if (S.replays[0]) return S.replays[0].md5;
  if (S.replays[1]) return S.replays[1].md5;
  return null;
}

async function uploadReplay(file) {
  const buf = await file.arrayBuffer();
  let data;
  try {
    data = await postReplay(buf);
  } catch (e) {
    toast("Couldn't read replay: " + e.message, "error");
    return;
  }
  // Dropping a replay for a *different* beatmap? Start fresh so the correct
  // map downloads and the right song plays (not the previous one).
  const loadedMd5 = currentBeatmapMd5();
  if (loadedMd5 && data.md5 !== loadedMd5) {
    await clearSession();
    try {
      data = await postReplay(buf);
    } catch (e) {
      toast("Couldn't read replay: " + e.message, "error");
      return;
    }
  }
  S.replays[data.slot] = data;
  S.replayBytes[data.slot] = buf;
  S.events[data.slot] = null;
  const label = data.player + (data.modsStr ? `  +${data.modsStr}` : "");
  chip("chip-r" + data.slot, label, "ok");
  if (S.replays[0] && S.replays[1] && S.replays[0].md5 !== S.replays[1].md5)
    toast("Heads up: the two replays are from different beatmaps.", "warn");
  await afterFilesChanged();
}

async function uploadMap(file) {
  chip("chip-map", "uploading " + file.name + "…", "busy");
  try {
    const res = await fetch("/api/mapfile", {
      method: "POST", headers: { "X-Filename": file.name }, body: await file.arrayBuffer(),
    });
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error; } catch (e) {} throw new Error(m); }
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
  if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error; } catch (e) {} throw new Error(m); }
  S.map = await res.json();
  S.events = [null, null];
  chip("chip-map", `${S.map.artist} — ${S.map.title} [${S.map.version}]`, "ok");
  if (!S.map.md5Match)
    toast("Exact difficulty not found (MD5 mismatch) — using the closest one.", "warn");
}

async function autoFetch(md5) {
  if (S.mapFetching) return;
  S.mapFetching = true;
  chip("chip-map", "searching mirrors…", "busy");
  const poll = setInterval(async () => {
    try {
      const st = await (await fetch("/api/status")).json();
      if (st.status) {
        const m = st.status.match(/(\d+)\s*%/);
        chip("chip-map", st.status, "busy", m ? +m[1] : null);
      }
    } catch (e) { /* ignore */ }
  }, 400);
  try {
    const res = await fetch("/api/auto?md5=" + encodeURIComponent(md5));
    if (!res.ok) { let m = res.statusText; try { m = (await res.json()).error; } catch (e) {} throw new Error(m); }
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

export async function afterFilesChanged() {
  if (!S.map && S.replays[0] && !S.mapFetching) { autoFetch(S.replays[0].md5); return; }
  if (S.map) {
    for (const slot of [0, 1]) {
      if (S.replays[slot] && !S.events[slot]) {
        try {
          const res = await fetch("/api/events?slot=" + slot);
          if (res.ok) { S.events[slot] = await res.json(); prepStats(slot); }
        } catch (e) { /* ignore */ }
      }
    }
  }
  maybeStart();
}

export function maybeStart() {
  if (!S.map || !S.replays.some(Boolean)) return;
  for (const slot of [0, 1]) if (S.replays[slot] && !S.events[slot]) return;
  if (S.started) { enterPlayer(); return; }
  $("btn-watch").classList.remove("disabled");
}

/* ── enter / leave the player ──────────────────────────────────────── */

export function enterPlayer() {
  const mods0 = S.replays[0] ? S.replays[0].mods : 0;
  const [cs, ar] = adjDifficulty(S.map.cs, S.map.ar, S.map.od, mods0);
  S.radius = circleRadius(cs);
  S.preempt = preemptMs(ar);
  prepareSliders();

  const objs = S.map.objects;
  S.origin = objs.length ? objs[0].t - S.preempt - 1500 : -2000;
  S.endT = objs.length
    ? Math.max(...objs.map(o => o.k === "s" ? o.t + o.dur : o.k === "p" ? o.end : o.t)) + 2000 : 1;

  for (const slot of [0, 1]) {
    const r = S.replays[slot];
    $("panel-" + slot).classList.toggle("hidden", !r);
    if (r) {
      $(`p${slot}-name`).textContent = r.player;
      $(`p${slot}-av`).textContent = (r.player || "?").trim().charAt(0).toUpperCase() || "?";
      // mod string is concatenated 2-letter codes (e.g. "HDDT") — split into chips
      const modsEl = $(`p${slot}-mods`);
      modsEl.innerHTML = "";
      const ms = r.modsStr || "";
      for (let k = 0; k < ms.length; k += 2) {
        const chip = document.createElement("span");
        chip.className = "mod";
        chip.textContent = ms.slice(k, k + 2);
        modsEl.appendChild(chip);
      }
    }
  }
  const title = $("map-title");
  title.textContent = `${S.map.artist} — ${S.map.title} [${S.map.version}]  ·  mapped by ${S.map.creator}`;
  if (S.map.setId) {
    title.style.cursor = "pointer";
    title.title = "Open beatmap page on osu!";
    title.onclick = () => window.open(`https://osu.ppy.sh/beatmapsets/${S.map.setId}`, "_blank");
  } else { title.onclick = null; title.style.cursor = "default"; }

  $("btn-mode").classList.toggle("hidden", !(S.replays[0] && S.replays[1]));

  $("bg-layer").style.backgroundImage = S.map.bg ? `url(${S.map.bg})` : "none";
  if (S.audio) { S.audio.pause(); S.audio = null; }
  if (S.map.audio) {
    S.audio = new Audio(S.map.audio);
    S.audio.preload = "auto";
    S.audio.volume = OPT.musicVol / 100;
    try { S.audio.preservesPitch = true; } catch (e) {}
  } else {
    toast("No audio file in this beatmap — playing silently.", "warn");
  }
  initSfx();

  const rate = clockRate(mods0);
  setSpeed(rate);
  if (rate !== 1) toast(`${S.replays[0].modsStr} replay — speed set to ${rate}×`, "info");

  S.t = S.origin; S.hitIdx = 0; S.ended = false;
  document.body.classList.add("playing");
  stopParticles();
  landing.classList.add("hidden");
  player.classList.remove("hidden");
  applySettings();
  saveRecentReplays();
  setPlaying(true);

  if (!S.started) { S.started = true; S.lastNow = performance.now(); requestAnimationFrame(tick); }
}

export function goLanding() {
  setPlaying(false);
  document.body.classList.remove("playing");
  player.classList.add("hidden");
  landing.classList.remove("hidden");
  if (OPT.bgParticles) startParticles();
}

export async function clearSession() {
  try { await fetch("/api/clear", { method: "POST" }); } catch (e) {}
  // Stop the previous map's song right away — otherwise it keeps playing
  // while the next map downloads, until enterPlayer() replaces it.
  if (S.audio) { S.audio.pause(); S.audio = null; }
  S.playing = false;
  S.replays = [null, null]; S.replayBytes = [null, null]; S.events = [null, null]; S.map = null;
  $("btn-watch").classList.add("disabled");
  chip("chip-r0", "waiting for file…");
  chip("chip-r1", "optional");
  chip("chip-map", "auto-download after replay");
}
