// MUEGGE "Creating Waves" — Partikel-Engine (raw WebGL, 0 Dependencies)
//
// Eine Engine, viele Zustaende. Public API:
//   const field = createWaveField(canvas, opts)
//   field.setMode(name)   // wave|grid|pulse|gem|reaktor|plasma|chain
//   field.setColors({...}); field.scrub(0..1); field.destroy()
//   opts.onChain = (pos) => {}   // pro Frame waehrend der Kette
//
// Portierbar: keine globalen Side-Effects -> wrappt sich 1:1 in React/Astro (MACH + Sanity).

const FIELD_ASPECT = 1.7;

const DEFAULT_COLORS = {
  bgTop: [0x0a/255, 0x1d/255, 0x37/255], // brand.deep
  bgBot: [0x0a/255, 0x15/255, 0x23/255], // brand.ink
  cyan:  [0x60/255, 0xc6/255, 0xf0/255], // brand.primary
  green: [0x61/255, 0xce/255, 0x70/255], // brand.accent
  hot:   [0xff/255, 0xbc/255, 0x7d/255], // transition
  white: [1, 1, 1],
};

const BASE = {
  waveAmp:0, waveFreq:5, waveSpeed:1.6, breathe:0, autoPulse:0, flowAmp:0,
  formGrid:0, formReaktor:0, formSphere:0, formGem:0,
  tilt:0, rotSpeed:0, pointSize:3.2, flat:0, glow:0,
};
const P = (o) => Object.assign({}, BASE, o);
const PRESETS = {
  // einheitliche Punktgroesse (3.6) ueber alle Modi -> konsistente Bildsprache
  wave:    P({ formGrid:1, waveAmp:0.34, breathe:0.15, tilt:0.55, pointSize:3.6 }),
  ring:    P({ formGrid:1, flowAmp:0.3, breathe:0.0, tilt:0.3, pointSize:3.6 }),  // antigravity: Cursor-Ring (perspektivisch)
  antigravity: P({ formGrid:1, flowAmp:0.0, breathe:0.0, tilt:0.0, pointSize:3.6 }),  // Dash-Partikel, wabernder Cursor-Ring
  grid:    P({ formGrid:1, waveAmp:0.10, breathe:1.0,  tilt:0.0,  flat:1, pointSize:3.6 }),
  magnet:  P({ formGrid:1, waveAmp:0.0,  breathe:0.25, tilt:0.0,  flat:1, pointSize:3.6 }),
  pulse:   P({ formGrid:1, waveAmp:0.10, breathe:0.3,  autoPulse:2.6, tilt:0.6, pointSize:3.6 }),
  gem:     P({ formGem:1,    rotSpeed:0.18, tilt:0.0, pointSize:3.6 }),
  reaktor: P({ formReaktor:1, rotSpeed:0.25, tilt:0.0, pointSize:3.6 }),
  plasma:  P({ formSphere:1,  rotSpeed:0.12, tilt:0.0, glow:1.0, pointSize:3.6 }),
};
const CHAIN_BASE = P({ formGrid:1, tilt:0.5, pointSize:3.6 });

// =============================================================================
//  Shader
// =============================================================================
const VERT = `
precision highp float;
attribute vec2  a_uv;
attribute vec3  a_diamond;   // Reaktor (kugeliges Kristallgitter)
attribute vec3  a_sphere;    // Plasma-Kugel
attribute vec3  a_gem;       // echter Diamant
attribute vec2  a_scatter;   // verstreute Partikel (antigravity / Ring 2)
attribute float a_rand;

uniform float u_time, u_dpr, u_scale, u_pointSize;
uniform float u_formGrid, u_formReaktor, u_formSphere, u_formGem;
uniform float u_waveAmp, u_waveFreq, u_waveSpeed, u_breathe, u_flat, u_glow, u_flowAmp;
uniform vec2  u_waveDir;
uniform float u_pulseT, u_pulseAmp;
uniform vec2  u_pulseCenter;
uniform vec2  u_mouse; uniform float u_mouseAmp;
uniform vec2  u_magCenter; uniform float u_magAmp;
uniform float u_tilt, u_rotY, u_spark;
uniform float u_chainMode, u_chainPos;   // 1 = Kette "Die Linie"
uniform float u_grow;                     // Diamant-Wachstum (0..1.1)
uniform vec2  u_ring; uniform float u_ringAmp;   // Cursor-Ring (antigravity)
uniform float u_scatterAmp;                       // verstreuter Antigravity-Modus (Ring 2)
uniform mat4  u_proj, u_view;

varying mediump float v_energy, v_rand, v_form, v_bright;

mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,s, 0.,1.,0., -s,0.,c); }

void main(){
  // ===== ANTIGRAVITY (Ring 2): wenige, grosse, verstreute Partikel, viel Leerraum, nah am Nutzer =====
  if (u_scatterAmp > 0.5) {
    if (a_rand > 0.06) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }  // duenn: ~6% sichtbar
    vec3 sp = vec3(a_scatter, 0.0);
    sp.xy += vec2(sin(u_time*0.3 + a_rand*60.0), cos(u_time*0.25 + a_rand*50.0)) * 0.03;          // sanfte Eigenbewegung
    vec2 dC = sp.xy - u_ring;
    float dist = length(dC);
    float infl = exp(-dist * dist * 1.6);                                                          // Cursor-Einflusszone
    sp.xy += normalize(dC + 0.0001) * infl * 0.13;                                                 // sanft wegdriften (antigravity)
    v_energy = 0.0; v_rand = a_rand; v_form = 0.0; v_bright = 0.55 + infl * 1.3;
    vec4 vp = u_view * vec4(sp, 1.0);
    gl_Position = u_proj * vp;
    gl_PointSize = (6.5 + infl * 5.0) * u_dpr * (2.6 / max(0.25, -vp.z));                          // grosse Partikel, nah
    return;
  }

  float energy = 0.0, sizeMod = 0.0, whiteLocal = 0.0, bright = 1.0;
  vec3 grid = vec3(a_uv, 0.0);

  if (u_chainMode > 0.5) {
    // ===== KETTE "Die Linie": ruhiges Substrat + EIN wandernder Puls =====
    // KETTE — EIN Komet, periodisch nahtlos (kein Cut, keine Ueberschneidung). Helligkeit traegt den Puls,
    // z bleibt klein (KEINE vertikalen Falten). Asym. Schweif + Speed-Streak = Richtung/Tempo.
    float nx = clamp(a_uv.x / 1.7 * 0.5 + 0.5, 0.0, 1.0);
    bright = 0.30;
    float d  = nx - u_chainPos;
    float dd = d - floor(d + 0.5);                          // periodisch [-0.5, 0.5] -> nahtloser Loop
    float sig = dd > 0.0 ? 0.05 : 0.16;                     // Komet: vorne scharf, hinten langer Schweif
    float bloom = exp(-pow(dd / sig, 2.0) * 0.5);
    float spark = a_rand * 0.09 * sin(u_time*20.0 + a_rand*30.0) * smoothstep(0.16, 0.0, nx);   // 1 Strom
    grid.z += (0.06 + spark) * bloom;                       // nur dezente Welle, KEINE Falte
    float guide = smoothstep(0.44,0.57,nx) * (1.0 - smoothstep(0.66,0.80,nx));                   // 3 Hohlleiter
    grid.z += sin(a_uv.x*13.0 - u_time*2.4) * 0.05 * guide * bloom;
    float pl = smoothstep(0.60,0.72,nx) * (1.0 - smoothstep(0.86,0.96,nx));                      // 4 Plasma
    bright += pl * bloom * 0.6;
    whiteLocal = smoothstep(0.86, 0.98, nx) * bloom;                                             // 5 Kristall
    bright += bloom * 1.7;
    sizeMod += bloom * 0.7;
    float streak = exp(-pow((dd + 0.12) / 0.10, 2.0) * 0.5) * smoothstep(0.0, -0.04, dd);        // Speed-Streak (relaxiert)
    grid.x += streak * 0.26;
    bright += streak * 0.4;
  } else {
    // ===== Normale Modi =====
    float ph = dot(a_uv, normalize(u_waveDir)) * u_waveFreq - u_time * u_waveSpeed;
    float w = sin(ph);
    grid.z  += w * u_waveAmp * (1.0 - u_flat);
    sizeMod += w * u_waveAmp * 2.5 * u_flat;
    energy  += smoothstep(0.45, 1.0, w) * step(0.02, u_waveAmp) * (1.0 - u_flat);

    float r = length(a_uv);
    float br = sin(r * 3.0 - u_time * 1.2) * u_breathe;
    grid.z  += br * 0.10 * (1.0 - u_flat);
    sizeMod += br * 0.8 * u_flat;
    bright  += (0.22 + abs(br) * 0.45) * u_flat;      // Grid praesent, aber im Helligkeits-Band

    // Float (antigravity): schwereloses, organisches Driften — sehr langsam & subtil
    if (u_flowAmp > 0.0) {
      float ft = u_time * 0.22;
      float n = sin(a_uv.x*0.8 + ft + a_rand*6.2831) + sin(a_uv.y*1.1 - ft*1.2) + sin((a_uv.x+a_uv.y)*0.6 + ft*0.7);
      grid.z += n * 0.09 * u_flowAmp;
      grid.x += sin(a_uv.y*0.9 + ft*0.7 + a_rand*6.2831) * 0.05 * u_flowAmp;
      grid.y += cos(a_uv.x*0.7 - ft*0.6 + a_rand*6.2831) * 0.05 * u_flowAmp;
      bright += (0.10 + 0.10 * sin(u_time*0.6 + a_rand*6.2831)) * u_flowAmp;
    }

    // Ring = integrierte Dots-Antigravity: wabernder Cursor-Ring auf dem Grid, aussen gedimmt (morpht mit allen)
    if (u_ringAmp > 0.0) {
      vec2 dr = a_uv - u_ring;
      float dist = length(dr);
      float ang = atan(dr.y, dr.x);
      float R = 0.50 + 0.07 * sin(ang * 5.0 + u_time * 2.2);   // wabernder Radius
      float ring = exp(-pow((dist - R) * 4.5, 2.0));
      float near = exp(-dist * dist * 1.6);
      grid.z  += ring * 0.15;
      grid.xy += normalize(dr + 0.0001) * ring * 0.06;
      bright = 0.18 + ring * 1.6 + near * 0.5;                 // aussen gedimmt, Ring hell
      sizeMod += ring * 1.0;
    }

    if (u_pulseT >= 0.0) {
      float pr = length(a_uv - u_pulseCenter);
      float rad = u_pulseT * 2.6;
      float ring = exp(-pow((pr - rad) * 3.5, 2.0));
      grid.z  += ring * u_pulseAmp * (1.0 - u_pulseT) * (1.0 - u_flat);
      sizeMod += ring * (1.0 - u_pulseT) * (0.6 + u_flat * 0.4);
      bright  += ring * (1.0 - u_pulseT) * 0.9;
    }
    if (u_mouseAmp > 0.001) {
      float mr = length(a_uv - u_mouse);
      float rip = sin(mr * 8.0 - u_time * 4.0) * exp(-mr * 2.2);
      grid.z  += rip * u_mouseAmp * (1.0 - u_flat);
      sizeMod += rip * u_mouseAmp * 5.0 * u_flat;
      bright  += max(0.0, rip) * u_mouseAmp * 7.0 * u_flat;   // Maus im Grid sichtbar, im Band
    }
    grid.z += a_rand * u_spark * sin(u_time * 18.0 + a_rand * 30.0);
  }

  // Magnet: schiebt Atome radial vom Zentrum weg (folgt Maus / kreist)
  if (u_magAmp > 0.001) {
    vec2 dir = a_uv - u_magCenter;
    float dd = length(dir);
    float push = u_magAmp * exp(-dd * dd * 1.2);
    grid.xy += normalize(dir + 0.0001) * push;
    bright  += push * 1.3;
    sizeMod += push * 2.0;
  }

  // Plasma: gleiche Dot-Optik wie der Rest (keine Groessen-Aenderung) — die Wolke "atmet" Helligkeit + leises Shimmer.
  // Maus = Mikrowellen-Energie-Einkopplung: Bewegung pumpt Leistung -> Plasma agitierter/heller (fachlich korrekt).
  float breath = 0.25 + 0.20 * sin(u_time * 1.5);
  float shimmer = 0.12 * sin(u_time * 5.0 + a_rand * 40.0);
  bright += u_glow * (breath + shimmer) * (1.0 + u_mouseAmp * 6.0);

  grid = rotX(u_tilt) * grid;

  mat3 obj = rotX(0.28) * rotY(u_rotY);
  vec3 dia = obj * a_diamond;
  vec3 sph = obj * (a_sphere * (1.0 + 0.04 * sin(u_time * 1.6 + a_rand * 20.0)));  // dezente Turbulenz

  // Diamant-WACHSTUM (CVD): Atome stroemen von aussen rein, wachsen vom Zentrum nach aussen an
  float tr = length(a_gem);                                       // Ziel-Radius (0 = innen, 1 = aussen)
  float lockf = smoothstep(u_grow + 0.06, u_grow - 0.06, tr);     // 1 = bereits angewachsen (Kristall)
  float surf = smoothstep(0.55, 1.0, abs(a_gem.x) + abs(a_gem.y) + abs(a_gem.z)); // Oktaeder-Oberflaeche -> Schaerfe
  vec3 gasPos = a_gem * (1.8 + 0.6 * sin(u_time * 0.6 + a_rand * 25.0))
              + vec3(sin(u_time*0.9 + a_rand*40.0), cos(u_time*1.1 + a_rand*30.0), sin(u_time*0.7 + a_rand*20.0)) * 0.2;
  vec3 gem = obj * (mix(gasPos, a_gem, lockf) * 1.15);
  float gemLock = u_formGem * lockf * (0.4 + 0.6 * surf);          // Oberflaeche eisiger
  bright += u_formGem * (lockf * (surf * 0.8 - (1.0 - surf) * 0.35) - (1.0 - lockf) * 0.4); // Facetten scharf, Inneres/Gas gedimmt

  vec3 pos = grid * u_formGrid + dia * u_formReaktor + sph * u_formSphere + gem * u_formGem;
  pos *= u_scale;

  v_energy = clamp(energy, 0.0, 1.0);
  v_rand   = a_rand;
  v_form   = clamp(u_formReaktor + gemLock + whiteLocal, 0.0, 1.0);  // nur angewachsene Atome = eisiger Kristall
  v_bright = bright;

  // luftiger machen: Plasma + Diamant-Inneres ausduennen -> gleiche Dichte-Anmutung wie die Felder
  float vis = 1.0;
  if (u_formSphere > 0.5 && a_rand > 0.5) vis = 0.0;                 // Plasma ~50% ausgeduennt
  if (u_formGem > 0.5 && surf < 0.45 && a_rand > 0.3) vis = 0.0;     // Diamant: Inneres weg, Oberflaeche bleibt

  vec4 viewPos = u_view * vec4(pos, 1.0);
  gl_Position  = u_proj * viewPos;
  gl_PointSize = vis * u_pointSize * u_dpr * (2.6 / max(0.25, -viewPos.z)) * (1.0 + max(0.0, sizeMod));
}`;

const FRAG = `
precision highp float;
varying mediump float v_energy, v_rand, v_form, v_bright;
uniform float u_time;
uniform vec3  u_cyan, u_green, u_hot, u_white;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, d), 1.6);

  vec3 col = mix(u_cyan, u_white, v_form * 0.55);              // Basis durchgehend cyan, Kristall = eisig
  col *= max(0.0, v_bright);                                   // Helligkeit haelt den Farbton (Glow/Puls)
  col *= 0.85 + 0.15 * sin(u_time * 2.0 + v_rand * 6.2831);    // Twinkle

  gl_FragColor = vec4(col, a);   // additiv (SRC_ALPHA, ONE)
}`;

const BG_VERT = `attribute vec2 p; varying mediump vec2 v; void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;
const BG_FRAG = `precision mediump float; varying mediump vec2 v; uniform vec3 u_top,u_bot;
  void main(){ float t = smoothstep(0.0,1.0,1.0-v.y); gl_FragColor = vec4(mix(u_bot,u_top,t),1.0); }`;

// ---- Dash-Partikel (Antigravity / Ring 2): orientierte Striche im Flow-Feld + Cursor-Wirbel ----
const DASH_VERT = `
precision highp float;
attribute vec2 a_base; attribute float a_side; attribute float a_rand;
uniform float u_time, u_dpr; uniform vec2 u_ring; uniform mat4 u_proj, u_view;
varying float v_b, v_r;
void main(){
  vec2 pos = a_base;
  pos += vec2(sin(u_time*0.25 + a_rand*60.0), cos(u_time*0.22 + a_rand*50.0)) * 0.05;     // sanfte Drift
  vec2 dC = pos - u_ring; float dist = length(dC); float ang = atan(dC.y, dC.x);
  float R = 0.42 + 0.07 * sin(ang * 5.0 + u_time * 2.2);                                   // WABERNDER Ring
  float ringBand = exp(-pow((dist - R) * 4.5, 2.0));                                       // Aktivierung am Ring
  float near = exp(-dist * dist * 1.6);                                                    // generelle Naehe
  float fa = sin(a_base.x*0.7 + a_base.y*0.9 + u_time*0.25 + a_rand*6.2831) * 3.1416;      // Flow-Feld
  vec2 dir = normalize(mix(vec2(cos(fa), sin(fa)), normalize(vec2(-dC.y, dC.x)+0.0001), clamp(ringBand+near,0.0,1.0)));
  pos += normalize(dC + 0.0001) * (ringBand * 0.12 + near * 0.10);                         // wegdriften (antigravity)
  float len = 0.05 + ringBand * 0.06;
  vec2 p = pos + dir * a_side * len;
  v_b = 0.10 + ringBand * 1.4 + near * 0.5;                                                // aussen fast dunkel, am Ring hell
  v_r = a_rand;
  gl_Position = u_proj * (u_view * vec4(p, 0.0, 1.0));
}`;
const DASH_FRAG = `
precision mediump float; varying float v_b, v_r;
uniform vec3 u_cyan, u_green;
void main(){ vec3 col = mix(u_cyan, u_green, step(0.78, v_r) * 0.5); gl_FragColor = vec4(col * v_b, 1.0); }`;

// =============================================================================
//  Helfer
// =============================================================================
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s) + '\n' + src);
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
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
function translateZ(d) { return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,d,1]); }
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGrid(n, cols, rows) {
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    uv[i*2]   = (col / (cols - 1) * 2 - 1) * FIELD_ASPECT;
    uv[i*2+1] = (row / (rows - 1) * 2 - 1);
  }
  return uv;
}
function buildDiamond(n) {  // Reaktor
  const basis = [[0,0,0],[0,.5,.5],[.5,0,.5],[.5,.5,0],[.25,.25,.25],[.75,.75,.25],[.75,.25,.75],[.25,.75,.75]];
  const cells = 12, atoms = [], half = cells / 2;
  for (let x=0;x<cells;x++) for (let y=0;y<cells;y++) for (let z=0;z<cells;z++)
    for (const b of basis) atoms.push([x+b[0]-half, y+b[1]-half, z+b[2]-half]);
  atoms.sort((a,b)=>(a[0]*a[0]+a[1]*a[1]+a[2]*a[2])-(b[0]*b[0]+b[1]*b[1]+b[2]*b[2]));
  const out = new Float32Array(n*3);
  let maxR = 0;
  for (let i=0;i<n;i++){ const a=atoms[i]; maxR=Math.max(maxR, Math.hypot(a[0],a[1],a[2])); }
  const s = 1.1 / (maxR || 1);
  for (let i=0;i<n;i++){ const a=atoms[i]; out[i*3]=a[0]*s; out[i*3+1]=a[1]*s; out[i*3+2]=a[2]*s; }
  return out;
}
function buildSphere(n) {  // Plasma-Kugel
  const out = new Float32Array(n*3), gold = Math.PI * (3 - Math.sqrt(5));
  for (let i=0;i<n;i++){
    const y = 1 - (i/(n-1))*2, r = Math.sqrt(Math.max(0,1-y*y)), th = gold*i;
    out[i*3]=Math.cos(th)*r; out[i*3+1]=y; out[i*3+2]=Math.sin(th)*r;
  }
  return out;
}
function buildScatter(n) {  // verstreute Partikel-Positionen (Antigravity / Ring 2)
  const rg = mulberry32(404), out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { out[i*2] = (rg()*2-1) * 1.9; out[i*2+1] = (rg()*2-1) * 1.15; }
  return out;
}
function buildGem(n) {  // SOLIDER Oktaeder (Diamant-Habit, Volumen) — fuer das Schicht-Wachstum
  const rg = mulberry32(7);
  const out = new Float32Array(n * 3);
  // nach Ziel-Radius sortieren waere ideal; Rejection-Sampling reicht (Wachstum nutzt length() im Shader)
  let i = 0, guard = 0;
  while (i < n && guard < n * 300) {
    guard++;
    const x = rg()*2-1, y = rg()*2-1, z = rg()*2-1;
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) > 1) continue;  // innerhalb Oktaeder
    out[i*3] = x; out[i*3+1] = y; out[i*3+2] = z; i++;
  }
  return out;
}

// =============================================================================
//  Engine
// =============================================================================
export function createWaveField(canvas, opts = {}) {
  const colors = Object.assign({}, DEFAULT_COLORS, opts.colors);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dprCap = opts.dprCap || 2;
  const onChain = opts.onChain || null;

  const gl = canvas.getContext('webgl', { antialias:true, alpha:false, premultipliedAlpha:false })
          || canvas.getContext('experimental-webgl');
  if (!gl) { drawPosterFallback(canvas, colors); return { setMode(){}, setColors(){}, scrub(){}, destroy(){} }; }

  const density = opts.density || 1.0;
  const cols = Math.round(120 * density), rows = Math.round(cols / FIELD_ASPECT);
  const N = cols * rows;

  const rnd = mulberry32(1337);
  const uv = buildGrid(N, cols, rows);
  const dia = buildDiamond(N);
  const sph = buildSphere(N);
  const gem = buildGem(N);
  const scatter = buildScatter(N);
  const rand = new Float32Array(N);
  for (let i=0;i<N;i++) rand[i] = rnd();

  const prog = program(gl, VERT, FRAG);
  const bg = program(gl, BG_VERT, BG_FRAG);

  const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const bUv = buf(uv), bDia = buf(dia), bSph = buf(sph), bGem = buf(gem), bScatter = buf(scatter), bRand = buf(rand);
  const bQuad = buf(new Float32Array([-1,-1, 3,-1, -1,3]));

  const A = (n) => gl.getAttribLocation(prog, n);
  const U = (n) => gl.getUniformLocation(prog, n);
  const loc = {
    a_uv:A('a_uv'), a_diamond:A('a_diamond'), a_sphere:A('a_sphere'), a_gem:A('a_gem'), a_scatter:A('a_scatter'), a_rand:A('a_rand'),
    time:U('u_time'), dpr:U('u_dpr'), scale:U('u_scale'), pointSize:U('u_pointSize'),
    formGrid:U('u_formGrid'), formReaktor:U('u_formReaktor'), formSphere:U('u_formSphere'), formGem:U('u_formGem'),
    waveAmp:U('u_waveAmp'), waveFreq:U('u_waveFreq'), waveSpeed:U('u_waveSpeed'),
    breathe:U('u_breathe'), flat:U('u_flat'), glow:U('u_glow'), flowAmp:U('u_flowAmp'), waveDir:U('u_waveDir'),
    ring:U('u_ring'), ringAmp:U('u_ringAmp'), scatterAmp:U('u_scatterAmp'),
    pulseT:U('u_pulseT'), pulseAmp:U('u_pulseAmp'), pulseCenter:U('u_pulseCenter'),
    mouse:U('u_mouse'), mouseAmp:U('u_mouseAmp'),
    magCenter:U('u_magCenter'), magAmp:U('u_magAmp'),
    tilt:U('u_tilt'), rotY:U('u_rotY'), spark:U('u_spark'),
    chainMode:U('u_chainMode'), chainPos:U('u_chainPos'), grow:U('u_grow'),
    proj:U('u_proj'), view:U('u_view'),
    cyan:U('u_cyan'), green:U('u_green'), hot:U('u_hot'), white:U('u_white'),
  };
  const bgLoc = { p:gl.getAttribLocation(bg,'p'), top:gl.getUniformLocation(bg,'u_top'), bot:gl.getUniformLocation(bg,'u_bot') };

  // Dash-Geometrie (Ring 2): M Striche, je 2 Vertices
  const M = 600;
  const dBase = new Float32Array(M*2*2), dSide = new Float32Array(M*2), dRand = new Float32Array(M*2);
  const rgd = mulberry32(404);
  for (let i = 0; i < M; i++) {
    const x = (rgd()*2-1)*2.4, y = (rgd()*2-1)*1.4, rr = rgd();
    for (let e = 0; e < 2; e++) { const k = i*2+e; dBase[k*2]=x; dBase[k*2+1]=y; dSide[k]=e?0.5:-0.5; dRand[k]=rr; }
  }
  const bDBase = buf(dBase), bDSide = buf(dSide), bDRand = buf(dRand);
  const dashProg = program(gl, DASH_VERT, DASH_FRAG);
  const dloc = {
    base:gl.getAttribLocation(dashProg,'a_base'), side:gl.getAttribLocation(dashProg,'a_side'), rand:gl.getAttribLocation(dashProg,'a_rand'),
    time:gl.getUniformLocation(dashProg,'u_time'), dpr:gl.getUniformLocation(dashProg,'u_dpr'), ring:gl.getUniformLocation(dashProg,'u_ring'),
    proj:gl.getUniformLocation(dashProg,'u_proj'), view:gl.getUniformLocation(dashProg,'u_view'),
    cyan:gl.getUniformLocation(dashProg,'u_cyan'), green:gl.getUniformLocation(dashProg,'u_green'),
  };

  const cur = Object.assign({}, PRESETS.wave);
  const tgt = Object.assign({}, PRESETS.wave);
  let modeName = 'wave';
  let chainOn = false, chainP = 0, chainAuto = false;
  let magnetOn = false, magCenter = [0, 0];
  let ringOn = false, ringPos = [0, 0], scatterOn = false;
  let growT = 0, growVal = 1.12;
  let mouse = [0,0], mouseAmp = 0;
  let pulseStart = -10, lastPulse = 0;
  let proj = new Float32Array(16);
  const view = translateZ(-3.4);
  let rotY = 0, spark = 0;

  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const setTargets = (o) => { for (const k in o) tgt[k] = o[k]; };

  function setMode(name) {
    chainAuto = false; chainOn = false; magnetOn = false; ringOn = false; scatterOn = false;
    if (name === 'chain') { chainOn = true; chainAuto = true; chainP = 0; modeName = name; setTargets(CHAIN_BASE); return; }
    if (!PRESETS[name]) return;
    if (name === 'magnet') magnetOn = true;
    if (name === 'ring') ringOn = true;
    if (name === 'antigravity') { ringOn = true; scatterOn = true; }   // Dash-Partikel + wabernder Cursor-Ring
    if (name === 'gem') growT = 0;   // Wachstum von vorne starten
    modeName = name; setTargets(PRESETS[name]);
  }
  function setColors(c) { Object.assign(colors, c); }
  function scrub(p) { chainAuto = false; chainP = clamp(p, 0, 1); }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    proj = perspective(45 * Math.PI / 180, canvas.width / canvas.height, 0.1, 100);
    fieldScale = Math.min(1, (canvas.width / canvas.height) / 1.9) * 0.62 + 0.30;
    DPR = dpr;
  }
  let DPR = 1, fieldScale = 0.62;
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) / r.width, my = (e.clientY - r.top) / r.height;
    mouse = [(mx*2-1)*FIELD_ASPECT, -(my*2-1)]; mouseAmp = 0.22;
  }
  function onClick() { pulseStart = T; }
  if (matchMedia('(pointer:fine)').matches && !reduced) {
    canvas.addEventListener('mousemove', onMove); canvas.addEventListener('click', onClick);
  }

  let visible = true, running = true;
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; }, { threshold: 0.01 });
  io.observe(canvas);
  const onVis = () => { running = !document.hidden; };
  document.addEventListener('visibilitychange', onVis);

  let T = 0, last = performance.now(), raf = 0;
  const lerp = (a,b,t) => a + (b - a) * t;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!running || !visible) return;
    T += dt;

    if (chainAuto) chainP = (chainP + dt / 11) % 1;   // nahtlos: Puls wrappt periodisch
    if (chainOn && onChain) onChain(chainP);

    const k = 1 - Math.pow(0.001, dt);
    for (const key in tgt) if (typeof tgt[key] === 'number') cur[key] = lerp(cur[key] ?? tgt[key], tgt[key], k);
    rotY += (cur.rotSpeed || 0) * dt;
    mouseAmp = lerp(mouseAmp, 0, dt * 2.0);
    spark = lerp(spark, 0, dt * 3);
    if (magnetOn) magCenter = mouseAmp > 0.02 ? mouse : [Math.cos(T * 0.5) * 0.95, Math.sin(T * 0.7) * 0.5];
    if (modeName === 'gem') { growT += dt; const c = growT % 9; growVal = c < 7 ? (c / 7) * 1.12 : 1.12; } // wachsen (7s) + halten (2s)
    else growVal = 1.12;
    if (ringOn) { const f = Math.min(1, dt * 2.5); ringPos[0] += (mouse[0] - ringPos[0]) * f; ringPos[1] += (mouse[1] - ringPos[1]) * f; } // smooth verzoegert

    if ((cur.autoPulse || 0) > 0.05 && T - lastPulse > cur.autoPulse) { pulseStart = T; lastPulse = T; }
    let pulseT = -1;
    if (pulseStart >= 0) { const pd = (T - pulseStart) / 1.6; pulseT = pd <= 1 ? pd : -1; }

    render(pulseT);
  }

  function render(pulseT) {
    gl.disable(gl.BLEND);
    gl.useProgram(bg);
    gl.bindBuffer(gl.ARRAY_BUFFER, bQuad);
    gl.enableVertexAttribArray(bgLoc.p); gl.vertexAttribPointer(bgLoc.p, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(bgLoc.top, colors.bgTop); gl.uniform3fv(bgLoc.bot, colors.bgBot);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    if (scatterOn) {  // Ring 2 = Dash-Partikel (Linien) statt Punkte
      gl.useProgram(dashProg);
      bindAttr(dloc.base, bDBase, 2); bindAttr(dloc.side, bDSide, 1); bindAttr(dloc.rand, bDRand, 1);
      gl.uniform1f(dloc.time, T); gl.uniform1f(dloc.dpr, DPR); gl.uniform2f(dloc.ring, ringPos[0], ringPos[1]);
      gl.uniformMatrix4fv(dloc.proj, false, proj); gl.uniformMatrix4fv(dloc.view, false, view);
      gl.uniform3fv(dloc.cyan, colors.cyan); gl.uniform3fv(dloc.green, colors.green);
      gl.drawArrays(gl.LINES, 0, M * 2);
      return;
    }

    gl.useProgram(prog);
    bindAttr(loc.a_uv, bUv, 2); bindAttr(loc.a_diamond, bDia, 3); bindAttr(loc.a_sphere, bSph, 3);
    bindAttr(loc.a_gem, bGem, 3); bindAttr(loc.a_scatter, bScatter, 2); bindAttr(loc.a_rand, bRand, 1);

    gl.uniform1f(loc.time, T); gl.uniform1f(loc.dpr, DPR); gl.uniform1f(loc.scale, fieldScale);
    gl.uniform1f(loc.pointSize, cur.pointSize);
    gl.uniform1f(loc.formGrid, cur.formGrid); gl.uniform1f(loc.formReaktor, cur.formReaktor);
    gl.uniform1f(loc.formSphere, cur.formSphere); gl.uniform1f(loc.formGem, cur.formGem);
    gl.uniform1f(loc.waveAmp, cur.waveAmp); gl.uniform1f(loc.waveFreq, cur.waveFreq); gl.uniform1f(loc.waveSpeed, cur.waveSpeed);
    gl.uniform1f(loc.breathe, cur.breathe); gl.uniform1f(loc.flat, cur.flat); gl.uniform1f(loc.glow, cur.glow);
    gl.uniform1f(loc.flowAmp, cur.flowAmp);
    gl.uniform2f(loc.waveDir, 1.0, 0.18);
    gl.uniform1f(loc.pulseT, pulseT); gl.uniform1f(loc.pulseAmp, 0.5); gl.uniform2f(loc.pulseCenter, 0, 0);
    gl.uniform2f(loc.mouse, mouse[0], mouse[1]); gl.uniform1f(loc.mouseAmp, mouseAmp);
    gl.uniform2f(loc.magCenter, magCenter[0], magCenter[1]); gl.uniform1f(loc.magAmp, magnetOn ? 0.6 : 0);
    gl.uniform2f(loc.ring, ringPos[0], ringPos[1]); gl.uniform1f(loc.ringAmp, ringOn ? 1 : 0);
    gl.uniform1f(loc.scatterAmp, scatterOn ? 1 : 0);
    gl.uniform1f(loc.tilt, cur.tilt); gl.uniform1f(loc.rotY, rotY); gl.uniform1f(loc.spark, spark);
    gl.uniform1f(loc.chainMode, chainOn ? 1 : 0); gl.uniform1f(loc.chainPos, chainP); gl.uniform1f(loc.grow, growVal);
    gl.uniformMatrix4fv(loc.proj, false, proj); gl.uniformMatrix4fv(loc.view, false, view);
    gl.uniform3fv(loc.cyan, colors.cyan); gl.uniform3fv(loc.green, colors.green);
    gl.uniform3fv(loc.hot, colors.hot); gl.uniform3fv(loc.white, colors.white);

    gl.drawArrays(gl.POINTS, 0, N);
  }
  function bindAttr(l, b, size) { if (l < 0) return; gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); }

  if (reduced) render(-1);
  else raf = requestAnimationFrame(frame);

  return {
    setMode, setColors, scrub,
    get mode() { return modeName; },
    get chainPos() { return chainP; },
    destroy() {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('mousemove', onMove); canvas.removeEventListener('click', onClick);
      [bUv, bDia, bSph, bGem, bScatter, bRand, bQuad, bDBase, bDSide, bDRand].forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(prog); gl.deleteProgram(bg); gl.deleteProgram(dashProg);
    },
  };
}

function drawPosterFallback(canvas, c) {
  const hex = (a) => '#' + a.map((v) => ('0' + Math.round(v*255).toString(16)).slice(-2)).join('');
  canvas.style.background = `linear-gradient(180deg, ${hex(c.bgTop)}, ${hex(c.bgBot)})`;
}
