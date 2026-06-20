/* Entry point: wires up the DOM (buttons, drag & drop, keyboard, sliders)
   and boots the app. Loaded as a module, so it runs after the DOM is ready. */

import { SPEED_OPTS, APP_VERSION } from "./config.js";
import { $, S, OPT, toast, landing, canvas, saveSettings, resetOptions } from "./core.js";
import { loadSkin } from "./skin.js";
import { handleFiles, clearSession, goLanding, enterPlayer, maybeStart } from "./session.js";
import { setPlaying, seekTo, setSpeed, stepFrame, skipIntro, syncAudio } from "./playback.js";
import {
  openSettings, closeSettings, bindSettings, applySettings,
  startParticles, sizeParticles,
} from "./settings.js";
import { openPatch, closePatch, closeResults } from "./screens.js";
import { openDB, getRecent, renderRecent, clearRecent } from "./recent.js";
import { startLandingFx, sizeLandingFx } from "./landing-fx.js";

/* ── small view toggles ────────────────────────────────────────────── */

function toggleMode() {
  if (!(S.replays[0] && S.replays[1])) return;
  S.mode = S.mode === "overlay" ? "split" : "overlay";
  $("btn-mode").textContent = S.mode === "overlay" ? "SPLIT" : "OVERLAY";
}
function toggleStats() { $("stats-panel").classList.toggle("hidden"); }

/* ── drag & drop (counter avoids flicker) ──────────────────────────── */

let dragDepth = 0;
window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("dropzone").classList.add("drag"); });
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("dragleave", e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $("dropzone").classList.remove("drag"); } });
window.addEventListener("drop", e => {
  e.preventDefault(); dragDepth = 0; $("dropzone").classList.remove("drag");
  if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
});

/* ── landing buttons ───────────────────────────────────────────────── */

$("btn-replays").onclick = () => $("file-replays").click();
$("btn-map").onclick = () => $("file-map").click();
// The cookie logo: start if a replay is ready, otherwise open the file picker.
$("osu-cookie").onclick = () =>
  $("btn-watch").classList.contains("disabled") ? $("file-replays").click() : enterPlayer();
$("file-replays").onchange = e => { handleFiles([...e.target.files]); e.target.value = ""; };
$("file-map").onchange = e => { handleFiles([...e.target.files]); e.target.value = ""; };

$("btn-clear").onclick = async () => { await clearSession(); toast("Session cleared.", "ok"); };
$("btn-recent-clear").onclick = async () => { await clearRecent(); toast("Recent replays cleared.", "ok"); };
$("btn-watch").onclick = () => { if ($("btn-watch").classList.contains("disabled")) return; enterPlayer(); };

/* ── player controls ───────────────────────────────────────────────── */

$("btn-play").onclick = () => setPlaying(!S.playing);
$("btn-restart").onclick = () => { seekTo(S.origin); setPlaying(true); };
$("btn-step-b").onclick = () => stepFrame(-1);
$("btn-step-f").onclick = () => stepFrame(1);
$("btn-skip").onclick = skipIntro;
$("btn-mode").onclick = toggleMode;
$("btn-stats").onclick = toggleStats;
$("stats-close").onclick = toggleStats;
$("btn-files").onclick = goLanding;
$("btn-full").onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); };
$("btn-help").onclick = () => $("help-modal").classList.toggle("hidden");
$("help-close").onclick = () => $("help-modal").classList.add("hidden");
$("help-modal").onclick = e => { if (e.target === $("help-modal")) $("help-modal").classList.add("hidden"); };

/* ── patch notes ───────────────────────────────────────────────────── */

$("btn-patch").onclick = openPatch;
$("patch-close").onclick = closePatch;
$("patch-done").onclick = closePatch;
$("patch-modal").onclick = e => { if (e.target === $("patch-modal")) closePatch(); };

/* ── results screen ────────────────────────────────────────────────── */

$("results-menu").onclick = async () => { closeResults(); await clearSession(); goLanding(); };
$("results-again").onclick = () => { closeResults(); S.ended = false; seekTo(S.origin); setPlaying(true); };
$("results-modal").onclick = e => { if (e.target === $("results-modal")) closeResults(); };

/* ── settings ──────────────────────────────────────────────────────── */

$("btn-gear").onclick = openSettings;
$("btn-set").onclick = openSettings;
$("settings-close").onclick = closeSettings;
$("settings-done").onclick = closeSettings;
$("settings-modal").onclick = e => { if (e.target === $("settings-modal")) closeSettings(); };
$("settings-reset").onclick = () => { resetOptions(); bindSettings(); applySettings(); saveSettings(); toast("Settings reset to defaults.", "ok"); };

$("speed").onchange = e => setSpeed(parseFloat(e.target.value));
$("vol-music").oninput = e => { OPT.musicVol = +e.target.value; if (S.audio) S.audio.volume = OPT.musicVol / 100; saveSettings(); };
$("vol-sfx").oninput = e => { OPT.sfxVol = +e.target.value; if (S.sfxGain) S.sfxGain.gain.value = OPT.sfxVol / 100; saveSettings(); };

/* ── seek bar ──────────────────────────────────────────────────────── */

const seekEl = $("seek");
seekEl.addEventListener("pointerdown", () => { S.seeking = true; });
seekEl.addEventListener("input", () => { S.t = S.origin + (seekEl.value / 1000) * (S.endT - S.origin); });
seekEl.addEventListener("change", () => { S.seeking = false; seekTo(S.t); });

/* click canvas to pause/resume (nice on touch) */
canvas.addEventListener("click", () => { if (S.started) setPlaying(!S.playing); });

document.addEventListener("click", () => {
  if (S.audioBlocked && S.playing) syncAudio(true);
  if (S.actx && S.actx.state === "suspended") S.actx.resume();
});

window.addEventListener("resize", () => { sizeParticles(); sizeLandingFx(); });

/* ── keyboard ──────────────────────────────────────────────────────── */

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") {
    if (e.code === "Space") e.target.blur(); else return;
  }
  if (!$("settings-modal").classList.contains("hidden")) { if (e.code === "Escape") closeSettings(); return; }
  if (!$("patch-modal").classList.contains("hidden")) { if (e.code === "Escape") closePatch(); return; }
  if (!$("results-modal").classList.contains("hidden")) { if (e.code === "Escape") closeResults(); return; }
  if (!S.started) { if (e.code === "Escape" && S.map) maybeStart(); return; }
  switch (e.code) {
    case "Space": e.preventDefault(); setPlaying(!S.playing); break;
    case "KeyR": seekTo(S.origin); setPlaying(true); break;
    case "KeyS": skipIntro(); break;
    case "KeyD": toggleStats(); break;
    case "Tab": e.preventDefault(); toggleMode(); break;
    case "ArrowLeft": seekTo(S.t - 5000); break;
    case "ArrowRight": seekTo(S.t + 5000); break;
    case "Comma": stepFrame(-1); break;
    case "Period": stepFrame(1); break;
    case "Minus": case "NumpadSubtract": { const i = SPEED_OPTS.indexOf(S.speed); setSpeed(SPEED_OPTS[Math.max(0, (i < 0 ? 3 : i) - 1)]); break; }
    case "Equal": case "NumpadAdd": { const i = SPEED_OPTS.indexOf(S.speed); setSpeed(SPEED_OPTS[Math.min(SPEED_OPTS.length - 1, (i < 0 ? 3 : i) + 1)]); break; }
    case "KeyF": $("btn-full").click(); break;
    case "KeyH": $("btn-help").click(); break;
    case "Escape":
      if (!$("help-modal").classList.contains("hidden")) $("help-modal").classList.add("hidden");
      else if (!$("stats-panel").classList.contains("hidden")) toggleStats();
      else if (landing.classList.contains("hidden")) goLanding();
      break;
  }
});

/* ── ripple effect on primary buttons ──────────────────────────────── */

document.addEventListener("pointerdown", e => {
  const b = e.target.closest(".btn");
  if (!b) return;
  const r = b.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = size + "px";
  s.style.left = (e.clientX - r.left - size / 2) + "px";
  s.style.top = (e.clientY - r.top - size / 2) + "px";
  b.appendChild(s);
  setTimeout(() => s.remove(), 600);
});

/* ── boot ──────────────────────────────────────────────────────────── */

loadSkin();
bindSettings();
applySettings();
if (OPT.bgParticles) startParticles();
startLandingFx();
openDB();
getRecent().then(renderRecent);

// Auto-open the patch notes once when the app version changes.
try {
  if (localStorage.getItem("orv-version") !== APP_VERSION) openPatch();
} catch (_) {}
