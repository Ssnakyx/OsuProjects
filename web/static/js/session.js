/* File intake (replays + beatmaps), auto-download orchestration, and
   entering / leaving the player. */

import {
  S, OPT, $, toast, chip, landing, player,
  clockRate, adjDifficulty, circleRadius, preemptMs, escapeHtml,
} from "./core.js";
import { MOD } from "./config.js";
import { useSkinFile } from "./skin.js";
import { api } from "./api.js";
import { prepareMap } from "./render.js";
import { prepStats } from "./stats.js";
import { setPlaying, setSpeed, initSfx, tick } from "./playback.js";
import { applySettings, startParticles, stopParticles } from "./settings.js";
import { saveRecentReplays } from "./recent.js";
import { prepareTimeline } from "./timeline.js";
import { parseLink } from "./links.js";

/* ── file intake ───────────────────────────────────────────────────── */

export async function handleFiles(files) {
  // Skins first (so a replay dropped together with a skin uses it), then
  // beatmaps, then replays — whatever order the browser lists them in.
  const rank = f => { const e = extOf(f.name); return e === ".osk" ? 0 : (e === ".osz" || e === ".osu") ? 1 : 2; };
  for (const f of [...files].sort((a, b) => rank(a) - rank(b))) {
    const ext = extOf(f.name);
    if (ext === ".osr") await uploadReplay(f);
    else if (ext === ".osu" || ext === ".osz") await uploadMap(f);
    else if (ext === ".osk") await loadSkinFile(f);
    else toast(`Unsupported file: ${f.name}`, "error");
  }
}

const extOf = name => name.toLowerCase().slice(name.lastIndexOf("."));

export async function loadSkinFile(file) {
  chip("chip-skin", "loading " + file.name + "…", "busy");
  try {
    const { skin, saved } = await useSkinFile(file);
    if (saved) toast(`Skin loaded: ${skin.name} — added to your skin library`, "ok");
    else toast(`Skin loaded: ${skin.name}, but your browser had no room to keep it for next time.`, "warn", 6000);
  } catch (e) {
    toast("Couldn't read this skin: " + e.message, "error");
  }
  document.dispatchEvent(new CustomEvent("skinchange"));
}

// First free slot; with both taken, a new replay replaces the second one.
const freeSlot = () => (!S.replays[0] ? 0 : 1);

export async function postReplay(buf) {
  return api.postReplay(buf, freeSlot());
}

// md5 of the beatmap the current session is built around (driven by replays).
function currentBeatmapMd5() {
  if (S.replays[0]) return S.replays[0].md5;
  if (S.replays[1]) return S.replays[1].md5;
  return null;
}

async function uploadReplay(file) {
  await ingestReplay(await file.arrayBuffer());
}

async function ingestReplay(buf) {
  const slotChip = "chip-r" + freeSlot();
  chip(slotChip, "reading replay…", "busy");
  let data;
  try {
    data = await postReplay(buf);
  } catch (e) {
    chip(slotChip, "couldn't read it — try another .osr", "err");
    toast("Couldn't read replay: " + e.message, "error");
    return false;
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
      return false;
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
  return true;
}

async function uploadMap(file) {
  chip("chip-map", "reading " + file.name + "…", "busy");
  try {
    await api.uploadMap(file.name, await file.arrayBuffer());
    await fetchMap();
  } catch (e) {
    chip("chip-map", "failed — " + e.message, "err");
    toast("Beatmap error: " + e.message, "error");
    return;
  }
  await afterFilesChanged();
}

async function fetchMap() {
  S.map = await api.getMap();
  if (!S.map.objects || !S.map.objects.length) toast("This beatmap has no hit objects.", "warn");
  S.events = [null, null];
  chip("chip-map", `${S.map.artist} — ${S.map.title} [${S.map.version}]`, "ok");
  if (!S.map.md5Match)
    toast("Exact difficulty not found (MD5 mismatch) — using the closest one.", "warn");
}

// Run a beatmap download (auto by md5, or from a link) with chip progress.
async function downloadMap(fetchFn, failLabel) {
  if (S.mapFetching) return false;
  S.mapFetching = true;
  chip("chip-map", "searching mirrors…", "busy");
  const onStatus = (msg) => {
    const m = msg.match(/(\d+)\s*%/);
    chip("chip-map", msg, "busy", m ? +m[1] : null);
  };
  try {
    await fetchFn(onStatus);
    await fetchMap();
  } catch (e) {
    chip("chip-map", failLabel, "err");
    toast(e.message, "error", 6000);
    return false;
  } finally {
    S.mapFetching = false;
  }
  await afterFilesChanged();
  return true;
}

function autoFetch(md5) {
  return downloadMap(st => api.autoDownload(md5, st), "not found — paste the map link or drop the .osz");
}

/* ── loading from a pasted link ────────────────────────────────────── */

const hint = (html) => {
  const el = $("link-hint");
  el.innerHTML = html || "";
  el.classList.toggle("hidden", !html);
};

// Returns true when something was loaded (so the caller can clear the box).
export async function loadLink(raw) {
  const link = parseLink(raw);
  if (!link) {
    toast("That isn't an osu! beatmap or score link (or a beatmap ID).", "error");
    return false;
  }
  hint("");
  const box = $("link-form");
  box.classList.add("busy");
  try {
    if (link.kind === "map") return await loadMapLink(link);
    if (link.kind === "osr") return await loadOsrLink(link.url);
    return await loadScoreLink(link);
  } finally {
    box.classList.remove("busy");
  }
}

async function loadMapLink(link, { quiet = false } = {}) {
  // A replay already loaded is kept: pasting the map link is the fix when the
  // automatic download didn't find its beatmap.
  const ok = await downloadMap(st => api.loadMapLink(link, st), "download failed — try again or drop the .osz");
  if (ok && !quiet && !S.replays.some(Boolean))
    toast("Beatmap ready — now drop a replay (.osr) played on it.", "ok", 5000);
  return ok;
}

async function loadOsrLink(url) {
  chip("chip-r" + freeSlot(), "downloading replay…", "busy");
  let buf;
  try { buf = await api.fetchOsr(url); }
  catch (e) {
    chip("chip-r" + freeSlot(), "download failed", "err");
    toast("Couldn't download the replay: " + e.message, "error", 7000);
    return false;
  }
  return ingestReplay(buf);
}

async function loadScoreLink({ id, ruleset }) {
  if (ruleset && ruleset !== "osu") {
    toast("Only osu!standard scores can be watched here.", "error");
    return false;
  }
  const page = `https://osu.ppy.sh/scores/${ruleset ? ruleset + "/" : ""}${id}`;
  const pageLink = `<a href="${page}" target="_blank" rel="noopener">open the score page ↗</a>`;
  const { osuApi } = await api.capabilities();
  if (!osuApi) {
    hint(`<b>osu! only lets signed-in players download replays</b>, so this page can't fetch it for you. ` +
         `${pageLink}, click <b>Download replay</b>, then drop the .osr here — the beatmap downloads by itself.`);
    return false;
  }
  const slotChip = "chip-r" + freeSlot();
  chip(slotChip, "looking up score…", "busy");
  let info;
  try { info = await api.scoreInfo(id, ruleset); }
  catch (e) {
    chip(slotChip, "score not found", "err");
    toast(e.message, "error", 6000);
    return false;
  }
  chip(slotChip, `downloading ${info.player || "the"} replay…`, "busy");
  try {
    return await ingestReplay(await api.scoreReplay(id, ruleset));
  } catch (e) {
    // Expected with an app-only token: still fetch the map, ask for the file.
    chip(slotChip, "drop the .osr from the score page", "err");
    hint(`<b>osu! didn't hand over this replay</b> (${escapeHtml(e.message.replace(/\.$/, ""))}). The beatmap is loading — ` +
         `${pageLink}, click <b>Download replay</b> and drop the file here.`);
    if (info.setId || info.beatmapId) await loadMapLink({ sid: info.setId, bid: info.beatmapId }, { quiet: true });
    return false;
  }
}

export async function afterFilesChanged() {
  if (!S.map && S.replays[0] && !S.mapFetching) { autoFetch(S.replays[0].md5); return; }
  if (S.map) {
    for (const slot of [0, 1]) {
      if (S.replays[slot] && !S.events[slot]) {
        try {
          const ev = await api.getEvents(slot);
          if (ev) { S.events[slot] = ev; prepStats(slot); }
        } catch (e) { /* ignore */ }
      }
    }
  }
  maybeStart();
}

export function maybeStart() {
  if (!S.map || !S.replays.some(Boolean)) return;
  for (const slot of [0, 1]) if (S.replays[slot] && !S.events[slot]) return;
  $("btn-watch").classList.remove("disabled");
  // Files dropped while watching: reload the player in place.
  if (!player.classList.contains("hidden")) enterPlayer();
}

/* ── enter / leave the player ──────────────────────────────────────── */

export function enterPlayer() {
  // The playfield is drawn as the first replay saw it (its CS/AR/HD/HR).
  const lead = S.replays[0] || S.replays[1];
  const mods0 = lead ? lead.mods : 0;
  const [cs, ar] = adjDifficulty(S.map.cs, S.map.ar, S.map.od, mods0);
  S.radius = circleRadius(cs);
  S.preempt = preemptMs(ar);
  S.fadeIn = 400 * Math.min(1, S.preempt / 450);
  S.hd = !!(mods0 & MOD.HD) && OPT.hiddenFx;
  S.hr = !!(mods0 & MOD.HR);
  prepareMap();

  const objs = S.map.objects;
  S.longest = objs.reduce((m, o) => Math.max(m, o.endT - o.t), 0);
  S.origin = objs.length ? Math.min(0, objs[0].t - S.preempt - 1500) : -2000;
  const lastFrame = Math.max(0, ...S.replays.filter(Boolean).map(r => r.frames.length ? r.frames[r.frames.length - 1][0] : 0));
  const lastObj = objs.reduce((m, o) => Math.max(m, o.endT), 0);
  S.endT = Math.max(lastObj + 1500, Math.min(lastFrame, lastObj + 6000), S.origin + 1);
  prepareTimeline();

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
        chip.className = "mod mod-" + ms.slice(k, k + 2);
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
  if (rate !== 1) toast(`${lead.modsStr} replay — playing at ${rate}× like the original`, "info");

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
  await api.clear();
  // Stop the previous map's song right away — otherwise it keeps playing
  // while the next map downloads, until enterPlayer() replaces it.
  if (S.audio) { S.audio.pause(); S.audio = null; }
  S.playing = false;
  S.replays = [null, null]; S.replayBytes = [null, null]; S.events = [null, null]; S.map = null;
  $("btn-watch").classList.add("disabled");
  chip("chip-r0", "drop a .osr");
  chip("chip-r1", "optional, to compare");
  chip("chip-map", "downloads automatically");
  hint("");
}
