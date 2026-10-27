// Procedural soundtrack for the video: a soft pad that follows the animation's sections, and a
// bell for every star as it appears (panned to where it sits). No samples, no network, no licensing.
//
//   compose(events, T, duration) -> WAV file contents (Buffer, 44.1 kHz stereo 16-bit)
//
// events come from template.html's build(): { t, type: me|star|halo|peak|ripple|thanks, ring?, w?, pan? }.

const SR = 44100;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// D major pentatonic, so any two bells sound fine together over every chord below
const PENTA = [2, 4, 6, 9, 11];
const scale = (lo, hi) => { const out = []; for (let m = lo; m <= hi; m++) if (PENTA.includes(m % 12)) out.push(m); return out; };

// a tiny seeded random, so the same data always gives the same music
const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };

export function compose(events, T, duration) {
  const n = Math.ceil(duration * SR);
  const dry = [new Float32Array(n), new Float32Array(n)];
  const send = [new Float32Array(n), new Float32Array(n)];
  const rand = rng(events.length * 7919 + 17);

  // ---------- pad: one chord per section ----------
  const chords = [
    [0, [50, 57, 61, 64, 66]],                 // Dmaj9   intro
    [T.week0, [47, 54, 57, 62, 66]],           // Bm7     the sweep begins
    [T.week0 + T.weekDur / 2, [43, 50, 54, 57, 59]], // Gmaj7   halfway round
    [T.halo - 0.3, [45, 52, 57, 59, 64]],      // Asus    new followers
    [T.thanks, [50, 57, 62, 64, 66, 69]],      // D       thanks, resolved
  ];
  chords.forEach(([t0, notes], i) => {
    const t1 = i + 1 < chords.length ? chords[i + 1][0] : duration;
    const a = Math.floor(t0 * SR), b = Math.min(n, Math.floor((t1 + 1.6) * SR));
    notes.forEach((m, k) => {
      const f = hz(m), det = [0.9985, 1.0015];
      const amp = 0.038 / (1 + k * 0.12);
      for (let ch = 0; ch < 2; ch++) {
        const w = 2 * Math.PI * f * det[ch] / SR, ph = rand() * 6.28;
        for (let i2 = a; i2 < b; i2++) {
          const t = (i2 - a) / SR, tl = t1 - t0 - t;
          const env = Math.min(1, t / 1.2) * Math.min(1, Math.max(0, (tl + 1.6) / 1.6)) * (0.85 + 0.15 * Math.sin(t * 1.3 + k));
          const x = w * i2 + ph;
          const v = amp * env * (Math.sin(x) + 0.22 * Math.sin(2 * x) + 0.07 * Math.sin(3 * x));
          dry[ch][i2] += v * 0.7; send[ch][i2] += v * 0.5;
        }
      }
    });
  });

  // ---------- bells ----------
  const bell = (t, midi, vol, decay, pan = 0, bright = 1) => {
    const a = Math.floor(t * SR);
    if (a >= n) return;
    const b = Math.min(n, a + Math.floor(decay * 6 * SR));
    const f = hz(midi);
    const parts = [[1, 1, 1], [2.0, 0.32 * bright, 0.55], [3.01, 0.1 * bright, 0.35], [4.2, 0.05 * bright, 0.2]];
    const gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
    for (let i = a; i < b; i++) {
      const tt = (i - a) / SR;
      const att = Math.min(1, tt / 0.004);
      let v = 0;
      for (const [r, g, d] of parts) v += g * Math.exp(-tt / (decay * d)) * Math.sin(2 * Math.PI * f * r * tt);
      v *= vol * att;
      dry[0][i] += v * gl; dry[1][i] += v * gr;
      send[0][i] += v * gl * 0.9; send[1][i] += v * gr * 0.9;
    }
  };
  const lead = 0.05; // the star's pop peaks a moment after it starts
  const ringNotes = { inner: scale(62, 79), middle: scale(69, 86), outer: scale(76, 93) };
  const walk = { inner: 4, middle: 4, outer: 4 };
  let lastT = -1;
  for (const e of events) {
    const pan = Math.max(-0.85, Math.min(0.85, e.pan || 0));
    if (e.type === 'me') { bell(e.t + lead, 62, 0.16, 1.6, 0); bell(e.t + lead, 74, 0.12, 1.4, 0); }
    else if (e.type === 'star') {
      const notes = ringNotes[e.ring];
      // a gentle random walk over the scale reads as a melody rather than noise
      walk[e.ring] = Math.max(0, Math.min(notes.length - 1, walk[e.ring] + Math.round((rand() - 0.5) * 4)));
      const crowded = e.t - lastT < 0.05 && e.ring !== 'inner';
      lastT = e.t;
      if (crowded) continue;
      if (e.ring === 'inner') bell(e.t + lead, notes[walk.inner], 0.15 + 0.06 * e.w, 1.5, pan);
      else if (e.ring === 'middle') bell(e.t + lead, notes[walk.middle], 0.075, 0.9, pan, 0.8);
      else bell(e.t + lead, notes[walk.outer], 0.045, 0.6, pan, 0.6);
    } else if (e.type === 'halo') {
      const notes = scale(74, 98);
      const i = events.filter((x) => x.type === 'halo' && x.t < e.t).length;
      bell(e.t + lead, notes[i % notes.length], 0.05, 0.7, pan, 0.7);
    } else if (e.type === 'peak') { bell(e.t + lead, 93, 0.07, 1.2, pan); bell(e.t + lead + 0.09, 98, 0.05, 1.1, pan); }
    else if (e.type === 'ripple') {
      // a soft low swell under the halo
      const a = Math.floor(e.t * SR), b = Math.min(n, a + Math.floor(2.5 * SR));
      for (let i = a; i < b; i++) {
        const tt = (i - a) / SR, f = 55 + 25 * Math.exp(-tt * 3);
        const v = 0.16 * Math.min(1, tt / 0.03) * Math.exp(-tt / 0.7) * (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt));
        dry[0][i] += v; dry[1][i] += v; send[0][i] += v * 0.3; send[1][i] += v * 0.3;
      }
    } else if (e.type === 'thanks') {
      [74, 78, 81, 86].forEach((m, k) => bell(e.t + k * 0.11, m, 0.11, 2.4, (k - 1.5) * 0.3));
    }
  }

  // ---------- reverb (Freeverb-style combs + allpasses) ----------
  const wet = [0, 1].map((ch) => {
    const x = send[ch], y = new Float32Array(n), sp = ch * 23;
    for (const len of [1116, 1188, 1277, 1356, 1422, 1491].map((d) => d + sp)) {
      const buf = new Float32Array(len); let idx = 0, lp = 0;
      for (let i = 0; i < n; i++) {
        const out = buf[idx];
        lp = out * 0.75 + lp * 0.25;
        buf[idx] = x[i] + lp * 0.84;
        idx = (idx + 1) % len;
        y[i] += out / 6;
      }
    }
    for (const len of [556, 441, 341].map((d) => d + sp)) {
      const buf = new Float32Array(len); let idx = 0;
      for (let i = 0; i < n; i++) { const b = buf[idx]; const v = -y[i] + b; buf[idx] = y[i] + b * 0.5; idx = (idx + 1) % len; y[i] = v; }
    }
    return y;
  });

  // ---------- master: mix, fade, normalize, soft clip ----------
  const out = Buffer.alloc(44 + n * 4);
  const mix = [0, 1].map((ch) => dry[ch].map((v, i) => v + wet[ch][i] * 0.9));
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const t = i / SR, fade = Math.min(1, t / 0.8) * Math.min(1, Math.max(0, (duration - t) / 1.4));
    for (let ch = 0; ch < 2; ch++) { mix[ch][i] *= fade; peak = Math.max(peak, Math.abs(mix[ch][i])); }
  }
  const gain = 0.8 / peak;
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 4, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < 2; ch++) {
    out.writeInt16LE(Math.round(Math.tanh(mix[ch][i] * gain) * 32767), 44 + i * 4 + ch * 2);
  }
  return out;
}
