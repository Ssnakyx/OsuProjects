/* Skin library UI: the grid of saved skins in Settings, one-click switching,
   deleting, and the K shortcut that cycles skins in the player.
   Storage lives in skin.js; this module only draws and dispatches. */

import { $, SKIN, toast, chip, escapeHtml } from "./core.js";
import { listSkins, switchSkin, deleteSkin, projectSkinInfo } from "./skin.js";

const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

/* Everything the user can pick, in display order. */
async function entries() {
  const list = [{ id: "builtin", name: "Built-in", sub: "vector style", builtin: true }];
  const proj = await projectSkinInfo();
  if (proj) list.push({ id: "project", name: proj.name || "Project skin", sub: "from the project folder", project: true });
  for (const m of await listSkins()) {
    list.push({ id: m.id, name: m.name, sub: [m.author && "by " + m.author, fmtSize(m.size)].filter(Boolean).join(" · "), thumb: m.thumb, user: true });
  }
  return list;
}

const BUILTIN_THUMB = `<svg viewBox="0 0 128 96" aria-hidden="true">
  <circle cx="54" cy="48" r="32" fill="currentColor" opacity=".9"/>
  <circle cx="54" cy="48" r="32" fill="none" stroke="#fff" stroke-width="5"/>
  <text x="54" y="50" fill="#fff" font-size="30" font-weight="800" text-anchor="middle" dominant-baseline="middle" font-family="system-ui, sans-serif">1</text>
  <circle cx="100" cy="68" r="9" fill="#fff"/></svg>`;
const PROJECT_THUMB = `<svg viewBox="0 0 128 96" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round">
  <path d="M30 30h24l8 8h36v34H30Z"/></svg>`;

let busy = false;

export async function renderSkinLibrary() {
  const box = $("skin-lib");
  if (!box) return;
  const list = await entries();
  box.innerHTML = list.map(e => `
    <div class="skin-card${e.id === SKIN.id ? " active" : ""}" data-id="${escapeHtml(e.id)}" role="button" tabindex="0"
         title="${escapeHtml(e.id === SKIN.id ? "In use" : "Use " + e.name)}">
      <div class="skin-thumb${e.thumb ? "" : " vector"}">${e.thumb ? `<img src="${e.thumb}" alt="">` : e.project ? PROJECT_THUMB : BUILTIN_THUMB}</div>
      <div class="skin-meta">
        <span class="skin-name">${escapeHtml(e.name)}</span>
        <span class="skin-src">${escapeHtml(e.sub)}</span>
      </div>
      ${e.id === SKIN.id ? '<span class="skin-badge">in use</span>' : ""}
      ${e.user ? `<button class="skin-del" data-del="${escapeHtml(e.id)}" title="Delete from library" aria-label="Delete ${escapeHtml(e.name)}">✕</button>` : ""}
    </div>`).join("");
  const n = list.filter(e => e.user).length;
  $("skin-lib-note").textContent = n
    ? `${n} skin${n > 1 ? "s" : ""} saved in this browser · press K in the player to cycle`
    : "Skins you load are kept in this browser, so you can switch in one click.";
}

export async function pickSkin(id) {
  if (busy || id === SKIN.id) return;
  busy = true;
  chip("chip-skin", "loading…", "busy");
  try {
    await switchSkin(id);
    toast(SKIN.present ? `Skin: ${SKIN.name}` : "Built-in style", "ok", 1800);
  } catch (e) {
    toast("Couldn't switch skin: " + e.message, "error");
  }
  busy = false;
  document.dispatchEvent(new CustomEvent("skinchange"));
}

async function removeFromLibrary(id) {
  if (busy) return;
  const card = $("skin-lib").querySelector(`[data-id="${CSS.escape(id)}"] .skin-name`);
  const name = card ? card.textContent : "skin";
  busy = true;
  await deleteSkin(id);
  busy = false;
  toast(`Deleted ${name} from your library.`, "ok");
  document.dispatchEvent(new CustomEvent("skinchange"));
}

/* Next skin in the library (K in the player). */
export async function cycleSkin(dir = 1) {
  const list = await entries();
  if (list.length < 2) { toast("Only one skin available — add .osk files to build a library.", "info", 2400); return; }
  const i = list.findIndex(e => e.id === SKIN.id);
  await pickSkin(list[(i + dir + list.length) % list.length].id);
}

export function bindSkinLibrary() {
  const box = $("skin-lib");
  box.addEventListener("click", e => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); removeFromLibrary(del.dataset.del); return; }
    const card = e.target.closest(".skin-card");
    if (card) pickSkin(card.dataset.id);
  });
  box.addEventListener("keydown", e => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".skin-card");
    if (card && !e.target.closest("[data-del]")) { e.preventDefault(); pickSkin(card.dataset.id); }
  });
  document.addEventListener("skinchange", renderSkinLibrary);
}
