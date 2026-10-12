// The sound of the room at dawn, synthesised live with Web Audio: no audio files.
//
// A slow four-chord piece in D major that fills in as the sun comes up:
// a soft pad from the start, a harp-like arpeggio once there is a little light,
// then a sparse melody, with birdsong outside and the breeze through the window.
const midi = n => 440 * Math.pow(2, (n - 69) / 12);

const BAR = 4;                                   // seconds: four slow beats
const CHORDS = [                                 // two bars each
  [38, 45, 54, 57, 61, 64],                      // D maj9
  [35, 42, 50, 57, 62, 64],                      // B m7 add11
  [31, 43, 50, 54, 57, 62],                      // G maj7
  [33, 45, 52, 54, 59, 64],                      // A 6 sus
];
const MELODY = [74, 76, 78, 81, 83, 86, 88];     // D major pentatonic, where the tune wanders

export function createMusic() {
  let ctx, master, wet, windGain, timer;
  let progress = 0, muted = false, nextBar = 0, bar = 0, step = 3;

  // one note: an oscillator through a gain envelope, sent partly to the reverb
  function tone(type, freq, t, { attack, hold = 0, release, gain, detune = 0, pan = 0, send = 0.5 }) {
    const osc = ctx.createOscillator(), env = ctx.createGain(), panner = ctx.createStereoPanner();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    panner.pan.value = pan;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.setValueAtTime(gain, t + attack + hold);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    osc.connect(env).connect(panner);
    panner.connect(master);
    const toWet = ctx.createGain();
    toWet.gain.value = send;
    panner.connect(toWet).connect(wet);
    osc.start(t);
    osc.stop(t + attack + hold + release + 0.1);
    return osc;
  }

  function pad(chord, t) {                       // slow swell, held for the two bars
    chord.forEach((n, i) => {
      const bass = i === 0;
      for (const detune of bass ? [0] : [-5, 5])
        tone(bass ? 'sine' : 'triangle', midi(n), t, { attack: 2.5, hold: BAR * 2 - 3, release: 3.5, gain: bass ? 0.07 : 0.018, detune, pan: (i - 2.5) * 0.18, send: 0.7 });
    });
  }
  function pluck(n, t, gain, pan) {              // harp: quick attack, long ring
    tone('triangle', midi(n), t, { attack: 0.006, release: 2.2, gain, pan, send: 0.8 });
    tone('sine', midi(n + 12), t, { attack: 0.004, release: 0.9, gain: gain * 0.3, pan, send: 0.8 });
  }
  function bell(n, t, gain) {                    // melody: a soft felt-piano tone
    tone('sine', midi(n), t, { attack: 0.012, release: 3.2, gain, send: 0.9 });
    tone('sine', midi(n) * 3, t, { attack: 0.008, release: 0.7, gain: gain * 0.12, send: 0.9 });
    tone('triangle', midi(n - 12), t, { attack: 0.02, release: 2.2, gain: gain * 0.35, send: 0.9 });
  }
  function bird(t) {                             // a few quick falling chirps, somewhere outside
    const base = 2600 + Math.random() * 2200, pan = Math.random() * 1.6 - 0.8, count = 2 + (Math.random() * 4 | 0);
    for (let i = 0; i < count; i++) {
      const at = t + i * (0.09 + Math.random() * 0.05);
      const osc = tone('sine', base, at, { attack: 0.01, release: 0.07, gain: 0.012 + Math.random() * 0.01, pan, send: 1 });
      osc.frequency.setValueAtTime(base * (1.15 + Math.random() * 0.2), at);
      osc.frequency.exponentialRampToValueAtTime(base * 0.85, at + 0.07);
    }
  }

  function scheduleBar(t) {
    const chord = CHORDS[(bar >> 1) % CHORDS.length];
    if (bar % 2 === 0) pad(chord, t);
    if (progress > 0.12) {                       // arpeggio: eighth notes rising through the chord, with gaps
      const level = Math.min(1, (progress - 0.12) / 0.25);
      for (let i = 0; i < 8; i++) {
        if (Math.random() < 0.22) continue;
        const n = chord[1 + (i * 2 + bar) % 5] + 12;
        pluck(n, t + i * BAR / 8 + Math.random() * 0.015, 0.03 * level * (i % 4 === 0 ? 1.3 : 1), ((i % 5) - 2) * 0.22);
      }
    }
    if (progress > 0.4) {                        // melody: a note or two a bar, stepping around the scale
      const level = Math.min(1, (progress - 0.4) / 0.3);
      for (const beat of [0, 1.5, 2.5]) {
        if (Math.random() < 0.45) continue;
        step = Math.max(0, Math.min(MELODY.length - 1, step + (Math.random() * 5 | 0) - 2));
        bell(MELODY[step], t + beat * BAR / 4, 0.05 * level);
      }
    }
    if (progress > 0.2) {                        // the birds wake with the light
      const calls = Math.random() * (1 + progress * 3) | 0;
      for (let i = 0; i < calls; i++) bird(t + Math.random() * BAR);
    }
    bar++;
  }

  function start() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const limiter = ctx.createDynamicsCompressor();
    limiter.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(muted ? 0.0001 : 0.9, ctx.currentTime + 4);   // fade in
    master.connect(limiter);

    // a roomy reverb from a burst of decaying noise
    const seconds = 3.2, impulse = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.6);
    }
    const reverb = ctx.createConvolver();
    reverb.buffer = impulse;
    wet = ctx.createGain();
    wet.gain.value = 0.55;
    wet.connect(reverb).connect(master);

    // the breeze: looped noise through a soft band-pass, its level following the swells
    const noise = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(), band = ctx.createBiquadFilter();
    src.buffer = noise;
    src.loop = true;
    band.type = 'bandpass';
    band.frequency.value = 420;
    band.Q.value = 0.4;
    windGain = ctx.createGain();
    windGain.gain.value = 0;
    src.connect(band).connect(windGain).connect(master);
    src.start();

    nextBar = ctx.currentTime + 0.3;
    timer = setInterval(() => {
      if (ctx.state !== 'running') return;
      while (nextBar < ctx.currentTime + 0.6) { scheduleBar(nextBar); nextBar += BAR; }
    }, 150);
  }

  return {
    start,
    setProgress(p) { progress = p; },                                        // 0 = before sunrise, 1 = full morning
    setGust(g) { if (ctx) windGain.gain.setTargetAtTime(0.012 + 0.03 * g, ctx.currentTime, 0.4); },
    setPlaying(on) { if (ctx) on ? ctx.resume() : ctx.suspend(); },
    setMuted(m) { muted = m; if (ctx) master.gain.setTargetAtTime(m ? 0.0001 : 0.9, ctx.currentTime, 0.2); },
    restart() { bar = 0; step = 3; },
    stop() { clearInterval(timer); },
  };
}
