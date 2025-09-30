/* Minimal DJ trainer using Web Audio + HTMLMediaElement */

const dbToGain = (db) => Math.pow(10, db / 20);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let audioCtx;

class Meter {
  constructor(ctx, node) {
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.data = new Uint8Array(this.analyser.frequencyBinCount);
    node.connect(this.analyser);
  }
  getLevel() {
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (let i = 0; i < this.data.length; i++) {
      const v = (this.data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.data.length);
    // Convert to dBFS-ish, display as 0..1
    const db = 20 * Math.log10(rms + 1e-6);
    const norm = clamp((db + 60) / 60, 0, 1);
    return norm;
  }
}

function constantPower(x) {
  // x in [-1,1] -> gains A,B
  const t = (x + 1) / 2; // 0..1
  const a = Math.cos(t * Math.PI / 2);
  const b = Math.cos((1 - t) * Math.PI / 2);
  return [a, b];
}

function synthesizeImpulse(ctx, seconds = 1.5) {
  const rate = ctx.sampleRate;
  const frameCount = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, frameCount, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      const t = i / frameCount;
      // decaying noise
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3);
    }
  }
  return buffer;
}

class Echo {
  constructor(ctx) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.delay = ctx.createDelay(2.0);
    this.feedback = ctx.createGain();
    this.wet = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 8000;

    this.input.connect(this.delay);
    this.delay.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(this.output);
    this.tone.connect(this.feedback);
    this.feedback.connect(this.delay);
    // dry path is handled by caller (send effect)

    this.setTime(0.3);
    this.setFeedback(0.35);
    this.setWet(0.2);
  }
  setTime(s) { this.delay.delayTime.value = clamp(s, 0.02, 2.0); }
  setFeedback(v) { this.feedback.gain.value = clamp(v, 0, 0.95); }
  setWet(v) { this.wet.gain.value = clamp(v, 0, 1); }
}

class Deck {
  constructor(ctx, id, master) {
    this.ctx = ctx;
    this.id = id;
    this.master = master;
    this.dom = document.querySelector(`.deck[data-deck="${id}"]`);

    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    this.media = ctx.createMediaElementSource(this.audio);

    // FX/EQ chain
    this.inputGain = ctx.createGain(); // pre-fader (for gain staging)
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 200;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 1;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 5000;
    this.filter = ctx.createBiquadFilter(); this.filter.type = 'allpass';

    // Sends and outputs
    this.post = ctx.createGain(); // deck fader controlled by crossfader
    this.sendDelay = ctx.createGain();
    this.cueSend = ctx.createGain();

    // Meters
    this.meterPre = new Meter(ctx, this.inputGain);
    this.meterPost = new Meter(ctx, this.post);

    // Connect chain
    this.media.connect(this.inputGain);
    this.inputGain.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.filter);
    this.filter.connect(this.post);

    // Sends
    this.filter.connect(this.sendDelay);
    this.sendDelay.connect(master.echo.input);

    // Outputs
    this.post.connect(master.deckBus[id]);
    this.filter.connect(this.cueSend); // pre-fader cue
    this.cueSend.connect(master.cueBus);

    // Defaults
    this.setGainDb(0);
    this.setEQ({ low: 0, mid: 0, high: 0 });
    this.setFilter(0);
    this.setDelaySend(0);
    this.hotCues = [null,null,null,null];
    this.beat1 = 0; // seconds
    this.bpm = 128;
    this.nudgeTimeout = null;

    this.wireUI();
    this.skin = new DeckSkin(this.dom, id);
    this.animate();
  }
  wireUI() {
    const $ = (sel) => this.dom.querySelector(sel);
    this.ui = {
      file: $('.file-input'),
      trackName: $('.track-name'),
      play: $('.play'),
      sync: $('.sync'),
      nudgeM: $('.nudge-'),
      nudgeP: $('.nudge+'),
      tempo: $('.tempo'),
      tempoRO: $('.tempo-readout'),
      bpm: $('.bpm'),
      setBeat1: $('.set-beat1'),
      loop4: $('.loop4'),
      eqL: $('.eq-low'), eqM: $('.eq-mid'), eqH: $('.eq-high'),
      filter: $('.filter'),
      gain: $('.gain'),
      sendDelay: $('.send-delay'),
      cueToggle: $('.cue-toggle-input'),
      meter: this.dom.querySelector('.meter .bar'),
      beatDots: [...this.dom.querySelectorAll('.beat-dot')],
      hot: [...this.dom.querySelectorAll('.hotcue')],
      key: $('.key')
    };

    this.ui.file.addEventListener('change', (e) => this.loadFile(e.target.files?.[0]));
    this.ui.play.addEventListener('click', () => this.togglePlay());
    this.ui.sync.addEventListener('click', () => this.syncToOther());
    this.ui.nudgeM.addEventListener('mousedown', () => this.nudge(-1));
    this.ui.nudgeP.addEventListener('mousedown', () => this.nudge(+1));
    this.ui.tempo.addEventListener('input', () => this.updatePlaybackRate());
    this.ui.bpm.addEventListener('change', () => { this.bpm = parseFloat(this.ui.bpm.value)||this.bpm; this.updateLoop(); });
    this.ui.setBeat1.addEventListener('click', () => { this.beat1 = this.audio.currentTime; this.updateLoop(); });
    this.ui.loop4.addEventListener('click', () => this.toggleLoop4());
    this.ui.eqL.addEventListener('input', () => this.setEQ());
    this.ui.eqM.addEventListener('input', () => this.setEQ());
    this.ui.eqH.addEventListener('input', () => this.setEQ());
    this.ui.filter.addEventListener('input', () => this.setFilter(parseFloat(this.ui.filter.value)));
    this.ui.gain.addEventListener('input', () => this.setGainDb(parseFloat(this.ui.gain.value)));
    this.ui.sendDelay.addEventListener('input', () => this.setDelaySend(parseFloat(this.ui.sendDelay.value)));
    this.ui.cueToggle.addEventListener('change', () => this.updateCueSend());
    this.ui.hot.forEach((wrap, idx) => {
      wrap.querySelector('.hc-set').addEventListener('click', () => this.setHotCue(idx));
      wrap.querySelector('.hc-go').addEventListener('click', () => this.goHotCue(idx));
    });
    this.ui.key.addEventListener('input', () => this.master.updateHarmonic());

    // Click + hold nudge for 200ms bursts
    ['nudge-','nudge+'].forEach(cls => {
      const btn = this.dom.querySelector('.' + cls);
      let ti;
      btn.addEventListener('mousedown', () => {
        const dir = cls.endsWith('+') ? 1 : -1;
        const step = () => { this.nudge(dir); ti = setTimeout(step, 200); };
        step();
      });
      ['mouseup','mouseleave'].forEach(ev => btn.addEventListener(ev, () => clearTimeout(ti)));
    });
  }
  loadFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    this.audio.src = url;
    this.ui.trackName.textContent = file.name;
  }
  togglePlay() {
    if (this.audio.paused) {
      this.audio.play();
      this.ui.play.textContent = 'Pause';
    } else {
      this.audio.pause();
      this.ui.play.textContent = 'Play';
    }
  }
  setEQ() {
    const l = parseFloat(this.ui.eqL.value), m = parseFloat(this.ui.eqM.value), h = parseFloat(this.ui.eqH.value);
    this.low.gain.value = l; this.mid.gain.value = m; this.high.gain.value = h;
    this.skin.setKnob('eq-low', normKnob(l, -12, 12));
    this.skin.setKnob('eq-mid', normKnob(m, -12, 12));
    this.skin.setKnob('eq-high', normKnob(h, -12, 12));
  }
  setFilter(val = 0) {
    // val [-1..1]: negative -> LP, positive -> HP, 0 ~ bypass via allpass/high cutoff
    const abs = Math.abs(val);
    if (Math.abs(val) < 0.02) {
      this.filter.type = 'allpass';
    } else if (val < 0) {
      this.filter.type = 'lowpass';
      // 200 -> 18000 Hz
      const freq = 200 + (18000 - 200) * abs;
      this.filter.frequency.value = freq;
      this.filter.Q.value = 0.9;
    } else {
      this.filter.type = 'highpass';
      // 20 -> 1200 Hz
      const freq = 20 + (1200 - 20) * abs;
      this.filter.frequency.value = freq;
      this.filter.Q.value = 0.9;
    }
  }
  setGainDb(db) { this.inputGain.gain.value = dbToGain(db); this.skin.setKnob('gain', normKnob(db, -24, 12)); }
  setDelaySend(v) { this.sendDelay.gain.value = clamp(v, 0, 1); }
  updateCueSend() { this.cueSend.gain.value = this.ui.cueToggle.checked ? 1 : 0; }
  setHotCue(i) { this.hotCues[i] = this.audio.currentTime; this.skin.flashPad(i); }
  goHotCue(i) { if (this.hotCues[i] != null) { this.audio.currentTime = this.hotCues[i]; this.skin.flashPad(i); } }
  get secondsPerBeat() { return 60 / (this.bpm || 120); }
  updateLoop() {
    if (!this.audio._loop4) return;
    const spb = this.secondsPerBeat;
    const len = 4 * spb;
    const now = this.audio.currentTime;
    const rel = Math.max(0, now - this.beat1);
    const start = this.beat1 + Math.floor(rel / len) * len;
    this.audio.loop = true;
    this.audio.loopStart = start;
    this.audio.loopEnd = start + len;
  }
  toggleLoop4() {
    this.audio._loop4 = !this.audio._loop4;
    if (this.audio._loop4) {
      this.updateLoop();
      this.ui.loop4.classList.add('active');
      this.skin.setLED('loop', true);
    } else {
      this.audio.loop = false;
      this.ui.loop4.classList.remove('active');
      this.skin.setLED('loop', false);
    }
  }
  updatePlaybackRate() {
    const pct = parseFloat(this.ui.tempo.value) || 0; // +/- 8%
    const rate = 1 + pct / 100;
    this.audio._userRate = rate;
    const nudge = this.audio._nudgeRate || 1;
    this.audio.playbackRate = rate * nudge;
    this.ui.tempoRO.textContent = `${pct.toFixed(2)}%`;
    this.skin.setFader('tempo', (pct + 8) / 16); // map -8..8 -> 0..1
  }
  nudge(dir) {
    const amt = 0.02 * dir; // +/- 2%
    clearTimeout(this.nudgeTimeout);
    this.audio._nudgeRate = 1 + amt;
    this.updatePlaybackRate();
    this.nudgeTimeout = setTimeout(() => {
      this.audio._nudgeRate = 1; this.updatePlaybackRate();
    }, 300);
  }
  syncToOther() {
    const other = this.master.otherDeck(this.id);
    if (!other) return;
    // match BPM
    const ratio = (other.bpm || 120) / (this.bpm || 120);
    const pct = (ratio - 1) * 100;
    this.ui.tempo.value = clamp(pct, -8, 8).toFixed(2);
    this.updatePlaybackRate();
    // phase align to nearest beat relative to marked beat1
    const spb = this.secondsPerBeat;
    const phaseThis = (this.audio.currentTime - this.beat1) % spb;
    const phaseOther = (other.audio.currentTime - other.beat1) % other.secondsPerBeat;
    let delta = phaseOther - phaseThis;
    if (Math.abs(delta) > spb / 2) delta += (delta > 0 ? -spb : spb);
    this.audio.currentTime += delta;
  }
  animate() {
    const level = this.meterPost.getLevel();
    this.ui.meter.style.width = `${(level * 100).toFixed(1)}%`;
    this.skin.setMeter(level);
    // Beat dots (simple metronome from beat1 + bpm)
    const spb = this.secondsPerBeat;
    const t = this.audio.currentTime - this.beat1;
    const beat = Math.floor(Math.max(0, t) / spb) % 4;
    this.ui.beatDots.forEach((d,i) => d.classList.toggle('active', i === beat && !this.audio.paused));
    this.skin.setBeat(beat, !this.audio.paused);
    requestAnimationFrame(() => this.animate());
  }
}

class Master {
  constructor(ctx) {
    this.ctx = ctx;
    this.masterGain = ctx.createGain();
    this.cueGain = ctx.createGain();
    this.monitorMixA = ctx.createGain(); // master to monitor mix
    this.monitorMixB = ctx.createGain(); // cue to monitor mix

    // Effect
    this.echo = new Echo(ctx);

    // Deck busses controlled by crossfader
    this.deckBus = { A: ctx.createGain(), B: ctx.createGain() };

    // Cue bus where deck cue sends go
    this.cueBus = ctx.createGain();

    // Routing: deckBus -> masterGain and monitorMixA; cueBus -> monitorMixB
    this.deckBus.A.connect(this.masterGain);
    this.deckBus.B.connect(this.masterGain);
    this.echo.output.connect(this.masterGain);

    // Monitor sim (same physical output):
    this.masterGain.connect(this.monitorMixA);
    this.cueBus.connect(this.monitorMixB);
    this.monitorMixA.connect(ctx.destination);
    this.monitorMixB.connect(ctx.destination);

    // Defaults
    this.setMasterDb(0);
    this.setCueMix(0.5);

    // Attach meters
    this.masterMeter = new Meter(ctx, this.masterGain);
    this.masterBar = document.querySelector('.master-meter .bar');
    this.animate();

    // UI wiring
    this.crossfaderEl = document.getElementById('crossfader');
    this.masterEl = document.getElementById('masterGain');
    this.cueMixEl = document.getElementById('cueMix');
    this.delayTimeEl = document.getElementById('delayTime');
    this.delayFeedbackEl = document.getElementById('delayFeedback');
    this.delayWetEl = document.getElementById('delayWet');
    this.harmonicEl = document.getElementById('harmonicStatus');

    this.crossfaderEl.addEventListener('input', () => this.updateXFader());
    this.masterEl.addEventListener('input', () => this.setMasterDb(parseFloat(this.masterEl.value)));
    this.cueMixEl.addEventListener('input', () => this.setCueMix(parseFloat(this.cueMixEl.value)));
    this.delayTimeEl.addEventListener('input', () => this.echo.setTime(parseFloat(this.delayTimeEl.value)));
    this.delayFeedbackEl.addEventListener('input', () => this.echo.setFeedback(parseFloat(this.delayFeedbackEl.value)));
    this.delayWetEl.addEventListener('input', () => this.echo.setWet(parseFloat(this.delayWetEl.value)));

    // Create a gentle reverb-like impulse for the echo tail via convolver if needed in the future
  }
  setMasterDb(db) { this.masterGain.gain.value = dbToGain(db); }
  setCueMix(val) {
    // 0 = all master, 1 = all cue
    const v = clamp(val, 0, 1);
    this.monitorMixA.gain.value = 1 - v;
    this.monitorMixB.gain.value = v;
  }
  updateXFader() {
    const [ga, gb] = constantPower(parseFloat(this.crossfaderEl.value));
    this.deckBus.A.gain.value = ga;
    this.deckBus.B.gain.value = gb;
    this.skin?.setCrossfader((parseFloat(this.crossfaderEl.value)+1)/2);
  }
  otherDeck(id) { return id === 'A' ? this.deckB : this.deckA; }
  attachDecks(a, b) { this.deckA = a; this.deckB = b; }
  animate() {
    const level = this.masterMeter.getLevel();
    this.masterBar.style.width = `${(level * 100).toFixed(1)}%`;
    requestAnimationFrame(() => this.animate());
  }
  updateHarmonic() {
    const kA = (this.deckA?.ui.key.value || '').trim();
    const kB = (this.deckB?.ui.key.value || '').trim();
    if (!kA || !kB) { this.harmonicEl.textContent = `Keys: ${kA || '—'} vs ${kB || '—'}`; return; }
    const ok = camelotCompatible(kA, kB) || musicalCompatible(kA, kB);
    this.harmonicEl.textContent = `Keys: ${kA} vs ${kB} — ${ok ? 'Good match' : 'Clash'}`;
    this.harmonicEl.style.color = ok ? 'var(--good)' : 'var(--danger)';
  }
}

// Simple Camelot compatibility (same, +/-1 number with same letter)
function camelotCompatible(a, b) {
  const m = (s) => s.toUpperCase().match(/^(\d{1,2})([AB])$/);
  const A = m(a), B = m(b);
  if (!A || !B) return false;
  const n1 = parseInt(A[1], 10), l1 = A[2];
  const n2 = parseInt(B[1], 10), l2 = B[2];
  if (l1 !== l2) return false;
  const wrap = (n) => ((n - 1 + 12) % 12) + 1;
  return n1 === n2 || wrap(n1 + 1) === n2 || wrap(n1 - 1) === n2;
}
// Basic musical compatibility (same key or relative major/minor)
function musicalCompatible(a, b) {
  const circle = {
    'C': ['Am'], 'G': ['Em'], 'D': ['Bm'], 'A': ['F#m'], 'E': ['C#m'], 'B': ['G#m'], 'F#': ['D#m'], 'C#': ['A#m'],
    'F': ['Dm'], 'Bb': ['Gm'], 'Eb': ['Cm'], 'Ab': ['Fm'], 'Db': ['Bbm'], 'Gb': ['Ebm'], 'Cb': ['Abm']
  };
  const norm = (k) => k.replace('m', 'm').replace('♯', '#').replace('♭', 'b');
  a = norm(a); b = norm(b);
  if (a === b) return true;
  return (circle[a] && circle[a].includes(b)) || (circle[b] && circle[b].includes(a));
}

function boot() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const master = new Master(audioCtx);
  const deckA = new Deck(audioCtx, 'A', master);
  const deckB = new Deck(audioCtx, 'B', master);
  master.attachDecks(deckA, deckB);
  master.updateXFader();
  // Expose a tiny API for debugging
  window.dj = { audioCtx, master, deckA, deckB };
}

// UI: start/resume
document.getElementById('startAudioBtn').addEventListener('click', async () => {
  if (!audioCtx) boot();
  if (audioCtx.state !== 'running') await audioCtx.resume();
});

// Help toggle
document.getElementById('helpBtn').addEventListener('click', () => document.getElementById('help').classList.remove('hidden'));
document.getElementById('closeHelp').addEventListener('click', () => document.getElementById('help').classList.add('hidden'));

// Auto-init on first interaction anywhere
window.addEventListener('pointerdown', () => {
  if (!audioCtx) boot();
}, { once: true, capture: true });

// -------- Tutorial system --------
function wait(ms) { return new Promise(res => setTimeout(res, ms)); }
function setRangeValue(input, val) {
  input.value = String(val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function setClick(el) { el.click(); }

class Tutorial {
  constructor() {
    this.el = document.getElementById('coach');
    this.dim = this.el.querySelector('.coach-dim');
    this.spot = this.el.querySelector('.coach-spotlight');
    this.card = this.el.querySelector('.coach-card');
    this.title = this.el.querySelector('.coach-title');
    this.body = this.el.querySelector('.coach-body');
    this.prevBtn = this.el.querySelector('.coach-prev');
    this.nextBtn = this.el.querySelector('.coach-next');
    this.skipBtn = this.el.querySelector('.coach-skip');
    this.progress = this.el.querySelector('.coach-progress');
    this.idx = 0; this.steps = [];
    this.prevBtn.addEventListener('click', () => this.prev());
    this.nextBtn.addEventListener('click', () => this.next());
    this.skipBtn.addEventListener('click', () => this.stop());
    window.addEventListener('resize', () => this.position());
    window.addEventListener('scroll', () => this.position(), { passive: true });
    this.currentEl = null;
    this.keyHandler = (e) => {
      if (this.el.classList.contains('hidden')) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') this.next();
      else if (e.key === 'ArrowLeft') this.prev();
      else if (e.key === 'Escape') this.stop();
    };
    window.addEventListener('keydown', this.keyHandler);
  }
  use(steps) { this.steps = steps; return this; }
  start() {
    if (!audioCtx) boot();
    this.el.classList.remove('hidden');
    this.idx = 0;
    this.show();
  }
  stop() {
    this.el.classList.add('hidden');
  }
  async next() {
    const cur = this.steps[this.idx];
    if (cur && cur.cleanup) await cur.cleanup();
    this.idx = Math.min(this.steps.length - 1, this.idx + 1);
    this.show();
  }
  async prev() {
    const cur = this.steps[this.idx];
    if (cur && cur.cleanup) await cur.cleanup();
    this.idx = Math.max(0, this.idx - 1);
    this.show();
  }
  async show() {
    const step = this.steps[this.idx];
    if (!step) return this.stop();
    this.title.textContent = step.title;
    this.body.innerHTML = step.text;
    this.progress.textContent = `${this.idx + 1} / ${this.steps.length}`;
    await this.highlight(step.target);
    if (step.action) step.action();
  }
  async highlight(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    if (this.currentEl && this.currentEl !== el) this.currentEl.classList.remove('pulse');
    this.currentEl = el; this.currentEl.classList.add('pulse');
    // Ensure in viewport
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    const rect = el.getBoundingClientRect();
    const pad = 6;
    const x = rect.left - pad, y = rect.top - pad, w = rect.width + pad * 2, h = rect.height + pad * 2;
    Object.assign(this.spot.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', borderRadius: '10px' });
    // Place card near the element (below if room, else above)
    const below = y + h + 12 < window.innerHeight * 0.9;
    const cx = clamp(x + w / 2 - 180, 8, window.innerWidth - 360);
    const cy = below ? y + h + 12 : Math.max(8, y - 12 - 140);
    Object.assign(this.card.style, { left: cx + 'px', top: cy + 'px' });
  }
  position(){ // re-position current step on resize/scroll
    if (!this.el || this.el.classList.contains('hidden')) return;
    const step = this.steps[this.idx];
    if (step) this.highlight(step.target);
  }
}

let tutorial;
document.getElementById('startTutorialBtn').addEventListener('click', () => {
  if (!audioCtx) boot();
  if (!tutorial) tutorial = buildTutorial();
  tutorial.start();
});

function buildTutorial() {
  const t = new Tutorial();
  const steps = [];
  const { master, deckA, deckB } = window.dj;
  master.skin = new MasterSkin();
  deckA.skin.ensure(); deckB.skin.ensure();

  steps.push({
    title: 'Start Audio',
    text: 'Browsers require a tap to start sound. Click Start Audio.',
    target: '#startAudioBtn',
    action: () => {},
  });

  steps.push({
    title: 'Crossfader',
    text: 'Use the crossfader to blend Deck A ↔ Deck B. We will move it slowly across.',
    target: '#crossfader',
    action: async () => {
      const xf = master.crossfaderEl;
      // animate -1 -> 1 -> 0
      const anim = async (from, to, ms) => {
        const start = performance.now();
        const step = (now) => {
          const t = clamp((now - start) / ms, 0, 1);
          const v = from + (to - from) * t;
          setRangeValue(xf, v.toFixed(2));
          master.updateXFader();
          if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        await wait(ms + 50);
      };
      await anim(-1, 1, 1400);
      await anim(1, 0, 700);
    },
  });

  steps.push({
    title: 'Tempo & Beatmatching',
    text: 'Adjust Deck B tempo in small steps to match beats. Try ±2% changes and use Nudge for micro‑corrections.',
    target: '.deck[data-deck="B"] .tempo',
    action: async () => {
      const el = deckB.ui.tempo;
      const seq = [-2, 2, 0];
      for (const p of seq) { setRangeValue(el, p); deckB.updatePlaybackRate(); await wait(500); }
      // Flash nudge
      for (let i=0;i<3;i++){ deckB.nudge(+1); await wait(250); }
    },
  });

  steps.push({
    title: 'Sync',
    text: 'Use Sync to match Deck B to Deck A (tempo + phase).',
    target: '.deck[data-deck="B"] .sync',
    action: () => { deckB.syncToOther(); },
  });

  steps.push({
    title: 'EQing',
    text: 'Cut lows when bringing in a new track, then restore. We’ll dip Deck A lows then bring them back.',
    target: '.deck[data-deck="A"] .eq',
    action: async () => {
      const l = deckA.ui.eqL; setRangeValue(l, -12); deckA.setEQ(); await wait(700); setRangeValue(l, 0); deckA.setEQ();
    },
  });

  steps.push({
    title: 'Filter',
    text: 'Use a gentle LP/HP sweep to transition. Watch the single‑knob LP↔HP filter.',
    target: '.deck[data-deck="B"] input.filter',
    action: async () => {
      const f = deckB.ui.filter;
      const anim = async (from, to, ms) => {
        const start = performance.now();
        const step = (now) => {
          const t = clamp((now - start) / ms, 0, 1);
          const v = from + (to - from) * t;
          setRangeValue(f, v.toFixed(2));
          deckB.setFilter(parseFloat(f.value));
          if (t < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        await wait(ms + 50);
      };
      await anim(0, -1, 900);
      await anim(-1, 1, 1200);
      await anim(1, 0, 700);
    },
  });

  steps.push({
    title: 'Looping',
    text: 'Engage a 4‑beat loop to extend an intro/outro. Toggle Loop 4 on Deck B.',
    target: '.deck[data-deck="B"] .loop4',
    action: async () => { deckB.toggleLoop4(); await wait(700); deckB.toggleLoop4(); },
  });

  steps.push({
    title: 'Hot Cues',
    text: 'Set hot cues on key moments and jump between them. We’ll set and trigger Cue 1 on Deck A.',
    target: '.deck[data-deck="A"] .hotcue[data-idx="0"]',
    action: async () => { deckA.setHotCue(0); await wait(300); deckA.goHotCue(0); },
  });

  steps.push({
    title: 'Echo FX',
    text: 'Send a bit of Deck A to Echo for transitions. Then adjust time/feedback/wet.',
    target: '.deck[data-deck="A"] .send-delay',
    action: async () => {
      setRangeValue(deckA.ui.sendDelay, 0.3); deckA.setDelaySend(0.3);
      await wait(300);
      setRangeValue(master.delayWetEl, 0.35); master.echo.setWet(0.35);
      await wait(300);
      setRangeValue(master.delayFeedbackEl, 0.5); master.echo.setFeedback(0.5);
      await wait(300);
      setRangeValue(master.delayWetEl, 0.2); master.echo.setWet(0.2);
      setRangeValue(deckA.ui.sendDelay, 0.0); deckA.setDelaySend(0.0);
    },
  });

  steps.push({
    title: 'Harmonic Mixing',
    text: 'Mix compatible keys. Camelot examples: 8A ↔ 9A or 8A. We’ll fill in example keys.',
    target: '.center .harmonic',
    action: () => {
      deckA.ui.key.value = '8A'; deckB.ui.key.value = '9A'; master.updateHarmonic();
    },
  });

  steps.push({
    title: 'Gain Staging',
    text: 'Keep meters healthy (avoid clipping). Adjust Deck B Gain slightly and watch meters.',
    target: '.deck[data-deck="B"] .gain',
    action: async () => { setRangeValue(deckB.ui.gain, 2); deckB.setGainDb(2); await wait(400); setRangeValue(deckB.ui.gain, 0); deckB.setGainDb(0); },
  });

  return t.use(steps);
}

// ---------- Visual Skin helpers ----------
function normKnob(val, min, max){ return clamp((val - min)/(max - min), 0, 1); }
class DeckSkin{
  constructor(deckDom, id){ this.deckDom = deckDom; this.id = id; this.svg = deckDom.querySelector('.deck-skin .skin-svg'); }
  ensure(){ this.svg = this.svg || this.deckDom.querySelector('.deck-skin .skin-svg'); return this; }
  _sel(role){ return this.svg?.querySelector(`[data-role="${role}"]`); }
  setKnob(role, t){ const g = this._sel(role); if(!g) return; // t in [0,1]
    const angle = -135 + t*270; const tr = g.getAttribute('transform')||''; const m = tr.match(/translate\(([^)]+)\)/); if(!m) return; const [cx,cy]=m[1].split(',').map(parseFloat); g.setAttribute('transform', `translate(${cx},${cy}) rotate(${angle})`); }
  setFader(role, t){ const g = this._sel(role); if(!g) return; const thumb = g.querySelector('.thumb'); const y = -60 + t*120; thumb?.setAttribute('y', y.toFixed(1)); }
  setLED(role, on){ const b = this._sel(role); if(!b) return; const ring = b.querySelector('.led-ring, .led-frame'); if(ring) ring.setAttribute('class', (ring.getAttribute('class')||'') + (on?' led-on':'')); if(!on){ ring?.setAttribute('class', (ring.getAttribute('class')||'').replace(' led-on','')); } }
  flashPad(idx){ const p = this._sel(`hot${idx+1}`); if(!p) return; const frame = p.querySelector('.led-frame'); if(!frame) return; frame.classList.add('led-on'); setTimeout(()=>frame.classList.remove('led-on'), 400); }
  setMeter(level){ const r = this._sel('meter'); if(!r) return; r.setAttribute('width', (6 + level*214).toFixed(0)); }
  setBeat(b, playing){ ['beat0','beat1','beat2','beat3'].forEach((k,i)=>{ const dot=this._sel(k); if(!dot) return; dot.setAttribute('class', 'beat-dot'+(playing&&i===b?' active':'')); }); }
}
class MasterSkin{
  constructor(){ this.svg = document.querySelector('.center-skin .skin-svg'); }
  _sel(role){ return this.svg?.querySelector(`[data-role="${role}"]`); }
  setCrossfader(t){ const g=this._sel('crossfader'); if(!g) return; const thumb=g.querySelector('.thumb'); const x = t*260 - 12; thumb?.setAttribute('x', x.toFixed(1)); }
}
