/* Optional .osk skin: loads gameplay sprites from the server and tints /
   resizes them on demand (cached). Falls back to vector drawing when absent. */

import { SKIN, rgba } from "./core.js";
import { api } from "./api.js";

const tintCache = new Map();

export async function loadSkin() {
  try {
    const m = await api.getSkin();
    if (!m.present) return;
    SKIN.present = true;
    SKIN.colors = m.comboColors || [];
    SKIN.sliderBorder = m.sliderBorder;
    SKIN.sliderTrack = m.sliderTrack;
    for (const [name, info] of Object.entries(m.elements)) {
      const img = new Image();
      img.src = info.url;
      SKIN.el[name] = { img, scale: info.scale, w: info.w, h: info.h };
    }
    if (SKIN.colors.length) SKIN.palette = SKIN.colors;
  } catch (e) { /* run unskinned */ }
}

export function sprite(name, wpx, color) {
  const e = SKIN.el[name];
  if (!e || !e.img.complete || !e.img.naturalWidth) return null;
  wpx = Math.max(2, Math.round(wpx));
  const key = name + "|" + wpx + "|" + (color ? color.join() : "");
  let c = tintCache.get(key);
  if (c) return c;
  const h = Math.max(2, Math.round(wpx * e.img.naturalHeight / e.img.naturalWidth));
  c = document.createElement("canvas");
  c.width = wpx; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(e.img, 0, 0, wpx, h);
  if (color) {
    g.globalCompositeOperation = "multiply";
    g.fillStyle = rgba(color, 1);
    g.fillRect(0, 0, wpx, h);
    g.globalCompositeOperation = "destination-in";
    g.drawImage(e.img, 0, 0, wpx, h);
  }
  if (tintCache.size > 600) tintCache.clear();
  tintCache.set(key, c);
  return c;
}
