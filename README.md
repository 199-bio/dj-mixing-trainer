DJ Mixing Trainer (Web Audio)

What this is
- A minimal, browser‑based trainer to practice core DJ techniques with two decks. Now includes a non‑interactive SVG “hardware” skin so controls look like real physical buttons/knobs/faders for tutorial/demo use.
- No installs or backend required. Works as a static site (great fit for Vercel).

Top 10 techniques covered (and where to find them)
- Beatmatching: Tempo slider (±8%), Sync button, Nudge ±
- Phrasing: Set Beat 1; 4 beat dots indicate the current bar position
- EQing: 3‑band EQ (Low/Mid/High ±12 dB)
- Gain staging: Deck Gain (‑24..+12 dB) and meters (per‑deck + master)
- Crossfading: Constant‑power crossfader
- Looping: 4‑beat loop toggle (uses BPM and Beat 1)
- Hot Cues: 1–4 set/trigger per deck
- Filtering: Single knob LP ↔ HP macro filter
- Effects: Echo send per deck; time / feedback / wet (global)
- Harmonic mixing: Key fields (e.g., 8A, Am) with compatibility hint

How to use
1) Click "Start Audio" (browser requirement), then optionally click "Start Tutorial" for an animated, step‑by‑step walkthrough.
2) Load audio files for Deck A/B.
3) Enter each deck’s BPM (or leave 128), and hit "Set Beat 1" on the first downbeat.
4) Train the techniques above — use Sync + Nudge for beatmatching, EQ/Filter while crossfading, set loops and hot cues, etc.

Notes
- This is a practice/education tool — not a performance‑grade mixer. There’s no time‑stretch/key‑lock; tempo changes will affect pitch.
- The cue bus is simulated (you’ll hear it in the same output); it’s here for gain staging and mix‑prep practice.

Local dev
- Open `index.html` directly in a modern browser, or serve the folder with any static server.

Visual (non‑interactive) mode
- The app defaults to a non‑interactive, animated tutorial skin (SVG). The original HTML controls are hidden in this mode.
- Use the Start Tutorial button to see the controls animate like a step‑by‑step lesson.

Deploy on Vercel
- Push this repo to GitHub and import it in Vercel as a static project. Default settings work. A `vercel.json` is included but optional.

License
- MIT
