/* Transport: play/pause, seeking, speed, frame stepping, hit-sound firing,
   audio sync and the main requestAnimationFrame loop (`tick`). */

import { $, S, OPT, SKIN, clamp, upperBound, frameIndexAt } from "./core.js";
import { api } from "./api.js";
import { ICONS } from "./config.js";
import { draw } from "./render.js";
import { drawStats, updateHUD } from "./stats.js";
import { showResults } from "./screens.js";
import { drawTimeline, missTarget, noteTarget } from "./timeline.js";

/* Below this rate the music is muted: browsers either refuse such slow
   playback rates or play them silently / garbled. The replay keeps running
   on its own clock and hit sounds still fire. */
const MIN_AUDIO_RATE = 0.25;
let slowPrev = null;      // speed to restore when leaving the Q slow-motion

/* ── hit sounds (WebAudio) ─────────────────────────────────────────── */

export function initSfx() {
  if (S.actx) { loadSkinHitsound(); return; }
  try {
    S.actx = new (window.AudioContext || window.webkitAudioContext)();
    S.sfxGain = S.actx.createGain();
    S.sfxGain.gain.value = OPT.sfxVol / 100;
    S.sfxGain.connect(S.actx.destination);
    api.getHitsound()
      .then(b => b ? S.actx.decodeAudioData(b) : Promise.reject())
      .then(buf => { S.hitBuf = buf; })
      .catch(() => {});
    loadSkinHitsound();
  } catch (e) {}
}

/* Decode the skin's normal-hitnormal (if it has one) so hits sound like
   the player's own skin. Re-run whenever the skin changes. */
let skinSndSrc = null;
export function loadSkinHitsound() {
  if (!S.actx) return;
  const bytes = SKIN.present ? SKIN.hitsound : null;
  if (bytes === skinSndSrc) return;
  skinSndSrc = bytes;
  S.skinHitBuf = null;
  if (!bytes) return;
  S.actx.decodeAudioData(bytes.slice(0)).then(buf => { if (skinSndSrc === bytes) S.skinHitBuf = buf; }).catch(() => {});
}
document.addEventListener("skinchange", loadSkinHitsound);

function playHitSound() {
  const buf = (OPT.useSkin && S.skinHitBuf) || S.hitBuf;
  if (!buf || !S.actx) return;
  if (S.actx.state === "suspended") S.actx.resume();
  const src = S.actx.createBufferSource();
  src.buffer = buf; src.connect(S.sfxGain); src.start();
}

/* ── transport ─────────────────────────────────────────────────────── */

export function setPlaying(p) {
  S.playing = p;
  $("btn-play").innerHTML = p ? ICONS.pause : ICONS.play;
  if (!p) { if (S.audio) S.audio.pause(); }
  else { S.lastNow = performance.now(); syncAudio(true); }
}

export function syncAudio(force) {
  const a = S.audio;
  if (!a) return;
  const target = S.t / 1000;
  if (!S.playing || target < 0 || (a.duration && target >= a.duration) || S.speed < MIN_AUDIO_RATE) { if (!a.paused) a.pause(); return; }
  try { a.playbackRate = S.speed; } catch (e) {}
  if (force || a.paused || Math.abs(a.currentTime - target) > 0.12) {
    try { a.currentTime = Math.max(0, target); } catch (e) {}
    a.play().then(() => { S.audioBlocked = false; }).catch(() => { S.audioBlocked = true; });
  }
}

export function seekTo(t) {
  S.t = clamp(t, S.origin, S.endT);
  if (S.t < S.endT) S.ended = false;   // allow the results screen to show again
  const evs = S.events[0] ? S.events[0].events : (S.events[1] ? S.events[1].events : []);
  S.hitIdx = upperBound(evs, S.t);
  syncAudio(true);
}

export function setSpeed(v) {
  S.speed = v;
  $("speed").value = String(v);
  if (S.audio && v >= MIN_AUDIO_RATE) { try { S.audio.playbackRate = v; } catch (e) {} }
  if (v !== 0.25) slowPrev = null;
  syncAudio(false);   // resumes the music when coming back from a muted rate
}

/* Q: toggle 0.25× slow motion, then back to whatever speed was set before. */
export function toggleSlowMo() {
  if (slowPrev !== null && S.speed === 0.25) { const back = slowPrev; slowPrev = null; setSpeed(back); return; }
  const prev = S.speed;
  setSpeed(0.25);
  slowPrev = prev === 0.25 ? 1 : prev;
}

/* One replay frame forward / back. Frames are merged across both replays
   so stepping never skips a frame of the second player. */
export function stepFrame(dir) {
  setPlaying(false);
  let best = null;
  for (const r of S.replays) {
    if (!r || !r.frames.length) continue;
    const f = r.frames;
    let i = frameIndexAt(f, S.t);
    if (dir > 0) { while (i < f.length && f[i][0] <= S.t + 0.01) i++; if (i >= f.length) continue; }
    else { while (i >= 0 && f[i][0] >= S.t - 0.01) i--; if (i < 0) continue; }
    const t = f[i][0];
    if (best === null || (dir > 0 ? t < best : t > best)) best = t;
  }
  if (best !== null) seekTo(best);
}

/* Shift + , / . : land exactly on the previous / next hit object. */
export function stepNote(dir) {
  setPlaying(false);
  const t = noteTarget(dir);
  if (t !== null) seekTo(t);
}

/* [ / ] : jump to the previous / next miss (just before the note appears). */
export function jumpMiss(dir) {
  const t = missTarget(dir);
  if (t === null) return false;
  seekTo(t);
  return true;
}

export function skipIntro() {
  const first = S.map && S.map.objects.length ? S.map.objects[0].t : null;
  if (first !== null && S.t < first - S.preempt - 1000) seekTo(first - S.preempt - 600);
}

function fireHitSounds() {
  const e0 = S.events[0] || S.events[1];
  if (!e0) return;
  const evs = e0.events;
  let n = 0;
  while (S.hitIdx < evs.length && evs[S.hitIdx][0] <= S.t) {
    if (evs[S.hitIdx][4] > 0 && n < 6) { playHitSound(); n++; }
    S.hitIdx++;
  }
}

/* ── frame loop ────────────────────────────────────────────────────── */

export function tick(now) {
  // schedule first: an exception while drawing must never stop the loop
  requestAnimationFrame(tick);
  const dt = now - S.lastNow;
  if (S.playing && !S.seeking) {
    S.t += dt * S.speed;
    const a = S.audio;
    if (a && !a.paused && a.duration) {
      const at = a.currentTime * 1000;
      if (Math.abs(at - S.t) > 60) S.t = at;
    } else if (a && S.t >= 0) {
      syncAudio(false);
    }
    if (S.t >= S.endT) {
      S.t = S.endT; setPlaying(false);
      if (!S.ended) { S.ended = true; showResults(); }
    }
    fireHitSounds();
  }
  S.lastNow = now;

  if (OPT.showFps) {
    S.fpsAcc += dt; S.fpsN++;
    if (S.fpsAcc >= 500) { S.fps = Math.round(1000 * S.fpsN / S.fpsAcc); S.fpsAcc = 0; S.fpsN = 0; $("fps").textContent = S.fps + " fps"; }
  }

  try {
    draw();
    updateHUD();
    drawTimeline();
    if (!$("stats-panel").classList.contains("hidden")) drawStats();
  } catch (e) { console.error(e); }
}
