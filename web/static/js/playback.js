/* Transport: play/pause, seeking, speed, frame stepping, hit-sound firing,
   audio sync and the main requestAnimationFrame loop (`tick`). */

import { $, S, OPT, clamp, upperBound, frameIndexAt } from "./core.js";
import { api } from "./api.js";
import { ICONS } from "./config.js";
import { draw } from "./render.js";
import { drawStats, updateHUD } from "./stats.js";
import { showResults } from "./screens.js";

/* ── hit sounds (WebAudio) ─────────────────────────────────────────── */

export function initSfx() {
  if (S.actx) return;
  try {
    S.actx = new (window.AudioContext || window.webkitAudioContext)();
    S.sfxGain = S.actx.createGain();
    S.sfxGain.gain.value = OPT.sfxVol / 100;
    S.sfxGain.connect(S.actx.destination);
    api.getHitsound()
      .then(b => b ? S.actx.decodeAudioData(b) : Promise.reject())
      .then(buf => { S.hitBuf = buf; })
      .catch(() => {});
  } catch (e) {}
}

function playHitSound() {
  if (!S.hitBuf || !S.actx) return;
  if (S.actx.state === "suspended") S.actx.resume();
  const src = S.actx.createBufferSource();
  src.buffer = S.hitBuf; src.connect(S.sfxGain); src.start();
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
  if (!S.playing || target < 0 || (a.duration && target >= a.duration)) { if (!a.paused) a.pause(); return; }
  a.playbackRate = S.speed;
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
  if (S.audio) S.audio.playbackRate = v;
}

export function stepFrame(dir) {
  setPlaying(false);
  const r = S.replays[0] || S.replays[1];
  if (!r || !r.frames.length) return;
  const f = r.frames;
  let i = frameIndexAt(f, S.t);
  i = clamp(i + dir, 0, f.length - 1);
  seekTo(f[i][0]);
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

  draw();
  updateHUD();
  if (!$("stats-panel").classList.contains("hidden")) drawStats();
  requestAnimationFrame(tick);
}
