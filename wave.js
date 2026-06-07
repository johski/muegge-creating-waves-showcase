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
  ring:    P({ formGrid:1, flowAmp:0.3, breathe:0.0, tilt:0.3, pointSize:3.6 }),  // Cursor-Ring auf dem Grid (morpht)
  agdots:  P({ formGrid:1, flowAmp:0.0, breathe:0.0, tilt:0.0, pointSize:3.6 }),  // AG mit Dots (sparse, Cursor-Ring)
  antigravity: P({ formGrid:1, flowAmp:0.0, breathe:0.0, tilt:0.0, pointSize:3.6 }),  // AG mit Dashes (Google-nah)
  grid:    P({ formGrid:1, waveAmp:0.10, breathe:1.0,  tilt:0.0,  flat:1, pointSize:3.6 }),
  magnet:  P({ formGrid:1, waveAmp:0.0,  breathe:0.25, tilt:0.0,  flat:1, pointSize:3.6 }),
  pulse:   P({ formGrid:1, waveAmp:0.10, breathe:0.3,  autoPulse:2.6, tilt:0.6, pointSize:3.6 }),
  gem:     P({ formGem:1,    rotSpeed:0.18, tilt:0.0, pointSize:3.6 }),
  reaktor: P({ formReaktor:1, rotSpeed:0.25, tilt:0.0, pointSize:3.6 }),
  plasma:  P({ formSphere:1,  rotSpeed:0.12, tilt:0.0, glow:1.0, pointSize:3.6 }),
  // Step-2-Konzepte (Logik im Shader-Concept-Branch)
  molecule:  P({ pointSize:3.6 }),
  wafer:     P({ pointSize:3.6 }),
  interfere: P({ pointSize:3.6 }),
  beam:      P({ pointSize:3.6 }),
  ignite:    P({ pointSize:3.6 }),
  globe:     P({ pointSize:3.4 }),
  swarm:     P({ pointSize:3.2 }),
  blob:      P({ pointSize:3.4 }),
  distort:   P({ pointSize:3.4 }),
  strudel:   P({ pointSize:3.6 }),
  blackhole: P({ pointSize:3.6 }),
};
const CONCEPTS = { molecule:1, wafer:2, interfere:3, beam:4, ignite:5, globe:6, swarm:7, blob:8, distort:9, strudel:10, blackhole:11 };
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
attribute vec2  a_word;      // Ziel-Positionen MUEGGE-Wortmarke (Schwarm)
attribute float a_rand;

uniform float u_time, u_dpr, u_scale, u_pointSize;
uniform float u_formGrid, u_formReaktor, u_formSphere, u_formGem;
uniform float u_waveAmp, u_waveFreq, u_waveSpeed, u_breathe, u_flat, u_glow, u_flowAmp;
uniform vec2  u_waveDir;
uniform float u_pulseT, u_pulseAmp;
uniform vec2  u_pulseCenter;
uniform vec2  u_mouse; uniform float u_mouseAmp;
uniform vec2  u_mouseNDC;                          // Cursor in NDC (Plasma-Hotspot)
uniform vec2  u_magCenter; uniform float u_magAmp;
uniform float u_tilt, u_rotY, u_spark;
uniform float u_chainMode, u_chainPos, u_chainStyle;   // chainMode=an, Style 0=Streifen / 1=Signal-Blob
uniform float u_grow;                     // Diamant-Wachstum (0..1.1)
uniform vec2  u_ring; uniform float u_ringAmp;   // Cursor-Ring (antigravity)
uniform float u_scatterAmp;                       // verstreuter Antigravity-Modus (Ring 2)
uniform float u_concept;                          // Step-2-Konzepte: 1..9
uniform float u_distortStr, u_twist;              // Distort (dimorph): cursorX->Staerke, cursorY->Twist (eased)
uniform float u_clickAge;                          // Sekunden seit Globus-Klick
uniform vec2  u_clickNDC;                          // Klick-Position (NDC) fuer Globus-Ripple
uniform float u_distTime;                          // Distort: Noise-Zeit, advanced NUR bei Mausbewegung
uniform float u_vortex;                            // Strudel: 0 statisch -> 1 Wirbel (bei Mausbewegung)
uniform mat4  u_proj, u_view;

varying mediump float v_energy, v_rand, v_form, v_bright;

mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0., 0.,c,-s, 0.,s,c); }
mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,s, 0.,1.,0., -s,0.,c); }

// --- Classic Perlin Noise (Gustavson/Ashima) fuer natuerliche Verzerrung (wie Dimorphs cnoise) ---
vec3 mod289v3(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 mod289v4(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec4 permute(vec4 x){ return mod289v4(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
vec3 fade(vec3 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
float cnoise(vec3 P){
  vec3 Pi0 = floor(P); vec3 Pi1 = Pi0 + vec3(1.0);
  Pi0 = mod289v3(Pi0); Pi1 = mod289v3(Pi1);
  vec3 Pf0 = fract(P); vec3 Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz; vec4 iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0); vec4 ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 * (1.0/7.0); vec4 gy0 = fract(floor(gx0)*(1.0/7.0)) - 0.5; gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0); vec4 sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0*(step(0.0,gx0)-0.5); gy0 -= sz0*(step(0.0,gy0)-0.5);
  vec4 gx1 = ixy1 * (1.0/7.0); vec4 gy1 = fract(floor(gx1)*(1.0/7.0)) - 0.5; gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1); vec4 sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1*(step(0.0,gx1)-0.5); gy1 -= sz1*(step(0.0,gy1)-0.5);
  vec3 g000=vec3(gx0.x,gy0.x,gz0.x); vec3 g100=vec3(gx0.y,gy0.y,gz0.y);
  vec3 g010=vec3(gx0.z,gy0.z,gz0.z); vec3 g110=vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001=vec3(gx1.x,gy1.x,gz1.x); vec3 g101=vec3(gx1.y,gy1.y,gz1.y);
  vec3 g011=vec3(gx1.z,gy1.z,gz1.z); vec3 g111=vec3(gx1.w,gy1.w,gz1.w);
  vec4 norm0 = taylorInvSqrt(vec4(dot(g000,g000),dot(g010,g010),dot(g100,g100),dot(g110,g110)));
  g000*=norm0.x; g010*=norm0.y; g100*=norm0.z; g110*=norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001,g001),dot(g011,g011),dot(g101,g101),dot(g111,g111)));
  g001*=norm1.x; g011*=norm1.y; g101*=norm1.z; g111*=norm1.w;
  float n000=dot(g000,Pf0);
  float n100=dot(g100,vec3(Pf1.x,Pf0.yz));
  float n010=dot(g010,vec3(Pf0.x,Pf1.y,Pf0.z));
  float n110=dot(g110,vec3(Pf1.xy,Pf0.z));
  float n001=dot(g001,vec3(Pf0.xy,Pf1.z));
  float n101=dot(g101,vec3(Pf1.x,Pf0.y,Pf1.z));
  float n011=dot(g011,vec3(Pf0.x,Pf1.yz));
  float n111=dot(g111,Pf1);
  vec3 fxyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000,n100,n010,n110), vec4(n001,n101,n011,n111), fxyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fxyz.y);
  return 2.2 * mix(n_yz.x, n_yz.y, fxyz.x);
}

void main(){
  // ===== AG DOTS: wenige, grosse, verstreute Punkte; aussen leer, am Cursor wabernder Ring (antigravity mit Dots) =====
  if (u_scatterAmp > 0.5) {
    if (a_rand > 0.08) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }  // duenn: ~8% sichtbar
    vec3 sp = vec3(a_scatter, 0.0);
    sp.xy += vec2(sin(u_time*0.3 + a_rand*60.0), cos(u_time*0.25 + a_rand*50.0)) * 0.04;          // sanfte Drift
    vec2 dC = sp.xy - u_ring; float dist = length(dC); float ang = atan(dC.y, dC.x);
    float R = 0.42 + 0.07 * sin(ang * 5.0 + u_time * 2.2);                                         // WABERNDER Ring
    float ringBand = exp(-pow((dist - R) * 4.5, 2.0));
    float near = exp(-dist * dist * 1.6);
    sp.xy += normalize(dC + 0.0001) * (ringBand * 0.12 + near * 0.10);                             // wegdriften (antigravity)
    v_energy = 0.0; v_rand = a_rand; v_form = 0.0;
    v_bright = 0.12 + ringBand * 1.4 + near * 0.5;                                                 // aussen fast leer, am Ring hell
    vec4 vp = u_view * vec4(sp, 1.0);
    gl_Position = u_proj * vp;
    gl_PointSize = (5.5 + ringBand * 4.0) * u_dpr * (2.6 / max(0.25, -vp.z));                      // grosse Punkte
    return;
  }

  // ===== KONZEPTE (Step 2): 1 Molekuel · 2 Wafer · 3 Interferenz · 4 Beam · 5 Zuendung · 6 Globus · 7 Schwarm =====
  if (u_concept > 0.5) {
    vec3 p = vec3(a_uv, 0.0);
    float b = 0.7, sm = 0.0, en = 0.0, wl = 0.0, tiltC = 0.5;
    vec2 mr = u_ring;                                                    // gelagerte Cursor-Position (Feldkoords)

    if (u_concept < 1.5) {                                              // 1 MOLEKUEL-SPALTUNG (Power-to-X)
      vec2 dir2 = vec2(cos(a_rand*6.2831), sin(a_rand*6.2831));
      float split = 0.5 + 0.5 * sin(u_time*1.3 + a_rand*30.0);          // pro-Dot (KEIN Banding/keine Flaechen)
      float cur = exp(-dot(a_uv-mr, a_uv-mr) * 2.5);                    // Cursor spaltet lokal
      split = clamp(split*0.35 + cur, 0.0, 1.0);
      p.xy += (vec2(a_rand, fract(a_rand*7.3)) - 0.5) * 0.05;          // leichte Grund-Unordnung (Molekuel-Wolke)
      p.xy += dir2 * split * 0.13;                                      // spaltet auseinander
      b = 0.55 + split*0.7; sm = split*0.4;
    } else if (u_concept < 2.5) {                                      // 2 WAFER-REINIGUNG (Downstream-Plasma)
      tiltC = 1.15;
      float nx = a_uv.x/1.7*0.5 + 0.5;
      float sweep = fract(u_time*0.10);
      float since = fract(sweep - nx);                                  // 0 = gerade gereinigt -> 1 wieder verschmutzt (nahtlos)
      float cur = exp(-dot(a_uv-mr, a_uv-mr) * 3.0);
      float dirt = step(0.5, a_rand) * smoothstep(0.05, 0.7, since) * (1.0 - cur);
      p.z += dirt * 0.18 + dirt * sin(u_time*7.0 + a_rand*40.0) * 0.03;
      b = mix(1.0, 0.20, dirt); sm = (1.0 - dirt) * step(0.5, a_rand) * 0.3;
    } else if (u_concept < 3.5) {                                      // 3 STEHENDE WELLE / INTERFERENZ
      tiltC = 0.55;
      float d1 = length(a_uv - vec2(-0.7, 0.0));
      float d2 = length(a_uv - mr);
      float wv = sin(d1*8.0 - u_time*2.0) + sin(d2*8.0 - u_time*2.0);
      p.z += wv * 0.12; b = 0.55 + abs(wv)*0.45; sm = abs(wv)*0.25;
    } else if (u_concept < 4.5) {                                      // 4 ANTENNEN-ARRAY / BEAMFORMING
      tiltC = 0.5;
      vec2 bd = normalize(mr + vec2(0.0001, 0.0001));
      float al = dot(normalize(a_uv + vec2(0.0001)), bd);
      float lobe = pow(max(0.0, al), 6.0);
      float along = dot(a_uv, bd);
      float puls = exp(-pow(along - fract(u_time*0.5)*3.0, 2.0) * 3.0);
      b = 0.26 + lobe*(1.2 + puls*1.6); sm = lobe*0.6;
    } else if (u_concept < 5.5) {                                      // 5 ZUENDUNG: ruhige Gas-Wolke -> BLITZ: Partikel werden ionisiert (Turbulenz+Expansion) -> Abklingen
      float t = fract(u_time * 0.14);                                  // ~7s Zyklus
      float flash = exp(-pow((t - 0.16) / 0.02, 2.0) * 0.5);          // scharfe Zuendung
      float glow  = smoothstep(0.16, 0.26, t) * (1.0 - smoothstep(0.55, 0.82, t));  // Plasma-Phase
      float energy = clamp(flash + glow, 0.0, 1.0);                    // 0 = kalt/still, 1 = angeregt
      vec3 dir = normalize(a_sphere);
      float turb = cnoise(dir * 5.0 + vec3(u_time * 2.0)) * 0.20 * energy;          // Partikel werden turbulent
      float shimmer = sin(u_time * 30.0 + a_rand * 40.0) * 0.06 * energy;           // Ionisierungs-Zittern
      float r = 0.90 + 0.16 * energy + turb + shimmer;                // Expansion + Turbulenz bei Zuendung
      p = rotX(0.2) * (rotY(u_time * 0.05) * (dir * r));
      b = 0.05 + flash * 4.0 + glow * 1.1 * (0.8 + 0.2 * sin(u_time * 4.0));        // dunkel -> Blitz -> pulsierendes Glow
      sm = flash * 1.0 + glow * 0.4 + energy * 0.2;
      tiltC = 0.0;
    } else if (u_concept < 6.5) {                                      // 6 GLOBALES NETZ (40+ Laender)
      vec3 g = rotX(0.3) * (rotY(u_time*0.07) * a_sphere);            // langsame Rotation
      p = g;
      float hub = step(0.93, a_rand);                                  // wenige Hub-Knoten (ruhig)
      b = 0.30 + hub*0.8 + 0.08*sin(u_time + a_rand*6.2831);
      sm = hub*0.6;
      // Klick-Ripple am ORT des Klicks (screen-space), nur Vorderseite des Globus
      vec4 gclip = u_proj * (u_view * vec4(g * u_scale, 1.0));
      vec2 gndc = gclip.xy / gclip.w;
      float front = step(-0.1, g.z);
      float rd = distance(gndc, u_clickNDC);
      float ripple = exp(-pow((rd - u_clickAge*0.55) * 6.0, 2.0)) * step(u_clickAge, 1.8) * front;
      b += ripple*1.7; sm += ripple*0.9;
      tiltC = 0.0;
    } else if (u_concept < 7.5) {                                      // 7 SCHWARM -> WORTMARKE
      float g = smoothstep(0.0, 1.0, 0.5 + 0.5 * sin(u_time*0.32));
      vec3 sc = vec3(a_scatter, sin(a_rand*20.0) * 0.2);
      vec3 wd = vec3(a_word, 0.0);
      p = mix(sc, wd, g); b = 0.40 + g*0.7; sm = g*0.3; tiltC = 0.0;
    } else if (u_concept < 8.5) {                                      // 8 BLOB (Original) — NUR Ruckeln gefixt
      vec3 dir = normalize(a_sphere);
      float t = u_time * 0.4;
      float n = sin(dir.x*2.0 + t) + sin(dir.y*2.3 - t*0.8) + sin(dir.z*1.7 + t*1.1)
              + 0.5*sin(dir.x*4.0 + dir.y*3.0 + t*1.3);
      vec3 def = dir * (1.0 + n * 0.07);                               // Original-Morph
      def = rotX(0.25) * (rotY(u_time*0.13) * def);
      vec3 cDir = normalize(vec3(u_ring * 1.2, 0.8));
      def += cDir * pow(max(0.0, dot(normalize(def), cDir)), 3.0) * 0.18;   // persistente Cursor-Beule (kein Sprung)
      p = def;
      b = 0.45 + smoothstep(-1.1, 1.1, def.z) * 0.8;
      tiltC = 0.0;
    } else if (u_concept < 9.5) {                                      // 9 DISTORT (dimorph): Verformung NUR bei Maus-Impuls, idle = still
      vec3 dir = normalize(a_sphere);
      float t = u_distTime;                                             // Noise-Zeit advanced nur bei Mausbewegung -> idle eingefroren
      float distortion = cnoise((dir + t) * 1.0) * u_distortStr;       // Staerke = cursorX (links 0 = glatt)
      vec3 def = dir * (1.0 + distortion);
      float angle = sin(dir.y * 5.0 + t) * u_twist * 2.0;              // Twist = cursorY (oben/unten dreht den Blob), staerker
      float ca = cos(angle), sa = sin(angle);
      def = vec3(def.x*ca - def.z*sa, def.y, def.x*sa + def.z*ca);
      def = rotX(0.25) * def;                                          // fixe Ansicht, KEINE Auto-Rotation
      p = def;
      b = 0.45 + smoothstep(-1.1, 1.1, def.z) * 0.85;
      tiltC = 0.0;
    } else if (u_concept < 10.5) {                                     // 10 STRUDEL — statisch, bei Mausbewegung Wirbel + nach unten gezogen
      vec2 c = u_ring;
      vec2 dd2 = a_uv - c; float r = length(dd2); float a = atan(dd2.y, dd2.x);
      float sw = u_vortex / (r + 0.25);                                // Wirbel, staerker zur Mitte
      a += sw * 1.6;
      r -= u_vortex * 0.25 * (1.0 - smoothstep(0.0, 1.2, r));          // leicht reingezogen
      vec2 np = c + vec2(cos(a), sin(a)) * r;
      np.y -= u_vortex * 0.5 * (1.2 - r);                              // nach UNTEN gezogen
      p = vec3(np, 0.0);
      b = 0.45 + u_vortex * 0.5; sm = u_vortex * 0.3; tiltC = 0.3;
    } else {                                                           // 11 SCHWARZES LOCH — Partikel spiralen rein, verschwinden am Horizont
      vec2 c = u_ring;
      vec2 d0 = a_uv - c; float r0 = length(d0); float a0 = atan(d0.y, d0.x);
      float fall = fract(u_time * 0.12 + a_rand * 1.7);                // 0 aussen -> 1 verschluckt (pro Partikel versetzt)
      float r = r0 * (1.0 - fall);
      float a = a0 + fall * 5.0;                                       // Akkretions-Spirale
      vec2 np = c + vec2(cos(a), sin(a)) * r;
      p = vec3(np, 0.0);
      float horizon = 0.10;
      b = (0.3 + fall * 1.4) * smoothstep(horizon, horizon + 0.05, r); // heller beim Reinfallen, weg am Horizont
      b += exp(-pow((r0 - 0.34) / 0.05, 2.0) * 0.5) * 0.7;             // heller Akkretions-Ring
      sm = fall * 0.5; tiltC = 0.3;
    }

    p = rotX(tiltC) * p;
    v_energy = clamp(en,0.0,1.0); v_rand = a_rand; v_form = wl; v_bright = b;
    vec4 vp = u_view * vec4(p * u_scale, 1.0);
    gl_Position = u_proj * vp;
    gl_PointSize = u_pointSize * u_dpr * (2.6 / max(0.25, -vp.z)) * (1.0 + max(0.0, sm));
    return;
  }

  float energy = 0.0, sizeMod = 0.0, whiteLocal = 0.0, bright = 1.0;
  vec3 grid = vec3(a_uv, 0.0);

  if (u_chainMode > 0.5) {
    float nx = clamp(a_uv.x / 1.7 * 0.5 + 0.5, 0.0, 1.0);
    float d = nx - u_chainPos; float ddx = d - floor(d + 0.5);                                    // periodisch -> nahtlos
    float inten = 0.12 + pow(nx, 1.3) * 1.2;     // Aufbau: ruhig links -> stark rechts
    if (u_chainStyle < 0.5) {
      // ----- KETTE: lose Partikel von links -> sammeln/verdichten -> Impuls -> Welle (schneller rechts) -> letzte Linien raus. Loop. -----
      float entry = smoothstep(0.0, 0.38, nx);                                                     // links lose -> rechts gesammelt
      float loose = 1.0 - entry;
      grid.x  -= loose * (0.45 + a_rand * 0.4);                                                    // kommen von weiter links herein
      grid.xy += (vec2(a_rand, fract(a_rand*7.3)) - 0.5) * loose * 0.5;                            // lose / gestreut
      float amp = entry * (0.10 + nx * 0.42);
      grid.z  += sin(a_uv.x * (4.0 + nx*11.0) - u_time * (1.2 + nx*4.2)) * amp;                    // Welle: hoeher + SCHNELLER nach rechts
      float ej = smoothstep(0.84, 1.0, nx);                                                        // letzte Linien nach aussen
      grid.x  += ej * (0.4 + 2.5 * ej);
      bright = (0.25 + entry * 0.6) * (1.0 - ej * 0.7);
      sizeMod += loose * 0.3 + entry * 0.2;
      whiteLocal = smoothstep(0.9, 1.0, nx) * (1.0 - ej);
      float px = fract(u_chainPos);                                                                // wandernder Impuls (loopt) — "schubst" die Welle
      float pulse = exp(-pow((nx - px) / 0.07, 2.0) * 0.5);
      grid.z += pulse * 0.18; bright += pulse * 1.3; sizeMod += pulse * 0.6;
    } else {
      // ----- SIGNAL-KETTE: lokaler Blob auf Mittellinie, diffus links -> scharf+stark rechts -----
      float sigx = mix(0.15, 0.07, nx);
      float blobX = exp(-pow(ddx / sigx, 2.0) * 0.5);
      float blobY = exp(-pow(a_uv.y / 0.32, 2.0) * 0.5);
      float blob  = blobX * blobY;
      bright   = 0.40 + blob * (0.8 + inten * 1.2);
      sizeMod += blob * (0.5 + inten * 0.6);
      grid.z  += blob * 0.22 * inten;
      float trail = exp(-pow((ddx + 0.13) / 0.12, 2.0) * 0.5) * smoothstep(0.0, -0.05, ddx) * blobY;
      grid.x  += trail * 0.30 * inten;
      bright  += trail * 0.6;
      grid.z  += a_rand * 0.05 * sin(u_time*22.0 + a_rand*30.0) * smoothstep(0.16, 0.0, nx) * blob;
      whiteLocal = smoothstep(0.88, 0.99, nx) * blob;
    }
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

  // Plasma: ruhiger Glow (KEIN Helligkeits-Puls) + leises Shimmer; die Energie steckt in der FORM (s.u.).
  bright -= u_formSphere * 0.35;
  bright += u_glow * (0.55 + 0.12 * sin(u_time * 5.0 + a_rand * 40.0));

  grid = rotX(u_tilt) * grid;

  mat3 obj = rotX(0.28) * rotY(u_rotY);
  vec3 dia = obj * a_diamond;
  // Plasma als FORM: wabern (Geometrie) + Eruptionen von innen raus + Maus verformt (Beule zum Cursor)
  vec3 sdir = normalize(obj * a_sphere);
  float wob = sin(a_sphere.x*4.0 + u_time*1.6) * sin(a_sphere.y*4.0 - u_time*1.3) * sin(a_sphere.z*4.0 + u_time*1.9);
  float erupt = smoothstep(0.6, 1.0, sin(u_time*0.5 + a_rand*20.0)) * step(a_rand, 0.08);   // selten + sanft rausdruecken
  vec3 cDir = normalize(vec3(u_mouseNDC * 1.2, 0.8));
  float facing = pow(max(0.0, dot(sdir, cDir)), 3.0);
  float rr = 1.0 + wob * 0.22 + erupt * 0.4 + facing * (0.30 + u_mouseAmp * 4.0);            // Maus-Beule
  vec3 sph = sdir * rr;

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
  v_form   = clamp(gemLock + whiteLocal, 0.0, 1.0);  // Weiss NUR fuer Diamant/Kette-Kristall; Reaktor bleibt cyan

  // luftiger machen: Plasma + Diamant-Inneres ausduennen -> gleiche Dichte-Anmutung wie die Felder
  float vis = 1.0;
  if (u_formSphere > 0.5 && a_rand > 0.4) vis = 0.0;                 // Plasma ausgeduennt (~60% weg, gegen Saettigung)
  if (u_formGem > 0.5 && surf < 0.45 && a_rand > 0.3) vis = 0.0;     // Diamant: Inneres weg, Oberflaeche bleibt

  vec4 viewPos = u_view * vec4(pos, 1.0);
  vec4 clip = u_proj * viewPos;
  v_bright = bright;
  gl_Position  = clip;
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
function buildWord(n) {  // Ziel-Positionen aus der MUEGGE-Wortmarke (Canvas-Sampling)
  const rw = mulberry32(909), cw = 280, ch = 72, pts = [];
  try {
    const cvs = document.createElement('canvas'); cvs.width = cw; cvs.height = ch;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.font = '700 46px Inter, Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('MUEGGE', cw / 2, ch / 2);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (data[(y*cw + x)*4 + 3] > 128) pts.push([x, y]);
  } catch (e) { /* getImageData kann in seltenen Faellen blocken */ }
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const pt = pts.length ? pts[Math.floor(rw() * pts.length)] : [cw/2, ch/2];
    out[i*2]   = (pt[0]/cw*2 - 1) * 1.6;
    out[i*2+1] = -(pt[1]/ch*2 - 1) * 0.4;
  }
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
  const word = buildWord(N);
  const rand = new Float32Array(N);
  for (let i=0;i<N;i++) rand[i] = rnd();

  const prog = program(gl, VERT, FRAG);
  const bg = program(gl, BG_VERT, BG_FRAG);

  const buf = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  const bUv = buf(uv), bDia = buf(dia), bSph = buf(sph), bGem = buf(gem), bScatter = buf(scatter), bWord = buf(word), bRand = buf(rand);
  const bQuad = buf(new Float32Array([-1,-1, 3,-1, -1,3]));

  const A = (n) => gl.getAttribLocation(prog, n);
  const U = (n) => gl.getUniformLocation(prog, n);
  const loc = {
    a_uv:A('a_uv'), a_diamond:A('a_diamond'), a_sphere:A('a_sphere'), a_gem:A('a_gem'), a_scatter:A('a_scatter'), a_word:A('a_word'), a_rand:A('a_rand'),
    time:U('u_time'), dpr:U('u_dpr'), scale:U('u_scale'), pointSize:U('u_pointSize'),
    formGrid:U('u_formGrid'), formReaktor:U('u_formReaktor'), formSphere:U('u_formSphere'), formGem:U('u_formGem'),
    waveAmp:U('u_waveAmp'), waveFreq:U('u_waveFreq'), waveSpeed:U('u_waveSpeed'),
    breathe:U('u_breathe'), flat:U('u_flat'), glow:U('u_glow'), flowAmp:U('u_flowAmp'), waveDir:U('u_waveDir'),
    ring:U('u_ring'), ringAmp:U('u_ringAmp'), scatterAmp:U('u_scatterAmp'), concept:U('u_concept'),
    distortStr:U('u_distortStr'), twist:U('u_twist'), clickAge:U('u_clickAge'), clickNDC:U('u_clickNDC'), distTime:U('u_distTime'), vortex:U('u_vortex'),
    pulseT:U('u_pulseT'), pulseAmp:U('u_pulseAmp'), pulseCenter:U('u_pulseCenter'),
    mouse:U('u_mouse'), mouseAmp:U('u_mouseAmp'), mouseNDC:U('u_mouseNDC'),
    magCenter:U('u_magCenter'), magAmp:U('u_magAmp'),
    tilt:U('u_tilt'), rotY:U('u_rotY'), spark:U('u_spark'),
    chainMode:U('u_chainMode'), chainPos:U('u_chainPos'), chainStyle:U('u_chainStyle'), grow:U('u_grow'),
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
  let chainOn = false, chainP = 0, chainAuto = false, chainStyle = 0;
  let magnetOn = false, magCenter = [0, 0];
  let ringOn = false, ringPos = [0, 0], dashOn = false, scatterPtsOn = false, conceptId = 0;
  let growT = 0, growVal = 1.12;
  let mouse = [0,0], mouseAmp = 0, mouseNDC = [2, 2];
  let distStr = 0, twist = 0, distTX = 0, distTY = 0, distTime = 0;   // Distort: eased cursorX->Staerke, cursorY->Twist; distTime nur bei Bewegung
  let vortex = 0;   // Strudel: eased Maus-Aktivitaet (0 statisch -> 1 Wirbel)
  let pulseStart = -10, lastPulse = 0;
  let globeClickT = -10, clickNDCx = 0, clickNDCy = 0;   // Globus: Klick am Ort (nur auf dem Globus)
  let proj = new Float32Array(16);
  const view = translateZ(-3.4);
  let rotY = 0, spark = 0;

  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const setTargets = (o) => { for (const k in o) tgt[k] = o[k]; };

  function setMode(name) {
    chainAuto = false; chainOn = false; magnetOn = false; ringOn = false; dashOn = false; scatterPtsOn = false; conceptId = 0;
    if (name === 'chain' || name === 'chain2') { chainOn = true; chainAuto = true; chainP = 0; chainStyle = (name === 'chain2') ? 1 : 0; modeName = name; setTargets(CHAIN_BASE); return; }
    if (!PRESETS[name]) return;
    if (name === 'magnet') magnetOn = true;
    if (name === 'ring') ringOn = true;                                // Cursor-Ring auf dem Grid (morpht)
    if (name === 'agdots') { ringOn = true; scatterPtsOn = true; }     // AG mit Dots (sparse Punkte)
    if (name === 'antigravity') { ringOn = true; dashOn = true; }      // AG mit Dashes (Linien)
    if (CONCEPTS[name]) { conceptId = CONCEPTS[name]; ringOn = true; } // Step-2-Konzepte (Cursor aktiv)
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
    mouse = [(mx*2-1)*FIELD_ASPECT, -(my*2-1)]; mouseNDC = [mx*2-1, -(my*2-1)]; mouseAmp = 0.22;
    distTX = mx; distTY = my;   // Distort-Ziele: cursorX (0=links) -> Staerke, cursorY -> Twist
  }
  function onClick() {
    pulseStart = T;
    if (modeName === 'globe' && Math.hypot(mouseNDC[0], mouseNDC[1]) < 0.65) {  // nur AUF dem Globus
      globeClickT = T; clickNDCx = mouseNDC[0]; clickNDCy = mouseNDC[1];
    }
  }
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

    if (chainAuto) chainP = (chainP + dt / 9) % 1;   // etwas schneller (Start nicht zu langsam)
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
    { const ef = Math.min(1, dt * 0.6); distStr += (distTX - distStr) * ef; twist += (distTY - twist) * ef; }   // Distort: langsam eased (Impuls -> settle)
    distTime += mouseAmp * dt * 3.5;   // Distort: Noise-Zeit advanced NUR bei Mausbewegung (idle = still)
    { const vf = Math.min(1, dt * 1.5); vortex += ((mouseAmp > 0.02 ? 1 : 0) - vortex) * vf; }   // Strudel: baut bei Bewegung auf, klingt ab

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

    if (dashOn) {  // AG Dashes = Dash-Partikel (Linien) statt Punkte
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
    bindAttr(loc.a_gem, bGem, 3); bindAttr(loc.a_scatter, bScatter, 2); bindAttr(loc.a_word, bWord, 2); bindAttr(loc.a_rand, bRand, 1);

    gl.uniform1f(loc.time, T); gl.uniform1f(loc.dpr, DPR); gl.uniform1f(loc.scale, fieldScale);
    gl.uniform1f(loc.pointSize, cur.pointSize);
    gl.uniform1f(loc.formGrid, cur.formGrid); gl.uniform1f(loc.formReaktor, cur.formReaktor);
    gl.uniform1f(loc.formSphere, cur.formSphere); gl.uniform1f(loc.formGem, cur.formGem);
    gl.uniform1f(loc.waveAmp, cur.waveAmp); gl.uniform1f(loc.waveFreq, cur.waveFreq); gl.uniform1f(loc.waveSpeed, cur.waveSpeed);
    gl.uniform1f(loc.breathe, cur.breathe); gl.uniform1f(loc.flat, cur.flat); gl.uniform1f(loc.glow, cur.glow);
    gl.uniform1f(loc.flowAmp, cur.flowAmp);
    gl.uniform2f(loc.waveDir, 1.0, 0.18);
    gl.uniform1f(loc.pulseT, pulseT); gl.uniform1f(loc.pulseAmp, 0.5); gl.uniform2f(loc.pulseCenter, 0, 0);
    gl.uniform2f(loc.mouse, mouse[0], mouse[1]); gl.uniform1f(loc.mouseAmp, mouseAmp); gl.uniform2f(loc.mouseNDC, mouseNDC[0], mouseNDC[1]);
    gl.uniform2f(loc.magCenter, magCenter[0], magCenter[1]); gl.uniform1f(loc.magAmp, magnetOn ? 0.6 : 0);
    gl.uniform2f(loc.ring, ringPos[0], ringPos[1]); gl.uniform1f(loc.ringAmp, ringOn ? 1 : 0);
    gl.uniform1f(loc.scatterAmp, scatterPtsOn ? 1 : 0);
    gl.uniform1f(loc.concept, conceptId);
    gl.uniform1f(loc.distortStr, distStr); gl.uniform1f(loc.twist, twist);
    gl.uniform1f(loc.clickAge, globeClickT >= 0 ? (T - globeClickT) : 99.0);
    gl.uniform2f(loc.clickNDC, clickNDCx, clickNDCy);
    gl.uniform1f(loc.distTime, distTime); gl.uniform1f(loc.vortex, vortex);
    gl.uniform1f(loc.tilt, cur.tilt); gl.uniform1f(loc.rotY, rotY); gl.uniform1f(loc.spark, spark);
    gl.uniform1f(loc.chainMode, chainOn ? 1 : 0); gl.uniform1f(loc.chainPos, chainP); gl.uniform1f(loc.chainStyle, chainStyle); gl.uniform1f(loc.grow, growVal);
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
      [bUv, bDia, bSph, bGem, bScatter, bWord, bRand, bQuad, bDBase, bDSide, bDRand].forEach((b) => gl.deleteBuffer(b));
      gl.deleteProgram(prog); gl.deleteProgram(bg); gl.deleteProgram(dashProg);
    },
  };
}

function drawPosterFallback(canvas, c) {
  const hex = (a) => '#' + a.map((v) => ('0' + Math.round(v*255).toString(16)).slice(-2)).join('');
  canvas.style.background = `linear-gradient(180deg, ${hex(c.bgTop)}, ${hex(c.bgBot)})`;
}
