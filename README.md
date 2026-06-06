# MUEGGE „creating waves" — Wave-Showcase

Self-contained WebGL-Partikel-Showcase. Eine Engine, viele Zustände — visualisiert MUEGGEs
Mikrowellen-/Plasma-Kette („Strom → Welle → Hohlleiter → Plasma → Kristall").

## Starten
WebGL + ES-Module brauchen `http://` (nicht `file://`). Einfachster Weg:

```bash
cd prototype
python3 -m http.server 8755
# dann im Browser: http://localhost:8755/
```

## Zustände (Buttons unten)
| Button | Zustand | Bezug Prompt-1 |
|---|---|---|
| Wave | Sinus-Wellenfront (Hero-Default) | a) |
| Grid | atmendes Top-Down-Grid | c1) |
| Signal | Puls strahlt aus = „Signal gesendet" | d) |
| Diamant | Carbon→Diamant-Kristallgitter (MUEGGE-Objekt) | f) |
| Plasma | leuchtende Plasma-Kugel | f) |
| ▶ Kette | Energie-Puls wandert die Produktkette; Slider = Scroll-Kopplung | Prompt-2 |

**Interaktion:** Maus bewegen = Ripple · Klick = Puls senden.

## Dateien
- `wave.js` — die Engine (raw WebGL, 0 Dependencies). API: `createWaveField(canvas, opts)` →
  `{ setMode, setColors, scrub, destroy }`. Portierbar nach React/Astro (MACH + Sanity).
- `index.html` — Showcase-Seite mit Hero + Control-Panel.

## Performance / Stand
- Farben aus `00 Designsystem/muegge-design-tokens.json`.
- `prefers-reduced-motion` → statisches Bild, kein rAF. Pausiert bei Tab-Wechsel / out-of-view.
- DPR gecappt; ~8.500 Punkte komplett GPU-getrieben (Vertex-Shader), CPU ~0.
- Noch offen (Phase 2): Dithering-Wafer-Zustand, Poster-LCP-Bild, Mobile-Dot-Reduktion-Tuning.
