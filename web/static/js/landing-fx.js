/* Landing visuals ported from the osu! Replay Viewer Design System
   (claude.ai/design): the osu!lazer triangle motif (drifting equilateral
   triangles behind the menu, inside the dropzone and inside the cookie) and
   the radial audio-spectrum Visualizer ring around the cookie logo.

   Pure canvas, no audio — the spectrum is a synthesized waveform. Honors
   prefers-reduced-motion (one static frame) and pauses while a replay plays. */

const DPR = Math.min(window.devicePixelRatio || 1, 2);
const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Triangle field bound to one canvas. `data-full` sizes to the viewport,
   otherwise it tracks its positioned parent. */
function triLayer(canvas, opt) {
  const ctx = canvas.getContext("2d");
  const o = Object.assign(
    { count: 24, color: "rgba(255,255,255,.05)", speed: 1, minSize: 40, maxSize: 180, opacity: 1, frac: null },
    opt
  );
  let W = 0, H = 0, tris = [];

  function spawn(init) {
    const s = o.minSize + Math.random() * (o.maxSize - o.minSize);
    return {
      x: Math.random() * W,
      y: init ? Math.random() * (H + s) : H + s,
      s,
      v: (8 + Math.random() * 26) * o.speed * (0.4 + s / o.maxSize),
    };
  }
  function size() {
    if (canvas.dataset.full != null) { W = innerWidth; H = innerHeight; }
    else {
      const r = canvas.parentNode.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
    }
    if (o.frac) { o.minSize = W * o.frac[0]; o.maxSize = W * o.frac[1]; }
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (!tris.length) tris = Array.from({ length: o.count }, () => spawn(true));
  }
  function draw(dt) {
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = o.opacity; ctx.fillStyle = o.color;
    for (const t of tris) {
      if (!REDUCE) t.y -= t.v * dt;
      if (t.y + t.s < -10) Object.assign(t, spawn(false));
      const h = t.s * 0.866;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y - h * 0.66);
      ctx.lineTo(t.x + t.s / 2, t.y + h * 0.33);
      ctx.lineTo(t.x - t.s / 2, t.y + h * 0.33);
      ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  size();
  return { size, draw };
}

/* Radial spectrum ring. Sizes itself from the cookie element so the bars
   always sit just outside the disc, whatever the responsive cookie size. */
function visLayer(canvas, cookieEl) {
  const ctx = canvas.getContext("2d");
  const bars = 100;
  const seeds = Array.from({ length: bars }, () => 0.5 + Math.random());
  let SZ = 360, radius = 110, t = 0;

  function size() {
    const cw = cookieEl.getBoundingClientRect().width || 208;
    SZ = Math.round(cw * 2.0);
    radius = SZ * 0.314;
    canvas.width = SZ * DPR; canvas.height = SZ * DPR;
    canvas.style.width = SZ + "px"; canvas.style.height = SZ + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  function draw(dt) {
    if (!REDUCE) t += dt * 1.08;
    const col = document.documentElement.style.getPropertyValue("--accent").trim() || "#ff66aa";
    const cx = SZ / 2, cy = SZ / 2;
    ctx.clearRect(0, 0, SZ, SZ);
    const kick = Math.pow(Math.max(0, Math.sin(t * 3.2)), 6) * 0.5;
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.strokeStyle = col;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const wave = 0.5 + 0.5 * Math.sin(t * 2 + i * 0.5) * Math.cos(t * 0.7 + i * 0.13);
      const h = (6 + (wave * 0.7 + kick) * 46) * seeds[i];
      ctx.globalAlpha = 0.25 + wave * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.lineTo(cx + Math.cos(a) * (radius + h), cy + Math.sin(a) * (radius + h));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  size();
  return { size, draw };
}

let layers = [], raf = 0, running = false, last = 0;

function build() {
  const TRI = "rgba(255,255,255,.05)", TRI_PINK = "rgba(255,255,255,.14)";
  const bg = document.getElementById("tri-bg");
  if (bg) layers.push(triLayer(bg, { count: 30, color: TRI, speed: 1 }));
  const dz = document.querySelector("#dropzone .dz-tri");
  if (dz) layers.push(triLayer(dz, { count: 10, color: TRI, speed: 0.7, maxSize: 120, opacity: 0.7 }));
  const ck = document.querySelector(".cookie-disc .cookie-tri");
  if (ck) layers.push(triLayer(ck, { count: 14, color: TRI_PINK, speed: 1.4, frac: [0.12, 0.5] }));
  const cookie = document.getElementById("osu-cookie");
  const vis = document.getElementById("visualizer");
  if (vis && cookie) layers.push(visLayer(vis, cookie));
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (const l of layers) l.draw(dt);
  if (REDUCE) { running = false; return; }
  raf = requestAnimationFrame(frame);
}

export function startLandingFx() {
  if (running) return;
  if (!layers.length) build();
  if (!layers.length) return;
  running = true; last = performance.now();
  raf = requestAnimationFrame(frame);
}
export function stopLandingFx() { running = false; cancelAnimationFrame(raf); }
export function sizeLandingFx() { for (const l of layers) l.size(); }

/* Pause the loop while a replay is playing; resume on the landing. */
new MutationObserver(() => {
  if (document.body.classList.contains("playing")) stopLandingFx();
  else startLandingFx();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });
