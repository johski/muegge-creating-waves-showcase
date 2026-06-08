// MUEGGE "Creating Waves" — Partikel-Engine #2 (stateful, mit Trails)
//
// Zweite Engine neben wave.js. Hier leben die Modi, die echten Partikel-STATE
// brauchen (Velocity, Respawn, Trails): Strudel, Bouncing, Konstellation, Nebel, Interaktiv.
//
// API (gleiche Form wie wave.js):
//   const f = createParticleField(canvas, { mode, colors });
//   f.setMode('strudel'); f.destroy();
//
// Trails: preserveDrawingBuffer + pro Frame eine halbtransparente Hintergrund-Quad
// (Fade) -> alte Spuren verblassen; Partikel werden additiv darübergezeichnet.

const COLORS = {
  deep:  [0x0a / 255, 0x1d / 255, 0x37 / 255], // brand.deep (Gradient oben/unten — wie wave.js)
  bg:    [0x0a / 255, 0x15 / 255, 0x23 / 255], // brand.ink
  cyan:  [0x60 / 255, 0xc6 / 255, 0xf0 / 255], // brand.primary
  green: [0x61 / 255, 0xce / 255, 0x70 / 255],
};

// Pro-Modus-Parameter
const MODES = {
  bounce:        { n: 1400, size: 3.4, fade: 0.140, spawn: 'box'  },  // langsamer Start, Schubs beschleunigt
  mist:          { n: 4800, size: 1.9, fade: 0.007, spawn: 'box'  },  // "Strömung": akkumulierende Trails -> dichte Filamente (screen2). fade = Dichte-Regler (kleiner = dichter)
  repel:         { n: 3000, size: 2.4, fade: 0.045, spawn: 'box'  },  // "Pfade": Flow + starker Cursor-Wirbel
};

// ---- Shader ----
const VERT = `
precision mediump float;
attribute vec2 a_pos;      // Pixelkoordinaten
attribute float a_bright;
uniform vec2 u_res; uniform float u_size, u_dpr;
varying float v_b;
void main(){
  vec2 clip = (a_pos / u_res) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = u_size * u_dpr * (0.6 + a_bright * 0.9);
  v_b = a_bright;
}`;
const FRAG = `
precision mediump float;
varying float v_b;
uniform vec3 u_col;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, d), 1.6) * (0.55 + v_b * 0.45);  // weicher -> kein graues Ausbleichen bei Überlagerung
  gl_FragColor = vec4(u_col * v_b, a);  // additiv (SRC_ALPHA, ONE)
}`;
// Hintergrund/Fade als Brand-Gradient (Deep->Ink) wie wave.js — Trails verblassen ins Blau, nicht ins Grau
const Q_VERT = `attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
const Q_FRAG = `precision mediump float; varying vec2 v; uniform vec3 u_top, u_bot; uniform float u_a;
  void main(){ float t = smoothstep(0.0, 1.0, 1.0 - v.y); gl_FragColor = vec4(mix(u_bot, u_top, t), u_a); }`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  return p;
}

// kompaktes 2D Value-Noise (für Flow-Felder)
function hash2(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; // 0..1
}

export function createParticleField(canvas, opts = {}) {
  const colors = Object.assign({}, COLORS, opts.colors);
  const dprCap = opts.dprCap || 2;
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
  if (!gl) return { setMode() {}, setColors() {}, scrub() {}, destroy() {} };

  const prog = program(gl, VERT, FRAG);
  const quad = program(gl, Q_VERT, Q_FRAG);
  const loc = {
    pos: gl.getAttribLocation(prog, 'a_pos'), bright: gl.getAttribLocation(prog, 'a_bright'),
    res: gl.getUniformLocation(prog, 'u_res'), size: gl.getUniformLocation(prog, 'u_size'),
    dpr: gl.getUniformLocation(prog, 'u_dpr'), col: gl.getUniformLocation(prog, 'u_col'),
  };
  const qloc = { p: gl.getAttribLocation(quad, 'p'), top: gl.getUniformLocation(quad, 'u_top'), bot: gl.getUniformLocation(quad, 'u_bot'), a: gl.getUniformLocation(quad, 'u_a') };

  const bQuad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, bQuad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const NMAX = 5000;
  const pos = new Float32Array(NMAX * 2);   // px
  const vel = new Float32Array(NMAX * 2);
  const bri = new Float32Array(NMAX);
  const seed = new Float32Array(NMAX);      // pro-Partikel Zufall
  const gpu = new Float32Array(NMAX * 3);   // interleaved x,y,bright fürs Rendern
  const bGpu = gl.createBuffer();

  let W = 1, H = 1, DPR = 1;
  let mode = opts.mode || 'mist';
  let cfg = MODES[mode];
  let N = cfg.n;
  let mx = -1e6, my = -1e6, mActive = 0;   // Maus (px) + Aktivität
  const rnd = (() => { let s = 1337; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();

  function spawn(i) {
    const cx = W / 2, cy = H / 2, S = Math.min(W, H);
    seed[i] = rnd();
    if (cfg.spawn === 'ring') {                       // Strudel: über die ganze Scheibe verteilt (füllt den Wirbel)
      const a = rnd() * Math.PI * 2, r = S * (0.10 + rnd() * 0.48);
      pos[i * 2] = cx + Math.cos(a) * r; pos[i * 2 + 1] = cy + Math.sin(a) * r;
      vel[i * 2] = 0; vel[i * 2 + 1] = 0;
    } else if (cfg.spawn === 'disk') {                // Schwarzes Loch: Ring außerhalb des Horizonts (Mitte bleibt leer)
      const a = rnd() * Math.PI * 2, r = S * (0.24 + rnd() * 0.34);
      pos[i * 2] = cx + Math.cos(a) * r; pos[i * 2 + 1] = cy + Math.sin(a) * r;
      vel[i * 2] = 0; vel[i * 2 + 1] = 0;
    } else if (cfg.spawn === 'blob') {                // Konstellation: in einem Kreis
      const a = rnd() * Math.PI * 2, r = S * 0.36 * Math.sqrt(rnd());
      pos[i * 2] = cx + Math.cos(a) * r; pos[i * 2 + 1] = cy + Math.sin(a) * r;
      vel[i * 2] = 0; vel[i * 2 + 1] = 0;
    } else {                                          // box: ganzes Feld (langsamer Start)
      pos[i * 2] = rnd() * W; pos[i * 2 + 1] = rnd() * H;
      vel[i * 2] = (rnd() * 2 - 1) * S * 0.06; vel[i * 2 + 1] = (rnd() * 2 - 1) * S * 0.06;
    }
    bri[i] = 0.4 + rnd() * 0.6;
  }
  function reseed() {
    cfg = MODES[mode]; N = cfg.n;
    for (let i = 0; i < N; i++) spawn(i);
  }

  // ---- Physik pro Modus ----
  function step(dt) {
    const cx = W / 2, cy = H / 2, S = Math.min(W, H);
    dt = Math.min(dt, 0.04);
    if (mode === 'bounce') {
      for (let i = 0; i < N; i++) {
        // Cursor SCHUBST kräftig (im Radius) -> beschleunigt; sonst langsames Treiben
        if (mActive > 0.01) {
          const dx = pos[i * 2] - mx, dy = pos[i * 2 + 1] - my, r2 = dx * dx + dy * dy;
          const rad = S * 0.24;
          if (r2 < rad * rad) { const r = Math.sqrt(r2) || 1; const f = (1 - r / rad) * S * 4.0; vel[i * 2] += dx / r * f * dt; vel[i * 2 + 1] += dy / r * f * dt; }
        }
        vel[i * 2] *= (1 - dt * 0.25); vel[i * 2 + 1] *= (1 - dt * 0.25);   // sanfte Reibung -> kehrt zu langsam zurück
        pos[i * 2] += vel[i * 2] * dt; pos[i * 2 + 1] += vel[i * 2 + 1] * dt;
        if (pos[i * 2] < 0) { pos[i * 2] = 0; vel[i * 2] = Math.abs(vel[i * 2]) * 0.92; }
        if (pos[i * 2] > W) { pos[i * 2] = W; vel[i * 2] = -Math.abs(vel[i * 2]) * 0.92; }
        if (pos[i * 2 + 1] < 0) { pos[i * 2 + 1] = 0; vel[i * 2 + 1] = Math.abs(vel[i * 2 + 1]) * 0.92; }
        if (pos[i * 2 + 1] > H) { pos[i * 2 + 1] = H; vel[i * 2 + 1] = -Math.abs(vel[i * 2 + 1]) * 0.92; }
        const sp = Math.hypot(vel[i * 2], vel[i * 2 + 1]);
        bri[i] = 0.4 + Math.min(1, sp / (S * 0.35)) * 0.6;   // heller wenn schneller (nach Schubs)
      }
    } else {  // mist = "Strömung", repel = "Pfade": Flow-Feld + Trails
      const t = (perf() * 0.0001);
      const fscale = 0.0022;                          // glatte Streamlines -> lange Filamente
      const maxv = (mode === 'mist' ? 0.22 : 0.18) * S;
      const acc = 1.0 * S;
      for (let i = 0; i < N; i++) {
        const ang = noise2(pos[i * 2] * fscale, pos[i * 2 + 1] * fscale + t) * Math.PI * 4.0;
        let fx = Math.cos(ang), fy = Math.sin(ang);
        if (mode === 'repel' && mActive > 0.01) {     // Pfade: STARKER Cursor-Wirbel (großer Radius)
          const dx = pos[i * 2] - mx, dy = pos[i * 2 + 1] - my, r = Math.hypot(dx, dy) || 1;
          const infl = Math.exp(-(r * r) / (S * S * 0.12));
          fx = fx * (1.0 - infl) + (-dy / r) * infl * 1.8;   // kräftig um den Cursor wirbeln
          fy = fy * (1.0 - infl) + (dx / r) * infl * 1.8;
        }
        vel[i * 2] += fx * acc * dt; vel[i * 2 + 1] += fy * acc * dt;
        const sp = Math.hypot(vel[i * 2], vel[i * 2 + 1]);
        if (sp > maxv) { vel[i * 2] *= maxv / sp; vel[i * 2 + 1] *= maxv / sp; }
        pos[i * 2] += vel[i * 2] * dt; pos[i * 2 + 1] += vel[i * 2 + 1] * dt;
        bri[i] = (mode === 'mist' ? 0.22 + Math.min(1, sp / maxv) * 0.4 : 0.3 + Math.min(1, sp / maxv) * 0.55);
        // wrap (volles Feld) -> kein Verschmelzen in einen Punkt
        if (pos[i * 2] < 0) pos[i * 2] += W; if (pos[i * 2] > W) pos[i * 2] -= W;
        if (pos[i * 2 + 1] < 0) pos[i * 2 + 1] += H; if (pos[i * 2 + 1] > H) pos[i * 2 + 1] -= H;
      }
    }
    mActive = Math.max(0, mActive - dt * 1.5);
  }

  function drawBg(alpha) {  // Brand-Gradient (Deep oben/Ink) als Quad; alpha<1 = Trail-Fade, alpha=1 = voll
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, bQuad);
    gl.enableVertexAttribArray(qloc.p); gl.vertexAttribPointer(qloc.p, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3f(qloc.top, colors.deep[0], colors.deep[1], colors.deep[2]);
    gl.uniform3f(qloc.bot, colors.bg[0], colors.bg[1], colors.bg[2]);
    gl.uniform1f(qloc.a, alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function render() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    drawBg(cfg.fade);   // Trail-Fade: Gradient halbtransparent über alles -> alte Spuren verblassen ins Blau

    // Partikel additiv
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(prog);
    for (let i = 0; i < N; i++) { gpu[i * 3] = pos[i * 2]; gpu[i * 3 + 1] = pos[i * 2 + 1]; gpu[i * 3 + 2] = bri[i]; }
    gl.bindBuffer(gl.ARRAY_BUFFER, bGpu);
    gl.bufferData(gl.ARRAY_BUFFER, gpu.subarray(0, N * 3), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(loc.bright); gl.vertexAttribPointer(loc.bright, 1, gl.FLOAT, false, 12, 8);
    gl.uniform2f(loc.res, canvas.width, canvas.height);
    gl.uniform1f(loc.size, cfg.size); gl.uniform1f(loc.dpr, DPR);
    const c = (mode === 'mist') ? [0.62, 0.78, 0.98] : colors.cyan;
    gl.uniform3f(loc.col, c[0], c[1], c[2]);
    gl.drawArrays(gl.POINTS, 0, N);
  }

  function clearAll() { gl.viewport(0, 0, canvas.width, canvas.height); drawBg(1.0); }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    W = canvas.width; H = canvas.height; DPR = dpr;
    clearAll(); reseed();
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  function onMove(e) { const r = canvas.getBoundingClientRect(); mx = (e.clientX - r.left) / r.width * W; my = (e.clientY - r.top) / r.height * H; mActive = 1; }
  canvas.addEventListener('mousemove', onMove);

  let visible = true, running = true;
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) clearAll(); }, { threshold: 0.01 });
  io.observe(canvas);
  const onVis = () => { running = !document.hidden; };
  document.addEventListener('visibilitychange', onVis);

  let last = 0, raf = 0;
  function perf() { return last; }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = last ? Math.min(0.04, (now - last) / 1000) : 0.016; last = now;
    if (!running || !visible) return;
    step(dt); render();
  }
  raf = requestAnimationFrame(frame);

  return {
    setMode(m) { if (!MODES[m]) return; mode = m; clearAll(); reseed(); },
    setColors(c) { Object.assign(colors, c); },
    scrub() {},
    get mode() { return mode; },
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('mousemove', onMove);
      gl.deleteProgram(prog); gl.deleteProgram(quad); gl.deleteBuffer(bQuad); gl.deleteBuffer(bGpu);
    },
  };
}
