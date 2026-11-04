/* A small animated-GIF encoder (no library).

   • one global 255-colour palette, built by median cut over a 15-bit
     histogram gathered from sample frames (`addSample`);
   • each frame only stores the rectangle that changed since the previous
     one, and unchanged pixels inside it are transparent, so mostly-static
     clips stay small;
   • standard variable-width LZW.

   Usage: const g = new GifEncoder(w, h); g.addSample(rgba)…; g.buildPalette();
          g.addFrame(rgba, delayCs)…; const blob = g.finish(); */

const TRANSPARENT = 255;

export class GifEncoder {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.hist = new Uint32Array(32768);
    this.lut = null; this.palette = null;
    this.prev = null;                 // previous frame's palette indices
    this.parts = [];
  }

  addSample(rgba) {
    const d = rgba, hst = this.hist;
    for (let i = 0; i < d.length; i += 4) hst[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
  }

  /* Median cut → 255 colours (index 255 is reserved for transparency). */
  buildPalette() {
    const hst = this.hist, colors = [];
    for (let c = 0; c < 32768; c++) if (hst[c]) colors.push(c);
    const ch = (c, k) => k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31;
    const boxOf = list => {
      let lo = [31, 31, 31], hi = [0, 0, 0], n = 0;
      for (const c of list) {
        for (let k = 0; k < 3; k++) { const v = ch(c, k); if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        n += hst[c];
      }
      const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const axis = span[1] >= span[0] && span[1] >= span[2] ? 1 : span[0] >= span[2] ? 0 : 2;
      return { list, n, axis, span: span[axis] };
    };
    let boxes = colors.length ? [boxOf(colors)] : [];
    while (boxes.length < 255) {
      // split the most "important" box: pixel count × colour spread
      let best = -1, score = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.list.length < 2 || b.span === 0) continue;
        const s = Math.sqrt(b.n) * (b.span + 1);
        if (s > score) { score = s; best = i; }
      }
      if (best < 0) break;
      const b = boxes[best];
      b.list.sort((x, y) => ch(x, b.axis) - ch(y, b.axis));
      let acc = 0, cut = 1;
      for (let i = 0; i < b.list.length; i++) { acc += hst[b.list[i]]; if (acc >= b.n / 2) { cut = Math.min(b.list.length - 1, Math.max(1, i + 1)); break; } }
      boxes.splice(best, 1, boxOf(b.list.slice(0, cut)), boxOf(b.list.slice(cut)));
    }
    const pal = new Uint8Array(768), lut = new Uint8Array(32768);
    boxes.forEach((b, i) => {
      let r = 0, g = 0, bl = 0;
      for (const c of b.list) {
        const n = hst[c];
        r += ((c >> 10) * 8 + 4) * n; g += (((c >> 5) & 31) * 8 + 4) * n; bl += ((c & 31) * 8 + 4) * n;
        lut[c] = i;
      }
      pal[i * 3] = Math.round(r / b.n); pal[i * 3 + 1] = Math.round(g / b.n); pal[i * 3 + 2] = Math.round(bl / b.n);
    });
    // colours never seen in the samples: nearest palette entry, filled lazily
    this.seen = new Uint8Array(32768);
    for (const c of colors) this.seen[c] = 1;
    this.nColors = Math.max(1, boxes.length);
    this.palette = pal; this.lut = lut;
    this.header();
  }

  nearest(c) {
    const r = (c >> 10) * 8 + 4, g = ((c >> 5) & 31) * 8 + 4, b = (c & 31) * 8 + 4, p = this.palette;
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.nColors; i++) {
      const dr = p[i * 3] - r, dg = p[i * 3 + 1] - g, db = p[i * 3 + 2] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = i; }
    }
    this.lut[c] = best; this.seen[c] = 1;
    return best;
  }

  header() {
    const { w, h } = this, out = [];
    for (const ch of "GIF89a") out.push(ch.charCodeAt(0));
    out.push(w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0);    // global table, 256 entries
    for (let i = 0; i < 768; i++) out.push(this.palette[i]);
    // NETSCAPE2.0: loop forever
    out.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map(c => c.charCodeAt(0)), 3, 1, 0, 0, 0);
    this.parts.push(new Uint8Array(out));
  }

  addFrame(rgba, delayCs) {
    const { w, h } = this, n = w * h, idx = new Uint8Array(n), d = rgba;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const c = ((d[j] >> 3) << 10) | ((d[j + 1] >> 3) << 5) | (d[j + 2] >> 3);
      idx[i] = this.seen[c] ? this.lut[c] : this.nearest(c);
    }
    // changed rectangle vs the previous frame
    let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
    const prev = this.prev;
    if (prev) {
      x0 = w; y0 = h; x1 = -1; y1 = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          if (idx[row + x] !== prev[row + x]) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; y1 = y;
          }
        }
      }
      if (x1 < 0) { x0 = y0 = 0; x1 = y1 = 0; }          // identical frame: 1 transparent px
    }
    const fw = x1 - x0 + 1, fh = y1 - y0 + 1, px = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const k = (y + y0) * w + x + x0;
        px[y * fw + x] = prev && idx[k] === prev[k] ? TRANSPARENT : idx[k];
      }
    }
    this.prev = idx;
    const head = [
      0x21, 0xf9, 4, (1 << 2) | 1, delayCs & 255, delayCs >> 8, TRANSPARENT, 0,   // GCE: keep, transparent
      0x2c, x0 & 255, x0 >> 8, y0 & 255, y0 >> 8, fw & 255, fw >> 8, fh & 255, fh >> 8, 0,
    ];
    this.parts.push(new Uint8Array(head), lzw(px, 8));
  }

  finish() {
    this.parts.push(new Uint8Array([0x3b]));
    return new Blob(this.parts, { type: "image/gif" });
  }
}

/* GIF LZW, packed into 255-byte sub-blocks. */
function lzw(pixels, minCode) {
  const out = [minCode];
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  let dict = new Map();
  let cur = 0, bits = 0;
  const block = [];
  const emit = code => {
    cur |= code << bits; bits += codeSize;
    while (bits >= 8) {
      block.push(cur & 255); cur >>>= 8; bits -= 8;
      if (block.length === 255) { out.push(255, ...block); block.length = 0; }
    }
  };
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i], key = prefix * 256 + k, hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map(); codeSize = minCode + 1; next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(cur & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return new Uint8Array(out);
}
