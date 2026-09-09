/* ==========================================================================
   CAN YOU ESCAPE? — script.js
   Four rooms, one engine. A single `state` object drives everything; the DOM
   only reflects it.

   Sections
     helpers · audio (Web Audio API, incl. looping ambience) · level data ·
     progress (localStorage) · state · screens · cinematic transition ·
     level select · stage scaling · particles · timer · clues · modal ·
     inspectors (per room) · locks (keypad / word / valves / dials / board /
     brake) · key & exit · hints · end screens · room ambience · input · boot
   ========================================================================== */
(() => {
  "use strict";

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const TOTAL_TIME = 5 * 60;
  const HINT_TOTAL = 3;

  // ---------------------------------------------------------------- audio
  // Every sound is synthesised: oscillators + gain envelopes + filtered noise.
  // `ambience` keeps a couple of looping sources alive for the train.
  const sfx = (() => {
    let ctx = null, master = null, noiseBuf = null, enabled = true;
    let amb = null;   // { nodes: [], gain }

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.45;
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx;
    }
    const on = () => enabled && ensure();
    function buffer(c) {
      if (!noiseBuf) {
        noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      return noiseBuf;
    }

    function tone({ freq = 440, type = "sine", dur = 0.15, vol = 0.3, attack = 0.005, slideTo = null, delay = 0, filter = null, q = 1 }) {
      const c = on(); if (!c) return;
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let node = osc;
      if (filter) { const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = filter; f.Q.value = q; osc.connect(f); node = f; }
      node.connect(g); g.connect(master);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    }
    function noise({ dur = 0.3, vol = 0.2, delay = 0, filter = 1200, type = "lowpass", q = 0.7, attack = 0.01, slideTo = null }) {
      const c = on(); if (!c) return;
      const t0 = c.currentTime + delay;
      const src = c.createBufferSource(); src.buffer = buffer(c); src.loop = true;
      const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(filter, t0); f.Q.value = q;
      if (slideTo) f.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.05);
    }

    /** A looping bed: wheels on rail + rain against the glass. */
    function startAmbience(kind) {
      const c = ensure(); if (!c) return;
      stopAmbience();
      const out = c.createGain();
      out.gain.setValueAtTime(0.0001, c.currentTime);
      out.gain.exponentialRampToValueAtTime(enabled ? 0.5 : 0.0001, c.currentTime + 2.5);
      out.connect(master);
      const nodes = [];
      if (kind === "train") {
        // wheels: low rumble with a slow sway
        const rum = c.createBufferSource(); rum.buffer = buffer(c); rum.loop = true;
        const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 130; lp.Q.value = 3;
        const rg = c.createGain(); rg.gain.value = 0.5;
        const lfo = c.createOscillator(); lfo.frequency.value = 0.28;
        const lfoG = c.createGain(); lfoG.gain.value = 0.16;
        lfo.connect(lfoG); lfoG.connect(rg.gain);
        rum.connect(lp); lp.connect(rg); rg.connect(out);
        // rail joints: a soft pulse every couple of seconds
        const clack = c.createOscillator(); clack.type = "sine"; clack.frequency.value = 46;
        const cg = c.createGain(); cg.gain.value = 0.0;
        const pulse = c.createOscillator(); pulse.type = "square"; pulse.frequency.value = 0.62;
        const pg = c.createGain(); pg.gain.value = 0.05;
        pulse.connect(pg); pg.connect(cg.gain);
        clack.connect(cg); cg.connect(out);
        // rain hiss
        const rain = c.createBufferSource(); rain.buffer = buffer(c); rain.loop = true;
        const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 2600;
        const rgn = c.createGain(); rgn.gain.value = 0.055;
        rain.connect(hp); hp.connect(rgn); rgn.connect(out);
        [rum, lfo, clack, pulse, rain].forEach((n) => { n.start(); nodes.push(n); });
      } else if (kind === "wind") {
        // wind across the dome slit: filtered noise with a slow, uneven swell
        const w = c.createBufferSource(); w.buffer = buffer(c); w.loop = true;
        const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 420; bp.Q.value = 0.7;
        const wg = c.createGain(); wg.gain.value = 0.16;
        const lfo = c.createOscillator(); lfo.frequency.value = 0.09;
        const lfoG = c.createGain(); lfoG.gain.value = 0.09;
        const lfo2 = c.createOscillator(); lfo2.frequency.value = 0.23;
        const lfo2G = c.createGain(); lfo2G.gain.value = 140;
        lfo.connect(lfoG); lfoG.connect(wg.gain);
        lfo2.connect(lfo2G); lfo2G.connect(bp.frequency);
        w.connect(bp); bp.connect(wg); wg.connect(out);
        // the dome's timbers, ticking as they cool
        const tk = c.createOscillator(); tk.type = "triangle"; tk.frequency.value = 1900;
        const tg = c.createGain(); tg.gain.value = 0.0;
        const pulse = c.createOscillator(); pulse.type = "square"; pulse.frequency.value = 0.17;
        const pg = c.createGain(); pg.gain.value = 0.006;
        pulse.connect(pg); pg.connect(tg.gain);
        tk.connect(tg); tg.connect(out);
        [w, lfo, lfo2, tk, pulse].forEach((n) => { n.start(); nodes.push(n); });
      } else if (kind === "scanner") {
        // fluorescent hum, air handling, and a police scanner breathing static
        const hum = c.createOscillator(); hum.type = "triangle"; hum.frequency.value = 100;
        const hg = c.createGain(); hg.gain.value = 0.025;
        hum.connect(hg); hg.connect(out);
        const air = c.createBufferSource(); air.buffer = buffer(c); air.loop = true;
        const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 260;
        const ag = c.createGain(); ag.gain.value = 0.2;
        air.connect(lp); lp.connect(ag); ag.connect(out);
        const st = c.createBufferSource(); st.buffer = buffer(c); st.loop = true;
        const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 2600; bp.Q.value = 5;
        const sg = c.createGain(); sg.gain.value = 0.0;
        const lfo = c.createOscillator(); lfo.type = "square"; lfo.frequency.value = 0.21;
        const lg = c.createGain(); lg.gain.value = 0.018;
        lfo.connect(lg); lg.connect(sg.gain);
        st.connect(bp); bp.connect(sg); sg.connect(out);
        [hum, air, st, lfo].forEach((n) => { n.start(); nodes.push(n); });
      } else if (kind === "workshop") {
        // a dozen escapements, not quite in step: two soft tick sources at slightly different rates
        [[1.0, 1500], [0.93, 1180]].forEach(([rate, f]) => {
          const t = c.createOscillator(); t.type = "triangle"; t.frequency.value = f;
          const g = c.createGain(); g.gain.value = 0.0;
          const pulse = c.createOscillator(); pulse.type = "square"; pulse.frequency.value = rate;
          const pg = c.createGain(); pg.gain.value = 0.012;
          pulse.connect(pg); pg.connect(g.gain);
          t.connect(g); g.connect(out);
          [t, pulse].forEach((n) => { n.start(); nodes.push(n); });
        });
        const room = c.createBufferSource(); room.buffer = buffer(c); room.loop = true;
        const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 200;
        const rg = c.createGain(); rg.gain.value = 0.12;
        room.connect(lp); lp.connect(rg); rg.connect(out);
        room.start(); nodes.push(room);
      }
      amb = { nodes, gain: out };
    }
    function stopAmbience() {
      if (!amb || !ctx) return;
      const { nodes, gain } = amb;
      amb = null;
      try {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      } catch { /* node already gone */ }
      setTimeout(() => nodes.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } }), 700);
    }

    return {
      setEnabled(v) { enabled = v; if (v) ensure(); else stopAmbience(); },
      unlock() { ensure(); },
      ambience: { start: (k) => { if (enabled) startAmbience(k); }, stop: stopAmbience },
      click() { tone({ freq: 900, type: "triangle", dur: 0.06, vol: 0.12 }); noise({ dur: 0.05, vol: 0.05, filter: 3000 }); },
      key() { tone({ freq: 1250, type: "square", dur: 0.07, vol: 0.06, filter: 2500 }); },
      dial() { tone({ freq: 620, type: "square", dur: 0.05, vol: 0.07, filter: 1800 }); noise({ dur: 0.04, vol: 0.05, filter: 2600 }); },
      flap() { [0, 0.045, 0.085].forEach((d, i) => noise({ dur: 0.04, vol: 0.09 - i * 0.02, delay: d, filter: 2400, type: "bandpass", q: 2 })); tone({ freq: 320, type: "square", dur: 0.05, vol: 0.05, filter: 900 }); },
      wrong() { tone({ freq: 190, type: "sawtooth", dur: 0.28, vol: 0.18, filter: 900 }); tone({ freq: 140, type: "square", dur: 0.32, vol: 0.12, delay: 0.05, filter: 600 }); },
      correct() { [660, 880, 1320].forEach((f, i) => tone({ freq: f, type: "sine", dur: 0.28, vol: 0.18, delay: i * 0.09 })); },
      locked() { noise({ dur: 0.12, vol: 0.18, filter: 500, q: 2 }); tone({ freq: 90, type: "square", dur: 0.14, vol: 0.12, filter: 300 }); noise({ dur: 0.1, vol: 0.14, delay: 0.16, filter: 500, q: 2 }); },
      safeOpen() {
        tone({ freq: 220, type: "square", dur: 0.12, vol: 0.14, filter: 700 });
        tone({ freq: 160, type: "square", dur: 0.12, vol: 0.14, delay: 0.18, filter: 700 });
        noise({ dur: 1.3, vol: 0.12, delay: 0.5, filter: 300, slideTo: 900, q: 3, attack: 0.3 });
        tone({ freq: 55, type: "sine", dur: 1.2, vol: 0.25, delay: 0.5 });
      },
      chestOpen() {
        tone({ freq: 340, type: "triangle", dur: 0.1, vol: 0.12 });
        noise({ dur: 0.9, vol: 0.12, delay: 0.25, filter: 400, slideTo: 1500, q: 2, attack: 0.25 });
        tone({ freq: 70, type: "sine", dur: 0.9, vol: 0.2, delay: 0.3 });
      },
      latch() { [0, 0.16].forEach((d) => { tone({ freq: 1400, type: "square", dur: 0.05, vol: 0.1, delay: d, filter: 3400 }); noise({ dur: 0.07, vol: 0.09, delay: d, filter: 3000, type: "bandpass", q: 3 }); }); },
      valve() { noise({ dur: 0.42, vol: 0.13, filter: 900, slideTo: 400, q: 6, attack: 0.06 }); tone({ freq: 240, type: "square", dur: 0.4, vol: 0.06, filter: 700, slideTo: 180 }); },
      steam() { noise({ dur: 1.1, vol: 0.2, filter: 2600, slideTo: 700, type: "highpass", q: 0.8, attack: 0.05 }); },
      water() { noise({ dur: 1.8, vol: 0.14, filter: 500, slideTo: 180, q: 2, attack: 0.3 }); tone({ freq: 60, type: "sine", dur: 1.6, vol: 0.16 }); },
      fire() { noise({ dur: 1.6, vol: 0.1, filter: 700, q: 1.5, attack: 0.4 }); },
      typewriter() { [0, 0.09, 0.17].forEach((d) => { tone({ freq: 1500 + Math.random() * 500, type: "square", dur: 0.03, vol: 0.07, delay: d, filter: 4000 }); }); tone({ freq: 1800, type: "sine", dur: 0.2, vol: 0.07, delay: 0.3 }); },
      thunder(near) {
        const v = near ? 0.34 : 0.18;
        noise({ dur: near ? 0.16 : 0.1, vol: v * 0.8, filter: 5200, type: "highpass", attack: 0.004 });
        noise({ dur: near ? 3.2 : 2.4, vol: v, delay: 0.08, filter: 220, slideTo: 60, q: 1.2, attack: near ? 0.05 : 0.35 });
        tone({ freq: near ? 44 : 36, type: "sine", dur: near ? 2.6 : 2.0, vol: v * 0.9, delay: 0.1, slideTo: 26 });
      },
      bump() { noise({ dur: 0.22, vol: 0.16, filter: 260, q: 2, attack: 0.005 }); tone({ freq: 62, type: "sine", dur: 0.3, vol: 0.2, slideTo: 40 }); },
      announce() {
        [880, 660].forEach((f, i) => { tone({ freq: f, type: "sine", dur: 0.7, vol: 0.16, delay: i * 0.45 }); tone({ freq: f * 2, type: "sine", dur: 0.5, vol: 0.05, delay: i * 0.45 }); });
        noise({ dur: 1.6, vol: 0.03, delay: 0.9, filter: 1600, type: "bandpass", q: 1.2, attack: 0.2 });
      },
      brakePull() {
        noise({ dur: 2.6, vol: 0.2, filter: 3400, slideTo: 900, type: "bandpass", q: 9, attack: 0.25 });
        noise({ dur: 3.2, vol: 0.14, filter: 200, slideTo: 70, q: 2, attack: 0.4 });
        tone({ freq: 260, type: "sawtooth", dur: 3.0, vol: 0.08, slideTo: 60, filter: 800 });
      },
      alarm() { for (let i = 0; i < 4; i++) { tone({ freq: 720, type: "square", dur: 0.22, vol: 0.12, delay: i * 0.42, filter: 1800 }); tone({ freq: 540, type: "square", dur: 0.22, vol: 0.12, delay: i * 0.42 + 0.21, filter: 1800 }); } },
      keyPickup() { [1046, 1318, 1568, 2093].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.22, vol: 0.12, delay: i * 0.07 })); noise({ dur: 0.08, vol: 0.05, filter: 6000, type: "highpass" }); },
      doorOpen() {
        tone({ freq: 700, type: "triangle", dur: 0.08, vol: 0.12 }); tone({ freq: 520, type: "triangle", dur: 0.1, vol: 0.12, delay: 0.12 });
        noise({ dur: 2.2, vol: 0.16, delay: 0.5, filter: 220, slideTo: 1400, q: 4, attack: 0.5 });
        tone({ freq: 48, type: "sine", dur: 2.4, vol: 0.28, delay: 0.5, slideTo: 36 });
      },
      victory() { [523, 659, 784, 1046, 1318].forEach((f, i) => { tone({ freq: f, type: "sine", dur: 0.6, vol: 0.16, delay: i * 0.12 }); tone({ freq: f / 2, type: "triangle", dur: 0.8, vol: 0.08, delay: i * 0.12 }); }); },
      gameOver() { [330, 262, 196, 131].forEach((f, i) => tone({ freq: f, type: "sawtooth", dur: 0.55, vol: 0.14, delay: i * 0.28, filter: 800 })); tone({ freq: 40, type: "sine", dur: 1.6, vol: 0.3, delay: 1.0 }); },
      tick() { tone({ freq: 1500, type: "square", dur: 0.03, vol: 0.05, filter: 3000 }); },
      hint() { tone({ freq: 880, type: "sine", dur: 0.18, vol: 0.12 }); tone({ freq: 1174, type: "sine", dur: 0.22, vol: 0.1, delay: 0.1 }); },
      reveal() { tone({ freq: 392, type: "sine", dur: 0.5, vol: 0.1 }); tone({ freq: 587, type: "sine", dur: 0.7, vol: 0.1, delay: 0.15 }); },
      whoosh() { noise({ dur: 0.5, vol: 0.12, filter: 400, slideTo: 3000, attack: 0.15 }); },
      grind() { noise({ dur: 0.34, vol: 0.09, filter: 380, q: 3, attack: 0.04 }); tone({ freq: 70, type: "sawtooth", dur: 0.3, vol: 0.04, filter: 260 }); },
      domeOpen() {
        noise({ dur: 2.4, vol: 0.18, filter: 160, slideTo: 90, q: 2, attack: 0.2 });
        tone({ freq: 52, type: "sine", dur: 2.2, vol: 0.22, slideTo: 38 });
        tone({ freq: 1200, type: "square", dur: 0.06, vol: 0.09, delay: 1.9, filter: 3000 });
        noise({ dur: 2.6, vol: 0.07, delay: 1.6, filter: 2200, type: "highpass", attack: 0.8 });
      },
      drawer() { noise({ dur: 0.36, vol: 0.12, filter: 1400, slideTo: 500, type: "bandpass", q: 2, attack: 0.05 }); tone({ freq: 480, type: "triangle", dur: 0.12, vol: 0.06, delay: 0.3 }); },
      gate() { tone({ freq: 180, type: "square", dur: 0.16, vol: 0.14, filter: 900 }); noise({ dur: 0.5, vol: 0.16, delay: 0.1, filter: 2200, slideTo: 600, type: "bandpass", q: 4 }); tone({ freq: 60, type: "sine", dur: 0.9, vol: 0.22, delay: 0.12, slideTo: 42 }); },
      powerDown() {
        tone({ freq: 120, type: "sawtooth", dur: 1.6, vol: 0.12, slideTo: 24, filter: 600 });
        noise({ dur: 1.4, vol: 0.1, filter: 900, slideTo: 120, q: 1.5, attack: 0.05 });
        tone({ freq: 48, type: "sine", dur: 0.5, vol: 0.28, delay: 1.5, slideTo: 30 });
        noise({ dur: 0.12, vol: 0.14, delay: 1.5, filter: 300, q: 2 });
      },
      radio() { [0, 0.14, 0.31].forEach((d, i) => noise({ dur: 0.08 + i * 0.03, vol: 0.05, delay: d, filter: 2400 + i * 600, type: "bandpass", q: 6 })); },
      cuckoo() { [0, 0.34].forEach((d) => { tone({ freq: 1046, type: "sine", dur: 0.18, vol: 0.12, delay: d }); tone({ freq: 830, type: "sine", dur: 0.26, vol: 0.12, delay: d + 0.17 }); }); },
      tock() { tone({ freq: 1800, type: "square", dur: 0.02, vol: 0.035, filter: 2600 }); noise({ dur: 0.03, vol: 0.03, filter: 3200, type: "bandpass", q: 4 }); },
      ratchet() { [0, 0.08, 0.16, 0.24].forEach((d) => noise({ dur: 0.04, vol: 0.06, delay: d, filter: 2000, type: "bandpass", q: 5 })); },
    };
  })();

  // ---------------------------------------------------------------- levels
  const LEVELS = [
    {
      id: 1, name: "The Room", sub: "A number · a time",
      clues: ["painting", "clock", "note", "lamp"],
      clueText: {
        painting: "Clue found: the number 7 hidden in the painting.",
        clock: "Clue found: time stopped at 7:25.",
        note: "Clue found: “where time stopped”.",
        lamp: "Clue found: four digits, like a clock would show them.",
      },
      lock: "safe", lockName: "The Safe", answer: "0725",
      exitHint: { locked: "Locked tight. It needs a key.", half: "Locked. The key is still in the safe." },
      hints: [
        "Something in this room gives you a number.",
        "The painting may be hiding something.",
        "The clock stopped for a reason — and safes like four digits.",
      ],
      particles: { color: "255, 224, 170", rise: 6, size: 1.8 },
      opener: "Find the key. Open the door. Five minutes.",
      intro: { line: "One door down. It only led here." },
      failLine: "The room keeps its secrets… this time.",
    },
    {
      id: 2, name: "The Study", sub: "Fire · books · a word",
      clues: ["bookshelf", "fireplace", "typewriter", "globe"],
      clueText: {
        bookshelf: "Clue found: every book wears a letter.",
        fireplace: "Clue found: the fire burns red → orange → yellow → white.",
        typewriter: "Clue found: “follow the colours of the fire”.",
        globe: "Clue found: four letters, no more.",
      },
      lock: "chest", lockName: "The Chest", answer: "MOTH",
      exitHint: { locked: "Bolted. Something in this room holds the key.", half: "Still bolted. The key is lying in the chest." },
      hints: [
        "The lock wants letters, and the books are wearing them.",
        "The fire does not burn one colour: it goes red, orange, yellow, white.",
        "Take the letter off the red book, then the orange, then the yellow, then the white — every spine is labelled with its colour.",
      ],
      particles: { color: "255, 170, 80", rise: 14, size: 2.1 },
      opener: "The fire is lit and the chest is locked. Five minutes.",
      intro: { line: "The corridor was short. This was at the end of it." },
      failLine: "The fire burns down. The chest stays shut.",
    },
    {
      id: 3, name: "The Cellar", sub: "Vintages · valves",
      clues: ["lantern", "winerack", "barrel", "pipes"],
      clueText: {
        lantern: "Clue found: light. Now the cellar can be read.",
        winerack: "Clue found: four vintages, four colours of wax.",
        barrel: "Clue found: “as they were laid down” — oldest first.",
        pipes: "Clue found: four valves, tagged by colour.",
      },
      lock: "pipes", lockName: "The Valve Wall", answer: ["green", "crimson", "blue", "amber"],
      exitHint: { locked: "Chained shut. A padlock the size of a fist.", half: "Still chained. The key is hanging off the pipes." },
      hints: [
        "You cannot read anything in the dark. Something here still burns.",
        "Every bottle wears a year and a colour of wax.",
        "Turn the valves oldest vintage first: 1911, 1923, 1938, 1952.",
      ],
      particles: { color: "190, 215, 235", rise: 3, size: 1.5 },
      opener: "Pitch dark. Something in here still burns. Five minutes.",
      intro: { line: "Stone steps, going down. Of course they were going down." },
      failLine: "The pipes fall silent. The gate holds.",
      dark: true,
    },
    {
      id: 4, name: "The Abandoned Train", sub: "Storm · symbols · a route",
      clues: ["ticket", "lamp", "seat", "clock", "window", "newspaper"],
      clueText: {
        ticket: "Clue found: four marks, in this order — square, triangle, diamond, circle.",
        lamp: "Clue found: circle · 3, stamped on the lamp collar.",
        seat: "Clue found: triangle · 9, on the seat plate.",
        clock: "Clue found: diamond · 6, under the dial.",
        window: "Clue found: square · 1, on the window plate.",
        newspaper: "Clue found: the night express runs to VARDEN.",
      },
      lock: "suitcase", lockName: "The Suitcase", answer: "1963",
      board: { word: "VARDEN", locked: [0, 2, 4] },
      exitHint: {
        locked: "The door will not shift. Not at this speed.",
        half: "Still shut. Whatever this train is doing, it has to stop first.",
      },
      hints: [
        "The ticket's four little marks are stamped elsewhere in this compartment — each one beside a digit.",
        "Lamp, seat, clock, window. The ticket tells you what order to read them in.",
        "The case opens on 1963. Inside is the handle — then make the board read VARDEN and the brake will answer.",
      ],
      particles: { color: "200, 220, 255", rise: 2, size: 1.3 },
      opener: "The train is moving, and nobody is driving it. Five minutes.",
      intro: { line: "The door wasn't the exit." },
      failLine: "The train does not stop. It never was going to.",
      ambience: "train",
      itemLabel: "HANDLE",
      exitReady: (s) => s.brakePulled,
      clueTotal: 6,
    },
    {
      id: 5, name: "The Gambit", sub: "Dust · rain · a mirror",
      clues: ["lamp", "table", "window", "reflection"],
      clueTotal: 4,
      clueText: {
        lamp: "Clue found: the lamp lifts off its bracket. You can carry the light.",
        table: "Clue found: four squares have been wiped clear of dust.",
        window: "Clue found: no light outside — tonight the glass is a mirror.",
        reflection: "Clue found: reversed in the glass, the marks read 1 7 8 4.",
      },
      lock: "padlock", lockName: "The Padlock", answer: "1784",
      itemLabel: "LAMP",
      exitHint: {
        locked: "The deadbolt holds. The padlock on the hasp holds it there.",
        half: "The padlock is off. The bolt will draw now.",
      },
      hints: [
        "The chessboard is not a chess problem. Stop reading the pieces and look at what they were dragged across.",
        "The marks on the board mean nothing from where you are standing. You need to see them another way.",
        "Take the lamp off its bracket, then look into the window: the glass reverses the board, and the dust reads 1784.",
      ],
      particles: { color: "210, 200, 180", rise: 4, size: 1.6 },
      opener: "One lamp, one door, and a game nobody finished. Five minutes.",
      intro: { line: "Someone was playing. Someone stopped." },
      failLine: "The lamp gutters out. The dust settles again.",
      exitReady: (s) => s.lockOpen,
    },
    {
      id: 6, name: "The Bunker", sub: "Steel · phosphor · a fix",
      clues: ["dossier", "crt", "wall", "scope"],
      clueTotal: 4,
      clueText: {
        dossier: "Clue found: three circuits are named in the dossier. The rest are isolated.",
        crt: "Clue found: the plot has three listening stations — A, B and C, in that order.",
        wall: "Clue found: three bearings, stencilled on the concrete.",
        scope: "Clue found: the three bearings cross in one cell of the plot.",
      },
      lock: "gridsafe", lockName: "The Wall Safe", answer: "D7",
      itemLabel: "CARD",
      exitHint: {
        locked: "Sealed. The slot beside the wheel is empty and the rams are still out.",
        half: "Still sealed. Whatever came out of that safe goes in the slot.",
      },
      hints: [
        "Nothing in here works until the mains are back, and only three of the six breakers belong to this room.",
        "Under the amber light the concrete is not blank. Read what is stencilled on it.",
        "Turn the scope's bearing to each stencilled number and mark it — station A first, then B, then C. Where the three lines cross is your grid reference.",
      ],
      particles: { color: "150, 255, 180", rise: 3, size: 1.2 },
      opener: "Emergency circuit only. Nothing in here has power. Five minutes.",
      intro: { line: "Down, and down, and then a door with no handle on your side." },
      failLine: "The emergency lamps keep flashing. Nobody comes.",
      breakers: [1, 2, 5],
      bearings: [152, 215, 288],
      stations: [[56, 56], [184, 56], [184, 184]],
    },
    {
      id: 7, name: "The Observatory", sub: "Brass · a dome · the sky",
      clues: ["crank", "telescope", "chart", "logbook"],
      clueTotal: 4,
      clueText: {
        crank: "Clue found: the slit is over the telescope. Starlight.",
        telescope: "Clue found: a handful of stars in a shape. Remember it exactly.",
        chart: "Clue found: the chart, and a sketch of what a lens does to a picture.",
        logbook: "Clue found: the observer's last entry.",
      },
      lock: "cabinet", lockName: "The Lens Cabinet", answer: 4,
      exitHint: {
        locked: "A hatch in the floor, and a padlock through the hasp that has not been opened in years.",
        half: "The drawer gave you something. It fits the hasp.",
      },
      hints: [
        "The dome is shut. The crank on the right wall turns it — watch the rim marks and stop when the slit sits over the telescope.",
        "What the eyepiece shows is on the star chart too — and engraved on one of the twelve drawers.",
        "Read the logbook again: everything in the glass stands on its head. Turn what you saw upside down before you choose a drawer.",
      ],
      particles: { color: "200, 214, 255", rise: 1.2, size: 1.1 },
      opener: "Cold up here. The lamp is nearly out and the dome is shut.",
      intro: { line: "A stair that goes up instead of down, and a room built to look at one thing." },
      failLine: "The oil runs out. Under the dome, nothing moves.",
      ambience: "wind",
      domeStart: 118,
      drawers: [2, 7, 4, 0, 10, 5, 8, 1, 3, 11, 6, 9],
    },
    {
      id: 8, name: "Plan B", sub: "Marble · steel · a voice in your ear",
      clues: ["envelope", "diary", "calendar", "vault", "pageB", "tiles"],
      clueTotal: 6,
      clueText: {
        envelope: "Clue found: Plan A — the vault. The combination is in the manager's head, and his head is in his diary.",
        diary: "Clue found: the manager uses his daughter's birthday for the door.",
        calendar: "Clue found: the manager draws on his calendar.",
        vault: "Plan A has failed. There is a time lock behind the door.",
        pageB: "Clue found: Plan B — the service grille, the bolt key, and something to count.",
        tiles: "Clue found: two lines of dark tiles leave the vault. Only one goes to the desk.",
      },
      lock: "boxes", lockName: "The Deposit Boxes", answer: 10,
      vaultCode: "1403",
      exitHint: (s) => !s.keyObtained
        ? "A steel grille over a service duct, bolted at four corners, and a small lamp lit on the frame — the maglock is holding."
        : "The bolts come out. The grille does not move: the maglock on the frame is still live. He said they would cut the power. Wait for it.",
      exitReady: (s) => s.keyObtained && s.powerCut,
      hints: [
        "Plan A: the manager's diary in the desk drawer says what he uses for the door, and the calendar says when that is. Day, then month.",
        "When the door fails, read page two. The bolt key is in a deposit box — he tells you how to find which one.",
        "Count the dark tiles between the vault and the DESK — not the other line. Then wait: the grille only opens once they have pulled the mains.",
      ],
      particles: { color: "255, 220, 200", rise: 0.8, size: 1.0 },
      opener: "You are in. Nobody else is. The voice in your ear says: the envelope on the desk.",
      intro: { line: "Everyone else went out the front. You were told to wait." },
      failLine: "Boots in the corridor. The voice in your ear goes quiet.",
      exitToast: "Four bolts. The grille comes away in your hands, and the duct breathes cold air at you.",
      ambience: "scanner",
      junkBoxes: [],
    },
    {
      id: 9, name: "The Clockmaker's Bench", sub: "Brass · a running clock · four empty pegs",
      clues: ["skeleton", "geartrain", "tray"],
      clueTotal: 3,
      clueText: {
        skeleton: "Clue found: the one clock still running, and its train laid open.",
        geartrain: "Clue found: the bolt is driven by a train with four empty pegs.",
        tray: "Clue found: ten loose wheels, each stamped with its count.",
      },
      lock: "geartrain", lockName: "The Gear Train", answer: [24, 12, 30, 18],
      gears: [8, 10, 12, 14, 16, 18, 20, 24, 30, 36],
      crankTeeth: 20,
      freeJams: 2,
      exitHint: (s) => "A trapdoor in the ceiling, and a bolt across it that runs down a rod to the wall. The rod goes nowhere until the train on the wall turns.",
      exitReady: (s) => s.lockOpen,
      exitToast: "The ladder unfolds and comes down to meet you.",
      hints: [
        "Eleven clocks have stopped. One has not — and its works are open to look at.",
        "The wall train wants four wheels. The running clock shows you three, in order, from the crank end.",
        "The fourth wheel is not in the clock. Only one wheel in the tray meets both the third wheel and the rack — try sizes near the third wheel's neighbour.",
      ],
      particles: { color: "255, 226, 170", rise: 0.9, size: 1.1 },
      opener: "Everything in here ticks. Nearly everything. Five minutes.",
      intro: { line: "A door at the top of a stair, and behind it, a room that will not stop counting." },
      failLine: "The cuckoo comes out one last time and does not go back in.",
      ambience: "workshop",
    },
  ];
  const lvClueTotal = (lv) => lv.clueTotal || lv.clues.length;

  // ---------------------------------------------------------------- progress
  const SAVE_KEY = "escape.progress.v1";
  const loadProgress = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}");
      return { unlocked: clamp(raw.unlocked || 1, 1, LEVELS.length), stars: raw.stars || {} };
    } catch { return { unlocked: 1, stars: {} }; }
  };
  const saveProgress = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch { /* private mode */ } };
  let progress = loadProgress();
  let selected = progress.unlocked;

  // ---------------------------------------------------------------- state
  const fresh = (levelId = 1) => ({
    levelId,
    screen: "intro",
    clues: new Set(),
    investigated: new Set(),
    attempts: 0,
    wrongAttempts: 0,
    hintsUsed: 0,
    lit: false,
    lockOpen: false,
    keyObtained: false,
    doorUnlocked: false,
    timeLeft: TOTAL_TIME,
    endAt: 0,
    timerId: null,
    completed: false,
    gameOver: false,
    input: "",
    word: ["A", "A", "A", "A"],
    dials: [0, 0, 0, 0],
    slot: 0,
    seq: [],
    board: [],
    boardSlot: 1,
    boardSet: false,
    brakePulled: false,
    lampHeld: false,
    mirrorRead: false,
    breakers: [false, false, false, false, false, false],
    powered: false,
    bearing: 0,
    station: 0,
    marks: [],
    fixed: false,
    gridA: 0,
    gridN: 0,
    wheel: 0,
    dome: 0,
    domeOpen: false,
    vaultOpen: false,
    alarm: false,
    powerCut: false,
    junk: [],
    pegs: [null, null, null, null],
    held: null,
    jams: 0,
    modal: null,
    busy: false,
  });
  let state = fresh();
  let soundOn = true;
  const level = () => LEVELS[state.levelId - 1];
  const levelEl = () => document.querySelector(`.level[data-level="${state.levelId}"]`);
  const objEl = (name) => levelEl().querySelector(`[data-object="${name}"]`);

  // ---------------------------------------------------------------- screens
  const screens = { intro: $("intro"), room: $("room"), transition: $("transition"), gameover: $("gameover"), victory: $("victory") };
  function showScreen(name) {
    state.screen = name;
    Object.entries(screens).forEach(([k, el]) => {
      if (k === name) { el.hidden = false; requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-active"))); }
      else { el.classList.remove("is-active"); setTimeout(() => { if (state.screen !== k) el.hidden = true; }, 720); }
    });
    if (name === "room") { fitStage(); particles.start(); } else particles.stop();
  }

  // ---------------------------------------------------------------- transition
  let transSkip = null;
  async function playTransition(fromId, toId) {
    const to = LEVELS[toId - 1];
    const el = screens.transition;
    $("trDone").textContent = `ROOM ${fromId} COMPLETE`;
    $("trLine").textContent = to.intro.line;
    $("trNo").textContent = `ROOM ${toId}`;
    $("trName").textContent = to.name.toUpperCase();
    el.className = "screen transition";
    showScreen("transition");
    let skipped = false;
    const skip = () => { skipped = true; };
    transSkip = skip;
    el.addEventListener("click", skip, { once: true });
    const step = async (cls, ms) => { if (skipped) return; el.classList.add(cls); await wait(ms); };
    await step("step-1", 1000);
    await step("step-2", 2400);
    await step("step-3", 900);
    if (to.ambience) sfx.ambience.start(to.ambience);
    await step("step-4", skipped ? 0 : 2800);
    transSkip = null;
    el.removeEventListener("click", skip);
    enterRoom(toId, true);
  }

  // ---------------------------------------------------------------- level select
  function renderCards() {
    const wrap = $("levelCards");
    wrap.innerHTML = "";
    LEVELS.forEach((lv) => {
      const locked = lv.id > progress.unlocked;
      const stars = progress.stars[lv.id] || 0;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "lvl-card" + (locked ? " is-locked" : "") + (lv.id === selected ? " is-selected" : "");
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(lv.id === selected));
      if (locked) b.setAttribute("aria-disabled", "true");
      const starStr = [1, 2, 3].map((i) => `<span class="${i <= stars ? "" : "dim"}">★</span>`).join("");
      b.innerHTML = `
        <span class="lc-thumb t${lv.id}"></span>
        <span class="lc-no">ROOM ${lv.id}</span>
        <span class="lc-name">${lv.name}</span>
        <span class="lc-sub">${lv.sub}</span>
        <span class="lc-stars">${stars ? starStr : locked ? "" : "not escaped yet"}</span>
        ${locked ? '<span class="lc-lock">🔒</span>' : ""}`;
      b.addEventListener("click", () => {
        if (locked) { sfx.wrong(); b.animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], 220); return; }
        selected = lv.id; sfx.click(); renderCards(); updateEnterLabel();
      });
      wrap.appendChild(b);
    });
  }
  function updateEnterLabel() { $("enterLabel").textContent = `ENTER ROOM ${selected}`; }

  // ---------------------------------------------------------------- toast
  let toastTimer = 0;
  function toast(text, ms = 2400, cls = "") {
    const t = $("toast");
    t.textContent = text;
    t.classList.toggle("is-voice", cls === "is-voice");
    t.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("is-visible"), ms);
  }

  // ---------------------------------------------------------------- stage scaling
  const stage = $("stage"), stageWrap = $("stageWrap");
  function stageSize() {
    const cs = getComputedStyle(document.documentElement);
    return { w: parseFloat(cs.getPropertyValue("--stage-w")) || 1280, h: parseFloat(cs.getPropertyValue("--stage-h")) || 720 };
  }
  function fitStage() {
    const { w, h } = stageSize();
    const hud = document.querySelector(".hud").offsetHeight || 60;
    const availW = stageWrap.clientWidth - 8;
    const availH = stageWrap.clientHeight - hud - 8;
    if (availW <= 0 || availH <= 0) return;
    const scale = Math.min(availW / w, availH / h);
    stage.style.setProperty("--scale", scale.toFixed(4));
    stage.style.marginTop = hud + "px";
    particles.resize(w, h);
  }
  window.addEventListener("resize", () => { if (state.screen === "room") { fitStage(); if (level().id === 7) syncDome(); } });
  window.addEventListener("orientationchange", () => setTimeout(fitStage, 250));

  // ---------------------------------------------------------------- particles
  const particles = (() => {
    const canvas = $("particles"), ctx = canvas.getContext("2d");
    let motes = [], raf = 0, running = false, W = 1280, H = 720, last = 0;
    let cfg = LEVELS[0].particles;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function seed() {
      const n = Math.round((W * H) / 20000);
      motes = Array.from({ length: n }, () => ({
        x: Math.random() * W, y: Math.random() * H,
        r: 0.5 + Math.random() * cfg.size,
        vx: (Math.random() - 0.5) * 6, vy: -cfg.rise - Math.random() * cfg.rise,
        a: 0.15 + Math.random() * 0.45, ph: Math.random() * Math.PI * 2,
      }));
    }
    function frame(t) {
      if (!running) return;
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      ctx.clearRect(0, 0, W, H);
      for (const m of motes) {
        m.ph += dt * 0.8;
        m.x += (m.vx + Math.sin(m.ph) * 4) * dt;
        m.y += m.vy * dt;
        if (m.y < -4) { m.y = H + 4; m.x = Math.random() * W; }
        if (m.x < -4) m.x = W + 4; else if (m.x > W + 4) m.x = -4;
        const tw = 0.6 + 0.4 * Math.sin(m.ph * 1.7);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${cfg.color}, ${(m.a * tw).toFixed(3)})`;
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    }
    return {
      setLevel(l) { cfg = l.particles; seed(); },
      resize(w, h) { W = w; H = h; canvas.width = w; canvas.height = h; seed(); },
      start() { if (reduce || running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); },
    };
  })();

  // ---------------------------------------------------------------- timer
  const timerEl = $("timer"), timerText = $("timerText"), timerRing = $("timerRing");
  const RING = 2 * Math.PI * 19;
  function renderTimer() {
    timerText.textContent = fmt(state.timeLeft);
    timerRing.style.strokeDashoffset = (RING * (1 - state.timeLeft / TOTAL_TIME)).toFixed(2);
    timerEl.classList.toggle("is-low", state.timeLeft <= 60);
    timerEl.classList.toggle("is-critical", state.timeLeft <= 10);
  }
  function startTimer() {
    stopTimer();
    state.endAt = Date.now() + TOTAL_TIME * 1000;
    state.timeLeft = TOTAL_TIME;
    renderTimer();
    state.timerId = setInterval(() => {
      const left = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
      if (left === state.timeLeft) return;
      state.timeLeft = left;
      renderTimer();
      if (left <= 10 && left > 0) sfx.tick();
      if (left === 60) toast("One minute left.");
      if (left === 0) onTimeUp();
    }, 200);
  }
  function stopTimer() { if (state.timerId) { clearInterval(state.timerId); state.timerId = null; } }
  function onTimeUp() {
    stopTimer();
    if (state.completed) return;
    state.gameOver = true;
    closeModal(); closeHints(); stopAmbient();
    sfx.gameOver();
    $("failSub").textContent = level().failLine;
    screens.room.classList.add("is-shaking");
    setTimeout(() => screens.room.classList.remove("is-shaking"), 500);
    setTimeout(() => showScreen("gameover"), 500);
  }

  // ---------------------------------------------------------------- clues
  function discover(id) {
    if (state.clues.has(id)) return;
    state.clues.add(id);
    $("cluesCount").textContent = `${state.clues.size}/${lvClueTotal(level())}`;
    toast(level().clueText[id] || "Clue found.", 3000);
    sfx.reveal();
  }
  function markInvestigated(id) {
    state.investigated.add(id);
    const el = objEl(id);
    if (el && id !== "door") el.classList.add("is-done");
  }

  // ---------------------------------------------------------------- modal
  const modal = $("modal"), modalBody = $("modalBody"), modalTitle = $("modalTitle");
  let lastFocus = null;
  function openModal(kind, title, build) {
    state.modal = kind;
    modalTitle.textContent = title;
    modalBody.innerHTML = "";
    build(modalBody);
    modal.hidden = false;
    lastFocus = document.activeElement;
    setTimeout(() => $("modalClose").focus({ preventScroll: true }), 30);
  }
  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    modalBody.innerHTML = "";
    state.modal = null;
    state.input = "";
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  modal.addEventListener("click", (e) => { if (e.target === modal) { sfx.click(); closeModal(); } });
  $("modalClose").addEventListener("click", () => { sfx.click(); closeModal(); });

  /** Clone a room object into the modal, scaled up to fit the viewport. */
  function zoomClone(name, extraClass, interactive) {
    const src = objEl(name);
    const clone = src.cloneNode(true);
    clone.removeAttribute("aria-label"); clone.setAttribute("tabindex", "-1");
    if (!interactive) clone.disabled = true; else clone.classList.add("is-interactive");
    clone.classList.remove("is-done");
    if (extraClass) clone.classList.add(extraClass);
    const wrap = document.createElement("div");
    wrap.className = "zoom";
    wrap.appendChild(clone);
    const w = src.offsetWidth, h = src.offsetHeight;
    const maxW = Math.min(window.innerWidth - 80, 700);
    const maxH = Math.max(160, window.innerHeight * 0.42);
    const z = clamp(Math.min(maxW / w, maxH / h), 0.6, 2.4);
    wrap.style.setProperty("--zoom", z.toFixed(3));
    wrap.style.width = Math.round(w * z) + "px";
    wrap.style.height = Math.round(h * z) + "px";
    return wrap;
  }
  const p = (html, cls = "modal-text") => { const el = document.createElement("p"); el.className = cls; el.innerHTML = html; return el; };

  // ---------------------------------------------------------------- inspectors
  function inspect(name) {
    if (state.busy || state.gameOver || state.completed) return;
    sfx.click();
    if (name === "door") return tryExit();
    if (level().dark && !state.lit && name !== "lantern") {
      sfx.locked();
      toast("Too dark to make anything out. Something in here must still burn.");
      return;
    }
    if (name === level().lock) return openLock();
    const fn = (INSPECT[state.levelId] || {})[name];
    if (fn) fn();
  }

  const INSPECT = {
    // ---------------- room 1 ----------------
    1: {
      painting() {
        markInvestigated("painting");
        openModal("painting", "The Painting", (body) => {
          const z = zoomClone("painting");
          body.appendChild(z);
          body.appendChild(p("A night lake under a pale moon. The varnish is old and uneven… as if someone painted <em>over</em> something in the corner."));
          const clue = p("Look closer.", "modal-clue");
          body.appendChild(clue);
          setTimeout(() => {
            z.querySelector(".painting").classList.add("is-revealed");
            objEl("painting").classList.add("is-revealed");
            clue.textContent = "A number surfaces through the varnish: 7";
            discover("painting");
          }, 900);
        });
      },
      clock() {
        markInvestigated("clock");
        openModal("clock", "The Old Clock", (body) => {
          body.appendChild(zoomClone("clock", "is-zoomed"));
          body.appendChild(p("Dust films the glass. The pendulum hangs dead still. The hands have not moved in years — they stopped at <em>7:25</em>."));
          body.appendChild(p("Where time stopped: 7 : 25", "modal-clue"));
          discover("clock");
        });
      },
      note() {
        markInvestigated("note");
        openModal("note", "A Mysterious Note", (body) => {
          body.appendChild(zoomClone("note"));
          body.appendChild(p("Hurried handwriting, the ink faded:<br><em>“The answer is hiding where time stopped.”</em>"));
          body.appendChild(p("Something in this room stopped keeping time.", "modal-clue"));
          discover("note");
        });
      },
      lamp() {
        markInvestigated("lamp");
        objEl("lamp").classList.add("is-bright");
        levelEl().querySelector("[data-marks]").classList.add("is-visible");
        openModal("lamp", "The Lamp", (body) => {
          body.appendChild(zoomClone("lamp", "is-bright"));
          body.appendChild(p("You turn the lamp up. In its warm light, faint pencil marks appear on the wall beside the desk:<br><em>_ _ : _ _</em>"));
          body.appendChild(p("Four digits — written the way a clock would show them.", "modal-clue"));
          discover("lamp");
        });
      },
    },
    // ---------------- room 2 ----------------
    2: {
      bookshelf() {
        markInvestigated("bookshelf");
        openModal("bookshelf", "The Bookshelf", (body) => {
          body.appendChild(zoomClone("bookshelf"));
          body.appendChild(p("Not one title among them — but every spine carries a single gilt letter, and the binder wrote the colour of each binding along the foot of the spine."));
          body.appendChild(p("red M · olive A · orange O · navy X · yellow T · plum S · white H · brown R", "modal-clue"));
          discover("bookshelf");
        });
      },
      fireplace() {
        markInvestigated("fireplace");
        openModal("fireplace", "The Fireplace", (body) => {
          const z = zoomClone("fireplace");
          body.appendChild(z);
          body.appendChild(p("You push the poker into the logs. The fire wakes up — and it does not stay one colour. It climbs through four of them, over and over: <em>red, then orange, then yellow, then white</em>."));
          const seq = document.createElement("div");
          seq.className = "fire-seq";
          seq.innerHTML = ["red", "orange", "yellow", "white"].map((c, i) => `<span class="s-${c}" data-name="${i + 1} · ${c}"></span>`).join("");
          body.appendChild(seq);
          sfx.fire();
          const fp = z.querySelector(".fireplace");
          const roomFp = objEl("fireplace");
          [...seq.children].forEach((sw, i) => {
            setTimeout(() => {
              sw.classList.add("on");
              fp.className = fp.className.replace(/ ?seq-\d/g, "") + " seq-" + (i + 1);
              roomFp.className = roomFp.className.replace(/ ?seq-\d/g, "") + " seq-" + (i + 1);
              sfx.tick();
              if (i === 3) {
                setTimeout(() => { fp.className = fp.className.replace(/ ?seq-\d/g, ""); roomFp.className = roomFp.className.replace(/ ?seq-\d/g, ""); }, 700);
                discover("fireplace");
              }
            }, 500 + i * 620);
          });
        });
      },
      typewriter() {
        markInvestigated("typewriter");
        sfx.typewriter();
        openModal("typewriter", "The Typewriter", (body) => {
          body.appendChild(zoomClone("typewriter"));
          body.appendChild(p("A half-finished page still in the roller. Only one line was typed, and typed hard enough to dent the paper:"));
          body.appendChild(p("“Follow the colours of the fire.”", "modal-clue"));
          discover("typewriter");
        });
      },
      globe() {
        markInvestigated("globe");
        openModal("globe", "The Globe", (body) => {
          const z = zoomClone("globe");
          body.appendChild(z);
          const ball = z.querySelector(".globe-ball");
          ball.animate([{ transform: "rotateY(0)" }, { transform: "rotateY(360deg)" }], { duration: 1400, easing: "cubic-bezier(.2,.7,.3,1)" });
          body.appendChild(p("You spin it. Something slides around inside the sphere and comes to rest — a folded slip of paper, wedged where the axis meets the shell."));
          const clue = p("…", "modal-clue");
          body.appendChild(clue);
          setTimeout(() => { clue.textContent = "“Four letters. No more.”"; discover("globe"); }, 1200);
        });
      },
    },
    // ---------------- room 3 ----------------
    3: {
      lantern() {
        markInvestigated("lantern");
        const first = !state.lit;
        state.lit = true;
        levelEl().classList.add("is-lit");
        openModal("lantern", "The Lantern", (body) => {
          body.appendChild(zoomClone("lantern"));
          if (first) {
            body.appendChild(p("The wick has been drowning in its own soot. You raise it, and the flame stands up — the whole cellar comes out of the dark."));
            body.appendChild(p("Now the labels are readable.", "modal-clue"));
            sfx.fire();
            discover("lantern");
          } else {
            body.appendChild(p("Burning steady. It will hold for another few minutes — probably."));
          }
        });
      },
      winerack() {
        markInvestigated("winerack");
        openModal("winerack", "The Wine Rack", (body) => {
          body.appendChild(zoomClone("winerack"));
          body.appendChild(p("Four bottles left. Each label still carries its year, and the colour of its wax seal written underneath."));
          body.appendChild(p("green 1911 · crimson 1923 · blue 1938 · amber 1952", "modal-clue"));
          discover("winerack");
        });
      },
      barrel() {
        markInvestigated("barrel");
        openModal("barrel", "The Barrel", (body) => {
          body.appendChild(zoomClone("barrel"));
          body.appendChild(p("An old cask, dry for decades. Someone chalked a line across the staves — the hand is shaky, the chalk still powdery."));
          body.appendChild(p("“Turn the valves as the vintages were laid down. Oldest first.”", "modal-clue"));
          discover("barrel");
        });
      },
    },
    // ---------------- room 4 ----------------
    4: {
      ticket() {
        markInvestigated("ticket");
        openModal("ticket", "The Ticket", (body) => {
          body.appendChild(zoomClone("ticket"));
          body.appendChild(p("First class. Coach 4, seat 12C, train 07 — punched twice, so somebody rode it. The destination has been rubbed almost off the card: <em>V _ R _ E _</em>."));
          body.appendChild(p("Along the foot, four marks stamped in a row: <b>■ ▲ ◆ ●</b>", "modal-clue"));
          discover("ticket");
        });
      },
      lamp() {
        markInvestigated("lamp");
        objEl("lamp").classList.add("is-bright");
        openModal("lamp", "The Overhead Lamp", (body) => {
          body.appendChild(zoomClone("lamp", "is-bright"));
          body.appendChild(p("Brass collar, glass shade, and no dust on either — somebody has cleaned this within the week. You turn the collar and the filament comes up bright."));
          body.appendChild(p("Stamped under the rim: <b>● 3</b>", "modal-clue"));
          discover("lamp");
        });
      },
      seat() {
        markInvestigated("seat");
        openModal("seat", "The Bench Seat", (body) => {
          body.appendChild(zoomClone("seat"));
          body.appendChild(p("Deep red velvet, buttoned and worn smooth at the arm. One cushion is still pressed flat in the shape of somebody sitting."));
          body.appendChild(p("A maker's plate on the frame: <b>▲ 9</b>", "modal-clue"));
          discover("seat");
        });
      },
      clock() {
        markInvestigated("clock");
        openModal("clock", "The Train Clock", (body) => {
          const z = zoomClone("clock");
          body.appendChild(z);
          const c = z.querySelector(".train-clock");
          body.appendChild(p("It will not settle. The hands jump to <em>9:15</em>, hold, then snap to <em>4:40</em> and back again. Not broken — a railway dial, showing departure and arrival at once."));
          body.appendChild(p("On the plate below the numerals: <b>◆ 6</b>", "modal-clue"));
          let n = 0;
          const t = setInterval(() => { c.classList.toggle("alt"); sfx.tick(); if (++n > 8) clearInterval(t); }, 900);
          modal.addEventListener("click", () => clearInterval(t), { once: true });
          discover("clock");
        });
      },
      window() {
        markInvestigated("window");
        openModal("window", "The Window", (body) => {
          body.appendChild(zoomClone("window"));
          body.appendChild(p("Rain, driven flat across the glass. Beyond it: black hills, telegraph poles going past far too quickly, and no lights anywhere."));
          body.appendChild(p("A maker's plate riveted to the frame: <b>■ 1</b>", "modal-clue"));
          discover("window");
        });
      },
      newspaper() {
        markInvestigated("newspaper");
        openModal("newspaper", "The Newspaper", (body) => {
          body.appendChild(zoomClone("newspaper"));
          body.appendChild(p("Yesterday's paper, folded open and pressed flat. Beside it a cup of coffee — you touch the china and it is <em>still warm</em>."));
          body.appendChild(p("“SERVICE TO VARDEN RESUMES — the night express will call at Kestrel Bay, Alder Cross and Varden, arriving 04:40.”", "modal-clue"));
          discover("newspaper");
        });
      },
      board() { openBoard(); },
      brake() { openBrake(); },
    },
    // ---------------- room 5 ----------------
    5: {
      lamp() {
        markInvestigated("lamp");
        const lamp = objEl("lamp");
        if (!state.lampHeld) {
          state.lampHeld = true;
          levelEl().classList.add("is-lamp");
          objEl("window").classList.add("is-lit");
          lamp.classList.add("is-taken");
          sfx.latch();
          const slot = $("invSlot");
          slot.innerHTML = '<span class="inv-lamp"></span>';
          slot.classList.add("has-key");
        }
        openModal("lamp", "The Gas Lamp", (body) => {
          body.appendChild(p("Cast brass, and the bracket screws have been backed most of the way out — somebody meant this lamp to come off the wall. It lifts free, still lit, hissing gently."));
          body.appendChild(p("You are carrying the light now. It will fall wherever you look.", "modal-clue"));
          discover("lamp");
        });
      },
      chessboard() {
        markInvestigated("chessboard");
        openModal("chessboard", "The Chessboard", (body) => {
          body.appendChild(zoomClone("chessboard"));
          body.appendChild(p("Black is a piece up and about to lose the exchange anyway. It could be a Sicilian; it could be two people who did not know the rules. You could stand here until morning working out the mate."));
          body.appendChild(p("It is a chessboard. That is all it is.", "modal-dud"));
        });
      },
      table() {
        markInvestigated("table");
        openModal("table", "The Table", (body) => {
          body.appendChild(p("Months of dust, thick enough to write in — and somebody has. Four squares on the board have been swept bare, not by a finger but by something heavy <em>dragged</em> across them."));
          body.appendChild(p("The clean paths have a shape. From this side of the table they are nonsense.", "modal-clue"));
          discover("table");
        });
      },
      window() {
        markInvestigated("window");
        const first = !state.clues.has("window");
        openModal("window", "The Window", (body) => {
          body.appendChild(zoomClone("window"));
          if (!state.lampHeld) {
            body.appendChild(p("Rain, hard enough to drown the street lamps. There is no light out there at all — and a pane with nothing behind it is not a window."));
            body.appendChild(p("Tonight the glass is a mirror. It is just too dark to see what it is holding.", "modal-clue"));
            if (first) discover("window");
            return;
          }
          if (first) discover("window");
          body.appendChild(p("You hold the lamp up to the pane. The glass gives the room back to you — reversed — and the light rakes across the table at an angle you could never stand at."));
          const clue = p("The dust is lit up. The clean paths are…", "modal-clue");
          body.appendChild(clue);
          setTimeout(() => {
            clue.innerHTML = "Read in the glass, left to right: <b>1 7 8 4</b>";
            state.mirrorRead = true;
            discover("reflection");
          }, 1400);
        });
      },
      // --- decoys: they are lovely, and they are worth nothing -------------
      portrait() {
        markInvestigated("portrait");
        openModal("portrait", "The Portrait", (body) => {
          body.appendChild(zoomClone("portrait"));
          body.appendChild(p("A man in a high collar, painted badly and varnished well. The eyes have that trick of following you, which is a trick of the brush and nothing more."));
          body.appendChild(p("No date, no signature, no hollow behind it.", "modal-dud"));
        });
      },
      barometer() {
        markInvestigated("barometer");
        openModal("barometer", "The Barometer", (body) => {
          body.appendChild(zoomClone("barometer"));
          body.appendChild(p("The needle is jammed hard over at STORMY, which even a broken barometer would manage tonight."));
          body.appendChild(p("It tells you about the weather. You can hear the weather.", "modal-dud"));
        });
      },
      ashtray() {
        markInvestigated("ashtray");
        openModal("ashtray", "The Ashtray", (body) => {
          body.appendChild(zoomClone("ashtray"));
          body.appendChild(p("A cigar laid across the rim, still burning at one end. Whoever left it has been gone minutes, not months — which does not square with the dust at all."));
          body.appendChild(p("Unsettling. Not useful.", "modal-dud"));
        });
      },
      books() {
        markInvestigated("books");
        openModal("books", "The Books", (body) => {
          body.appendChild(zoomClone("books"));
          body.appendChild(p("Four volumes, stacked by size: tide tables, a county history, and two on the openings — one of them face down, spine cracked, well beyond reading."));
          body.appendChild(p("Nothing is pressed between the pages. You checked.", "modal-dud"));
        });
      },
      chair() {
        markInvestigated("chair");
        openModal("chair", "The Wing Chair", (body) => {
          body.appendChild(zoomClone("chair"));
          body.appendChild(p("A coat over the back, heavy and still damp at the shoulders. The pockets are turned out. Whoever wore it in came from the rain and did not sit down for long."));
          body.appendChild(p("Empty. Every pocket.", "modal-dud"));
        });
      },
    },
    // ---------------- room 6 ----------------
    6: {
      dossier() {
        markInvestigated("dossier");
        openModal("dossier", "The Dossier", (body) => {
          body.appendChild(zoomClone("dossier"));
          body.appendChild(p("Half a page, torn off at the fold and stamped twice. Most of it is a survey of a flooded sub-level. The line that matters is the last one:"));
          body.appendChild(p("“OPS ROOM DRAWS ON <b>A2</b>, <b>B1</b> AND <b>C2</b>. ALL OTHER CIRCUITS ISOLATED — DO NOT ENERGISE.”", "modal-clue"));
          discover("dossier");
        });
      },
      crt() {
        markInvestigated("crt");
        openModal("crt", "The Monitors", (body) => {
          body.appendChild(zoomClone("crt"));
          if (!state.powered) {
            body.appendChild(p("Three tubes, all dark. The emergency circuit will run the lamps and nothing else — there is not enough on it to strike a cathode."));
            body.appendChild(p("Dead until the mains are back.", "modal-dud"));
            return;
          }
          body.appendChild(p("They come up green and stay up, humming. The left tube is holding one page of a plot log:"));
          body.appendChild(p("“TRIANGULATION — STN <b>A</b> NORTH-WEST · STN <b>B</b> NORTH-EAST · STN <b>C</b> SOUTH-EAST. MARK IN THAT ORDER.”", "modal-clue"));
          discover("crt");
        });
      },
      wall() {
        markInvestigated("wall");
        openModal("wall", "The Concrete", (body) => {
          body.appendChild(zoomClone("wall"));
          if (!state.powered) {
            body.appendChild(p("Poured concrete, form-tie holes, a water stain. Under the red lamps it is one flat colour and you cannot pick anything off it at all."));
            body.appendChild(p("Red light and grey concrete. Nothing to see.", "modal-dud"));
            return;
          }
          body.appendChild(p("Under the amber lamps the wall stops being flat. Someone stencilled on it in service paint, and the red had been swallowing it whole."));
          body.appendChild(p("Read them off the wall.", "modal-clue"));
          discover("wall");
        });
      },
      breakers() {
        markInvestigated("breakers");
        openBreakers();
      },
      scope() {
        markInvestigated("scope");
        openScope();
      },
      // --- decoys ---------------------------------------------------------
      gauges() {
        markInvestigated("gauges");
        openModal("gauges", "The Gauges", (body) => {
          body.appendChild(zoomClone("gauges"));
          body.appendChild(p("Six dials for six systems, and every needle is somewhere it should not be. Line pressure, coolant, two for a generator that is not running."));
          body.appendChild(p("They are all reading the same thing: nobody has been down here in a long time.", "modal-dud"));
        });
      },
      phone() {
        markInvestigated("phone");
        openModal("phone", "The Field Telephone", (body) => {
          body.appendChild(zoomClone("phone"));
          body.appendChild(p("Bakelite and canvas. You wind the crank and put the handset to your ear out of pure hope."));
          body.appendChild(p("The line is dead. It has been cut, not disconnected.", "modal-dud"));
        });
      },
      helmet() {
        markInvestigated("helmet");
        openModal("helmet", "The Helmet", (body) => {
          body.appendChild(zoomClone("helmet"));
          body.appendChild(p("A steel helmet on its side by the wall, chinstrap still buckled. Somebody took it off in a hurry and did not come back for it."));
          body.appendChild(p("Empty. Nothing written inside the liner either.", "modal-dud"));
        });
      },
    },
    // ---------------- room 7 ----------------
    7: {
      crank() {
        markInvestigated("crank");
        openCrank();
      },
      telescope() {
        markInvestigated("telescope");
        openEyepiece();
      },
      chart() {
        markInvestigated("chart");
        openModal("chart", "The Star Chart", (body) => {
          const sheet = document.createElement("div");
          sheet.className = "chart-big";
          sheet.innerHTML = '<div class="ch-title">FIGURES OF THE NORTHERN SKY · FOR CHECKING THE GLASS</div><div class="ch-grid" id="chGrid"></div><div class="ch-optic">' + OPTIC_SVG + '<span>the tube, in section</span></div>';
          body.appendChild(sheet);
          renderChart(sheet.querySelector("#chGrid"));
          body.appendChild(p("Twelve figures the old man used to test the glass by, inked and named. In the corner he has sketched the telescope itself in section — the lens, and the light going through it."));
          body.appendChild(p("An arrow goes into the lens one way, and comes out the other side… look at the sketch.", "modal-clue"));
          discover("chart");
        });
      },
      logbook() {
        markInvestigated("logbook");
        openModal("logbook", "The Logbook", (body) => {
          body.appendChild(zoomClone("logbook", "is-openbook"));
          body.appendChild(p("Ruled pages, one line a night, most of them <em>cloud</em>. The last entry is in a firmer hand:"));
          body.appendChild(p("“Clear at last. Found her again above the slit and drew her in the drawer book — then took the wrong drawer twice, like a first-year. Three years, and I still forget that <b>everything in the glass stands on its head</b>.”", "modal-clue"));
          discover("logbook");
        });
      },
      // --- decoys ---------------------------------------------------------
      shelf() {
        markInvestigated("shelf");
        openModal("shelf", "The Bookshelf", (body) => {
          body.appendChild(zoomClone("shelf"));
          body.appendChild(p("Ephemerides, three shelves of them, a century of tables of where things would be. You pull a few. Numbers, all of it, none of them tonight's."));
          body.appendChild(p("Nothing hidden behind them, either. You check.", "modal-dud"));
        });
      },
      sextant() {
        markInvestigated("sextant");
        openModal("sextant", "The Sextant", (body) => {
          body.appendChild(zoomClone("sextant"));
          body.appendChild(p("Brass, with a bone handle worn pale. The arm reads whatever it last read. You could take a height with it, if you were at sea and it was noon."));
          body.appendChild(p("It is not noon, and you are not at sea.", "modal-dud"));
        });
      },
      clock() {
        markInvestigated("clock");
        openModal("clock", "The Clock", (body) => {
          body.appendChild(zoomClone("clock"));
          body.appendChild(p("A tall case clock with a painted moon in the arch of the dial. The pendulum still swings — somebody wound it, and not so long ago."));
          body.appendChild(p("It keeps time. Only that.", "modal-dud"));
        });
      },
      orrery() {
        markInvestigated("orrery");
        openModal("orrery", "The Orrery", (body) => {
          body.appendChild(zoomClone("orrery"));
          body.appendChild(p("Brass planets on brass arms round a brass sun. Turn the little handle and they go round, each at its own pace, the small ones hurrying."));
          body.appendChild(p("Beautiful. It tells you nothing about tonight.", "modal-dud"));
        });
      },
      globe() {
        markInvestigated("globe");
        openModal("globe", "The Moon Globe", (body) => {
          body.appendChild(zoomClone("globe"));
          body.appendChild(p("The moon on a stand, every sea and crater lettered in a tiny hand. Half of it is blank — the side nobody had seen when it was made."));
          body.appendChild(p("Nothing on it points anywhere.", "modal-dud"));
        });
      },
      stove() {
        markInvestigated("stove");
        openModal("stove", "The Stove", (body) => {
          body.appendChild(zoomClone("stove"));
          body.appendChild(p("A squat iron stove, long cold. You open the door out of habit. Ash, and a burnt corner of paper with nothing left on it."));
          body.appendChild(p("Cold. Whoever was here let it go out.", "modal-dud"));
        });
      },
    },
    // ---------------- room 8 ----------------
    8: {
      envelope() {
        markInvestigated("envelope");
        openModal("envelope", "The Envelope", (body) => {
          const env = document.createElement("div");
          env.className = "env-big" + (state.alarm ? " is-b" : "");
          env.innerHTML = `
            <div class="env-page a"><b>PLAN A</b>
              <p>The vault. The manager keeps the combination in his head, and his head in his diary — desk drawer, left side. Four wheels: <em>day, then month</em>. He is a sentimental man. Use that.</p>
              <p>Bag on the floor is ours. Leave it. Nothing in it we cannot get again.</p>
            </div>
            <div class="env-page b"><b>PLAN B</b><i class="env-wax"></i>
              <p>If you are reading this, the door said no. I knew it might: there is a time lock behind it that nobody at the branch told me about, and I do not like being told nothing.</p>
              <p>They will not cut the vault open — they will freeze it. Mains off, from the street. When the mains go, the maglock on the <em>service grille</em> by the floor dies with them. The grille is bolted. The bolt key is in one of the boxes we drilled.</p>
              <p>Which box: from the vault door there are two lines of dark tiles in the floor. Follow the one that ends at the <em>desk</em>, and count the tiles. I counted them that morning, twice. Now you count them.</p>
            </div>`;
          body.appendChild(env);
          if (!state.alarm) {
            body.appendChild(p("Two pages. The second is folded shut under a blob of wax, and in his hand across the fold: <em>NOT UNTIL THE DOOR SAYS NO.</em>"));
            body.appendChild(p("You could break the wax. He would know.", "modal-dud"));
            discover("envelope");
            return;
          }
          body.appendChild(p("The wax cracks under your thumb. Page two was written before any of this, in the same steady hand."));
          body.appendChild(p("Two lines of tiles. The one to the desk. Count.", "modal-clue"));
          discover("envelope");
          discover("pageB");
          objEl("envelope").classList.add("is-read");
        });
      },
      diary() {
        markInvestigated("diary");
        openModal("diary", "The Desk Drawer", (body) => {
          const d = document.createElement("div");
          d.className = "diary-big";
          d.innerHTML = `<div class="dy-page"><span class="dy-date">Tuesday</span>
            <p>Ana's birthday again. Cake at the office — the girls sang, I stood there like a post. Nine. Nine already.</p>
            <p>I have started using it for the door. Ashamed how long I forgot my own daughter's birthday, so now the door makes me remember it every morning: day and month, the way she writes it on her drawings.</p>
            <p class="dy-faint">Car in for its service Thursday. Ring the insurers about the thing on the 22nd.</p></div>`;
          body.appendChild(d);
          body.appendChild(p("A pocket diary, this year's, most pages blank. One entry is written all the way down the page."));
          body.appendChild(p("Her birthday. No date written — he does not need one. He has a calendar for that.", "modal-clue"));
          discover("diary");
        });
      },
      calendar() {
        markInvestigated("calendar");
        openModal("calendar", "The Calendar", (body) => {
          const c = document.createElement("div");
          c.className = "cal-big";
          c.innerHTML = '<div class="cal-sheet"><b class="cal-month">MARCH</b><span class="cal-grid" id="calBig"></span></div>';
          body.appendChild(c);
          renderCalendar(c.querySelector("#calBig"), true);
          body.appendChild(p("A bank calendar, one month to a page, and the manager draws on it instead of writing. A car. A cake. A cross. A telephone."));
          body.appendChild(p("A man who draws a cake on a day has a reason.", "modal-clue"));
          discover("calendar");
        });
      },
      vault() {
        markInvestigated("vault");
        openVault();
      },
      tiles() {
        markInvestigated("tiles");
        openModal("tiles", "The Floor", (body) => {
          body.appendChild(zoomClone("tiles", "is-plan"));
          body.appendChild(p("Marble, laid in squares, and set into it two lines of darker stone that both start at the vault's threshold. One runs left, to the deposit boxes. One runs right, to the desk."));
          body.appendChild(p(state.alarm ? "He said: the one that ends at the desk. Count them." : "Decorative, probably. Somebody paid for it.", state.alarm ? "modal-clue" : "modal-dud"));
          if (state.alarm) discover("tiles");
        });
      },
      cctv() {
        markInvestigated("cctv");
        openModal("cctv", "The Monitors", (body) => {
          body.appendChild(zoomClone("cctv"));
          if (state.powerCut) { body.appendChild(p("Three black screens. The scanner underneath is on its own battery, hissing.")); body.appendChild(p("Nothing to see. Everything to hear.", "modal-dud")); return; }
          if (state.alarm) { body.appendChild(p("Corridor, corridor, front steps. The front steps have lights on them now, blue and white, and a shape getting out of a car.")); body.appendChild(p("They are here. He said they would be.", "modal-dud")); return; }
          body.appendChild(p("Three feeds: the corridor, the corridor from the other end, the front steps. Nothing moves in any of them. The scanner under the desk is turned low, muttering to itself about a stolen bicycle."));
          body.appendChild(p("Quiet. For now.", "modal-dud"));
        });
      },
      // --- decoys ---------------------------------------------------------
      phone() {
        markInvestigated("phone");
        openModal("phone", "The Telephone", (body) => {
          body.appendChild(zoomClone("phone"));
          body.appendChild(p("A desk phone with a line of speed-dial buttons, every label worn blank. You lift the handset. Dial tone."));
          body.appendChild(p("Who would you call.", "modal-dud"));
        });
      },
      mug() {
        markInvestigated("mug");
        openModal("mug", "The Mug", (body) => {
          body.appendChild(zoomClone("mug"));
          body.appendChild(p("Half a coffee, cold, with a skin on it. WORLD'S OKAYEST MANAGER, in letters that have been through the dishwasher too often."));
          body.appendChild(p("Nothing under it. You check.", "modal-dud"));
        });
      },
      coat() {
        markInvestigated("coat");
        openModal("coat", "The Coat", (body) => {
          body.appendChild(zoomClone("coat"));
          body.appendChild(p("The manager's overcoat on a stand. Wallet in the inside pocket: a staff pass with a six-digit number, a photo of a small girl with a paper crown, forty in notes."));
          body.appendChild(p("You put the wallet back. The girl in the crown is the only thing in it that matters, and she is not a number.", "modal-dud"));
        });
      },
      bag() {
        markInvestigated("bag");
        openModal("bag", "The Duffel Bag", (body) => {
          body.appendChild(zoomClone("bag"));
          body.appendChild(p("Ours. Drill bits, a coil of cable, gloves, and under all that, bundles of paper that were somebody's tomorrow. He said to leave it."));
          body.appendChild(p("You leave it.", "modal-dud"));
        });
      },
      extinguisher() {
        markInvestigated("extinguisher");
        openModal("extinguisher", "The Extinguisher", (body) => {
          body.appendChild(zoomClone("extinguisher"));
          body.appendChild(p("Red cylinder, inspection tag punched last spring. Full. You could knock a man over with it."));
          body.appendChild(p("There is nobody to knock over. Yet.", "modal-dud"));
        });
      },
    },
    // ---------------- room 9 ----------------
    9: {
      skeleton() {
        markInvestigated("skeleton");
        openModal("skeleton", "The Skeleton Clock", (body) => {
          body.appendChild(zoomClone("skeleton", "is-close"));
          body.appendChild(p("Under the dome, a clock with no case at all — every wheel on show, and every wheel still turning. He was working on it. It is the only thing in the room that has not stopped."));
          body.appendChild(p("Three wheels in a row, each stamped with its count, each one biting the next.", "modal-clue"));
          discover("skeleton");
        });
      },
      tray() {
        markInvestigated("tray");
        discover("tray");
        openLock();
      },
      clocks() {
        markInvestigated("clocks");
        openModal("clocks", "The Wall of Clocks", (body) => {
          body.appendChild(zoomClone("clocks"));
          body.appendChild(p("Eleven customers' clocks, tagged and hung in a row, every one of them stopped — at eleven different times. You read them all twice. They are the times they stopped, and nothing else."));
          body.appendChild(p("Dead. All of them.", "modal-dud"));
        });
      },
      cuckoo() {
        markInvestigated("cuckoo");
        openModal("cuckoo", "The Cuckoo Clock", (body) => {
          body.appendChild(zoomClone("cuckoo"));
          body.appendChild(p("Black Forest work, weights on chains, a little door above the dial. It runs, and it comes out to tell you about every minute you have lost."));
          body.appendChild(p("Nothing behind the little door but the bird.", "modal-dud"));
        });
      },
      watch() {
        markInvestigated("watch");
        openModal("watch", "The Pocket Watch", (body) => {
          body.appendChild(zoomClone("watch"));
          body.appendChild(p("A silver hunter, lid open. Engraved inside: <em>to be collected Tuesday</em>. Whoever's Tuesday that was, it has been and gone."));
          body.appendChild(p("Stopped, like the others.", "modal-dud"));
        });
      },
      loupe() {
        markInvestigated("loupe");
        openModal("loupe", "The Loupe", (body) => {
          body.appendChild(zoomClone("loupe"));
          body.appendChild(p("A jeweller's loupe on a bent wire. Through it, the grain of the bench looks like a landscape."));
          body.appendChild(p("It makes small things bigger. It does not make them mean anything.", "modal-dud"));
        });
      },
      oilcan() {
        markInvestigated("oilcan");
        openModal("oilcan", "The Oil Can", (body) => {
          body.appendChild(zoomClone("oilcan"));
          body.appendChild(p("A brass oiler with a long thin spout. A drop comes out on your thumb, clear and slow."));
          body.appendChild(p("Nothing in here needs oil. It needs wheels.", "modal-dud"));
        });
      },
      winder() {
        markInvestigated("winder");
        openModal("winder", "The Spring Winder", (body) => {
          body.appendChild(zoomClone("winder"));
          body.appendChild(p("A clamp and a crank for coiling mainsprings, the sort of tool that takes a finger off if you are careless."));
          body.appendChild(p("No spring in it.", "modal-dud"));
        });
      },
      drawer() {
        markInvestigated("drawer");
        openModal("drawer", "The Bench Drawer", (body) => {
          body.appendChild(zoomClone("drawer"));
          body.appendChild(p("Clock hands, hundreds of them, sorted by length into little tin compartments. Hour hands, minute hands, one long thin second hand like a needle."));
          body.appendChild(p("Hands, but nothing for them to turn on.", "modal-dud"));
        });
      },
    },
  };

  // ---------------------------------------------------------------- locks
  function openLock() {
    const lv = level();
    markInvestigated(lv.lock);
    if (lv.lock === "pipes") discover("pipes");
    openModal("lock", lv.lockName, (body) => {
      if (lv.lock === "safe") buildSafe(body);
      else if (lv.lock === "chest") buildChest(body);
      else if (lv.lock === "suitcase") buildCase(body);
      else if (lv.lock === "padlock") buildPadlock(body);
      else if (lv.lock === "gridsafe") buildBankSafe(body);
      else if (lv.lock === "cabinet") buildCabinet(body);
      else if (lv.lock === "boxes") buildBoxes(body);
      else if (lv.lock === "geartrain") buildGeartrain(body);
      else buildValves(body);
    });
  }

  /* ---------- room 1: four-digit keypad ---------- */
  function buildSafe(body) {
    body.appendChild($("tplSafe").content.cloneNode(true));
    const big = $("safeBig");
    if (state.lockOpen) {
      big.classList.add("is-unlocking", "is-open");
      big.querySelector(".safe-big-door").style.transition = "none";
      $("lockText").textContent = state.keyObtained ? "The safe is empty now." : "The door hangs open. Something glints inside.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    $("keypad").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-key]");
      if (b) pressKey(b.dataset.key);
    });
    wireKey();
    renderKeypad();
  }
  function renderKeypad() { const d = $("keypadDigits"); if (d) d.textContent = state.input.padEnd(4, "_"); }
  function flashKey(k) {
    const b = document.querySelector(`#keypad button[data-key="${k}"]`);
    if (!b) return;
    b.classList.add("is-pressed");
    setTimeout(() => b.classList.remove("is-pressed"), 110);
  }
  function pressKey(k) {
    if (state.modal !== "lock" || level().lock !== "safe" || state.lockOpen || state.busy) return;
    flashKey(k);
    if (k === "clear") { state.input = ""; sfx.key(); renderKeypad(); return; }
    if (k === "back") { state.input = state.input.slice(0, -1); sfx.key(); renderKeypad(); return; }
    if (k === "enter") return submitCode();
    if (/^\d$/.test(k) && state.input.length < 4) { state.input += k; sfx.key(); renderKeypad(); }
  }
  function submitCode() {
    if (state.input.length < 4) { sfx.wrong(); nudge(".keypad-panel"); return; }
    state.attempts++;
    if (state.input === level().answer) return solveLock();
    lockFailed(() => {
      const disp = $("keypadDisplay");
      disp.classList.add("is-error");
      nudge(".keypad-panel");
      setTimeout(() => { disp.classList.remove("is-error"); state.input = ""; renderKeypad(); }, 700);
    });
  }

  /* ---------- room 2: four-letter word lock ---------- */
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function buildChest(body) {
    body.appendChild($("tplChest").content.cloneNode(true));
    const big = $("chestBig");
    if (state.lockOpen) {
      big.classList.add("is-open");
      big.querySelector(".chest-big-lid").style.transition = "none";
      $("lockText").textContent = state.keyObtained ? "Empty — only old velvet." : "The lid stands open. A brass key lies on the velvet.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    wireDials(body, "letters");
    $("wordSubmit").addEventListener("click", submitWord);
    wireKey();
    renderWord();
  }
  /* ---------- room 4: four-digit rotary case ---------- */
  function buildCase(body) {
    body.appendChild($("tplSuitcase").content.cloneNode(true));
    const big = $("caseBig");
    if (state.lockOpen) {
      big.classList.add("is-open");
      big.querySelector(".case-big-lid").style.transition = "none";
      $("lockText").textContent = state.keyObtained ? "Only the lining and an empty strap." : "The lid stands open. A brass handle is strapped into the lining.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    wireDials(body, "digits");
    $("wordSubmit").addEventListener("click", submitWord);
    wireKey();
    renderWord();
  }
  function wireDials(body, kind) {
    const wl = $("wordlock");
    wl.dataset.kind = kind;
    wl.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-dir]");
      if (btn) { const d = btn.closest(".dial"); state.slot = +d.dataset.slot; rollDial(state.slot, +btn.dataset.dir); return; }
      const dial = e.target.closest(".dial");
      if (dial) { state.slot = +dial.dataset.slot; renderWord(); }
    });
  }
  const isDigits = () => level().lock === "suitcase" || level().lock === "padlock" || state.modal === "vault";
  const wheel = () => (isDigits() ? state.dials : state.word);
  function renderWord() {
    const wl = $("wordlock");
    if (!wl) return;
    const w = wheel();
    [...wl.querySelectorAll(".dial")].forEach((d, i) => {
      d.querySelector(".d-letter").textContent = w[i];
      d.classList.toggle("is-active", i === state.slot);
    });
  }
  function rollDial(slot, dir) {
    if ((state.modal === "vault" ? state.vaultOpen : state.lockOpen) || state.busy) return;
    if (isDigits()) state.dials[slot] = (state.dials[slot] + dir + 10) % 10;
    else { const i = LETTERS.indexOf(state.word[slot]); state.word[slot] = LETTERS[(i + dir + 26) % 26]; }
    sfx.dial();
    renderWord();
    const d = document.querySelector(`.dial[data-slot="${slot}"]`);
    if (d) { d.classList.remove("rolled"); void d.offsetWidth; d.classList.add("rolled"); }
  }
  function typeChar(ch) {
    if (state.lockOpen || state.busy) return;
    if (isDigits()) { if (!/^\d$/.test(ch)) return; state.dials[state.slot] = +ch; }
    else { if (!/^[A-Z]$/.test(ch)) return; state.word[state.slot] = ch; }
    sfx.dial();
    state.slot = Math.min(3, state.slot + 1);
    renderWord();
  }
  function submitWord() {
    if (state.lockOpen || state.busy) return;
    state.attempts++;
    if (wheel().join("") === level().answer) return solveLock();
    lockFailed(() => {
      const wl = $("wordlock");
      wl.classList.add("is-error");
      nudge("#wordlock");
      setTimeout(() => {
        wl.classList.remove("is-error");
        if (isDigits()) state.dials = [0, 0, 0, 0]; else state.word = ["A", "A", "A", "A"];
        state.slot = 0; renderWord();
      }, 800);
    });
  }

  /* ---------- room 5: brass combination padlock ---------- */
  function buildPadlock(body) {
    body.appendChild($("tplPadlock").content.cloneNode(true));
    const big = $("lockBig");
    if (state.lockOpen) {
      big.classList.add("is-open");
      big.querySelector(".lb-shackle").style.transition = "none";
      $("lockText").textContent = "Open. The shackle is out of the hasp and the bolt will draw.";
      $("wordSubmit").disabled = true;
    }
    wireDials(body, "digits");
    $("wordSubmit").addEventListener("click", submitWord);
    renderWord();
  }

  /* ---------- room 6: the breaker panel ---------- */
  function openBreakers() {
    openModal("breakers", "The Breaker Panel", (body) => {
      const z = zoomClone("breakers", null, true);
      body.appendChild(z);
      const panel = z.querySelector(".breakers");
      panel.addEventListener("click", (e) => {
        const sw = e.target.closest(".bp-sw");
        if (sw) throwBreaker(+sw.dataset.sw, panel);
      });
      body.appendChild(p(state.powered
        ? "The mains are up. The room has stopped screaming at you in red."
        : "Six breakers, and the label on the box is no help at all — every one of them is just a circuit number. Three of them belong to this room. The others feed a level that flooded in 1978."));
      const t = p(state.powered ? "MAINS LIVE" : "EMERGENCY CIRCUIT ONLY", "modal-clue");
      t.id = "bkStatus";
      body.appendChild(t);
      syncBreakers(panel);
    });
  }
  function syncBreakers(panel) {
    const room = objEl("breakers");
    [room, panel].forEach((el) => {
      if (!el) return;
      el.querySelectorAll(".bp-sw").forEach((sw, i) => sw.classList.toggle("on", !!state.breakers[i]));
    });
  }
  function throwBreaker(i, panel) {
    if (state.powered || state.busy) return;
    const want = level().breakers;
    if (!want.includes(i)) {
      // a circuit that is not ours: the whole board drops out
      state.breakers = [false, false, false, false, false, false];
      state.wrongAttempts++; state.attempts++;
      sfx.wrong(); sfx.locked();
      syncBreakers(panel);
      const room = objEl("breakers");
      [room, panel].forEach((el) => { if (!el) return; el.classList.remove("is-tripped"); void el.offsetWidth; el.classList.add("is-tripped"); });
      screens.room.classList.add("is-shaking");
      setTimeout(() => screens.room.classList.remove("is-shaking"), 500);
      const t = $("bkStatus");
      if (t) t.textContent = "OVERLOAD — BOARD TRIPPED. ALL CIRCUITS OPEN.";
      return;
    }
    state.breakers[i] = !state.breakers[i];
    sfx.latch();
    syncBreakers(panel);
    if (want.every((k) => state.breakers[k])) powerUp();
  }
  async function powerUp() {
    state.powered = true;
    state.busy = true;
    state.attempts++;
    sfx.correct();
    const t = $("bkStatus");
    if (t) t.textContent = "MAINS LIVE";
    levelEl().classList.add("is-powered");
    ["wall", "crt", "scope", "gauges", "gridsafe", "phone", "breakers"].forEach((n) => {
      const e = objEl(n); if (e) e.classList.add("is-lit");
    });
    sfx.steam();
    await wait(700);
    sfx.announce();
    toast("The mains come up. The lamps go over to amber.", 3600);
    await wait(900);
    state.busy = false;
  }

  /* ---------- room 6: the plotting scope ---------- */
  const STN = ["A", "B", "C"];
  function openScope() {
    openModal("scope", "The Plotting Scope", (body) => {
      const z = zoomClone("scope", null, true);
      body.appendChild(z);
      const sc = z.querySelector(".scope");
      if (!state.powered) {
        body.appendChild(p("A plotting scope the size of a dinner plate, and not a spark in it. The phosphor is cold."));
        body.appendChild(p("Dead until the mains are back.", "modal-dud"));
        return;
      }
      const bar = document.createElement("div");
      bar.className = "scope-bar";
      bar.innerHTML = '<button type="button" class="btn btn-ghost" id="scMark">MARK</button>' +
        '<span class="sc-stn" id="scStn">STN A</span>' +
        '<button type="button" class="btn btn-ghost" id="scClear">CLEAR</button>';
      body.appendChild(bar);
      body.appendChild(p("Drag the face to swing the bearing arm, then MARK it. The arm swings from whichever station you are working — the plot log said which order to take them in."));
      const note = p("", "modal-clue"); note.id = "scNote"; body.appendChild(note);
      wireScope(sc);
      $("scMark").addEventListener("click", () => markBearing(sc));
      $("scClear").addEventListener("click", () => { state.marks = []; state.station = 0; state.fixed = false; syncScope(sc); sfx.dial(); });
      syncScope(sc);
    });
  }
  function wireScope(sc) {
    const face = sc.querySelector(".sc-face");
    let dragging = false;
    const setFrom = (e) => {
      const r = face.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      let b = Math.round(Math.atan2(dx, -dy) * 180 / Math.PI);
      if (b < 0) b += 360;
      state.bearing = b;
      syncScope(sc);
    };
    face.addEventListener("pointerdown", (e) => { if (state.fixed) return; dragging = true; face.setPointerCapture(e.pointerId); setFrom(e); e.preventDefault(); });
    face.addEventListener("pointermove", (e) => { if (dragging) setFrom(e); });
    face.addEventListener("pointerup", () => { dragging = false; });
    face.addEventListener("pointercancel", () => { dragging = false; });
  }
  function syncScope(sc) {
    const lv = level();
    const [sx, sy] = lv.stations[Math.min(2, state.marks.length)];
    [objEl("scope"), sc].forEach((el) => {
      if (!el) return;
      el.style.setProperty("--brg", state.bearing);
      el.style.setProperty("--sx", sx + "px");
      el.style.setProperty("--sy", sy + "px");
      el.classList.toggle("is-live", state.powered && !state.fixed);
      el.classList.toggle("mk1", state.marks.length > 0);
      el.classList.toggle("mk2", state.marks.length > 1);
      el.classList.toggle("mk3", state.marks.length > 2);
      el.classList.toggle("is-fixed", state.fixed);
      const r = el.querySelector("[data-read]");
      if (r) r.textContent = state.fixed ? "FIX" : String(state.bearing).padStart(3, "0");
    });
    const stn = $("scStn");
    if (stn) stn.textContent = state.fixed ? "PLOT FIXED" : "STN " + STN[Math.min(2, state.marks.length)];
  }
  function markBearing(sc) {
    if (state.fixed || state.busy) return;
    const lv = level();
    const want = lv.bearings[state.marks.length];
    state.attempts++;
    const off = Math.abs(((state.bearing - want + 540) % 360) - 180);
    if (off <= 3) {
      state.marks.push(state.bearing);
      sfx.valve();
      syncScope(sc);
      const note = $("scNote");
      if (state.marks.length === 3) {
        state.fixed = true;
        state.busy = true;
        sfx.correct();
        syncScope(sc);
        if (note) note.textContent = "Three bearings, and they agree. One cell of the plot is lit.";
        discover("scope");
        toast("The plot has a fix.", 3600);
        setTimeout(() => { state.busy = false; }, 900);
      } else if (note) {
        note.textContent = "Marked. Station " + STN[state.marks.length] + " next.";
      }
      return;
    }
    state.wrongAttempts++;
    sfx.wrong();
    const face = sc.querySelector(".sc-face");
    face.classList.remove("is-bad"); void face.offsetWidth; face.classList.add("is-bad");
    const note = $("scNote");
    if (note) note.textContent = "No contact on that bearing. The arm swings back.";
  }

  /* ---------- room 6: the grid-reference safe ---------- */
  const GRID_L = "ABCDEFGH";
  function buildBankSafe(body) {
    body.appendChild($("tplBankSafe").content.cloneNode(true));
    const big = $("grSafe");
    if (state.lockOpen) {
      big.classList.add("is-open");
      big.querySelector(".gr-door").style.transition = "none";
      $("lockText").textContent = state.keyObtained ? "Empty. Steel shelf, nothing on it." : "Open. There is one thing on the shelf.";
      $("wordSubmit").disabled = true;
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    big.querySelectorAll(".gr-knob").forEach((k) => {
      k.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-dir]");
        if (!b || state.lockOpen) return;
        const d = +b.dataset.dir;
        if (k.dataset.knob === "a") state.gridA = (state.gridA + d + 8) % 8;
        else state.gridN = (state.gridN + d + 8) % 8;
        sfx.dial();
        renderGrid();
      });
    });
    $("wordSubmit").addEventListener("click", submitGrid);
    wireKey();
    renderGrid();
  }
  function renderGrid() {
    const a = document.querySelector("[data-gra]"), n = document.querySelector("[data-grn]");
    if (a) a.textContent = GRID_L[state.gridA];
    if (n) n.textContent = String(state.gridN + 1);
  }
  function submitGrid() {
    if (state.lockOpen || state.busy) return;
    state.attempts++;
    if (GRID_L[state.gridA] + (state.gridN + 1) === level().answer) return solveLock();
    lockFailed(() => {
      const w = document.querySelector(".gr-window");
      w.classList.add("is-error");
      nudge(".gr-panel");
      setTimeout(() => { w.classList.remove("is-error"); state.gridA = 0; state.gridN = 0; renderGrid(); }, 800);
    });
  }

  /* ---------- room 3: valve order ---------- */
  function buildValves(body) {
    body.appendChild($("tplValves").content.cloneNode(true));
    const wall = $("valveWall");
    if (state.lockOpen) {
      wall.classList.add("is-open");
      $("lockText").textContent = state.keyObtained ? "The pipes are silent now." : "The water is gone. An iron key hangs where it dropped.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
      wall.querySelectorAll(".bigvalve").forEach((b) => { b.classList.add("turned"); b.disabled = true; });
      markValveDots(4);
    }
    wall.addEventListener("click", (e) => {
      const b = e.target.closest(".bigvalve");
      if (b) turnValve(b.dataset.valve);
    });
    wireKey();
    markValveDots(state.seq.length);
  }
  function markValveDots(n, error) {
    const row = $("valveOrder");
    if (!row) return;
    row.classList.toggle("is-error", !!error);
    [...row.children].forEach((d, i) => d.classList.toggle("on", i < n));
  }
  function turnValve(colour) {
    if (state.lockOpen || state.busy || state.seq.includes(colour)) return;
    const btn = document.querySelector(`.bigvalve[data-valve="${colour}"]`);
    state.seq.push(colour);
    if (btn) btn.classList.add("turned");
    sfx.valve();
    markValveDots(state.seq.length);
    if (state.seq.length < 4) return;
    state.attempts++;
    const ok = state.seq.every((c, i) => c === level().answer[i]);
    if (ok) return solveLock();
    lockFailed(() => {
      const wall = $("valveWall");
      sfx.steam();
      $("steam").classList.remove("go"); void $("steam").offsetWidth; $("steam").classList.add("go");
      wall.classList.add("is-shaking");
      markValveDots(4, true);
      setTimeout(() => {
        wall.classList.remove("is-shaking");
        wall.querySelectorAll(".bigvalve").forEach((b) => b.classList.remove("turned"));
        state.seq = [];
        markValveDots(0);
      }, 900);
    });
  }

  /* ---------- room 7: the sky ---------- */
  // twelve figures, drawn on a 100×100 field. 8 is 4 turned on its head — the trap.
  const SKY = [
    { name: "The Ladle",   s: [[14,32],[34,36],[54,42],[68,58],[86,52],[82,78],[60,80]],       e: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,3]] },
    { name: "The Crown",   s: [[12,72],[28,34],[46,62],[62,28],[78,60],[90,32]],               e: [[0,1],[1,2],[2,3],[3,4],[4,5]] },
    { name: "The Arrow",   s: [[12,52],[38,52],[64,52],[88,52],[72,34],[72,70]],               e: [[0,1],[1,2],[2,3],[3,4],[3,5]] },
    { name: "The Serpent", s: [[10,80],[28,58],[44,70],[60,44],[76,56],[90,26]],               e: [[0,1],[1,2],[2,3],[3,4],[4,5]] },
    { name: "The Heron",   s: [[18,78],[34,58],[50,62],[62,40],[80,30],[86,14],[70,20]],       e: [[0,1],[1,2],[2,3],[3,4],[4,5],[4,6]] },
    { name: "The Kite",    s: [[50,10],[74,38],[50,60],[26,38],[42,80],[58,92]],               e: [[0,1],[1,2],[2,3],[3,0],[2,4],[4,5]] },
    { name: "The Anchor",  s: [[50,12],[50,40],[50,70],[24,60],[76,60],[36,84],[64,84]],       e: [[0,1],[1,2],[3,5],[5,2],[2,6],[6,4]] },
    { name: "The Scales",  s: [[50,14],[50,50],[20,40],[80,40],[12,64],[28,64],[72,64],[88,64]], e: [[0,1],[0,2],[0,3],[2,4],[2,5],[3,6],[3,7]] },
    { name: "The Diver",   s: [[82,22],[66,42],[50,38],[38,60],[20,70],[14,86],[30,80]],       e: [[0,1],[1,2],[2,3],[3,4],[4,5],[4,6]] },
    { name: "The Fish",    s: [[10,50],[30,30],[56,32],[76,50],[56,68],[30,70],[92,32],[92,68]], e: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,0],[3,6],[3,7]] },
    { name: "The Twins",   s: [[24,14],[24,50],[24,86],[76,14],[76,50],[76,86]],               e: [[0,1],[1,2],[3,4],[4,5],[1,4]] },
    { name: "The Plough",  s: [[10,30],[30,26],[50,30],[68,42],[80,64],[92,80],[62,66]],       e: [[0,1],[1,2],[2,3],[3,4],[4,5],[3,6]] },
  ];
  function skySVG(pat, opts = {}) {
    const { inverted = false, cls = "", field = false } = opts;
    const pts = pat.s.map(([x, y]) => (inverted ? [100 - x, 100 - y] : [x, y]));
    let out = `<svg class="skyfig ${cls}" viewBox="0 0 100 100" aria-hidden="true">`;
    if (field) {
      // a scatter of faint background stars, the same every time
      let seed = 7;
      const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (let i = 0; i < 34; i++) out += `<circle class="bg" cx="${(rand() * 100).toFixed(1)}" cy="${(rand() * 100).toFixed(1)}" r="${(0.35 + rand() * 0.6).toFixed(2)}"/>`;
    }
    pat.e.forEach(([a, b]) => { out += `<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}"/>`; });
    pts.forEach(([x, y], i) => { out += `<circle cx="${x}" cy="${y}" r="${i === 0 ? 3.1 : 2.1 + ((i * 5) % 3) * 0.35}"/>`; });
    return out + "</svg>";
  }
  function renderDrawers(host, big) {
    if (!host) return;
    host.innerHTML = "";
    level().drawers.forEach((skyIdx, i) => {
      const d = document.createElement(big ? "button" : "span");
      d.className = "cab-dr";
      d.dataset.dr = i;
      if (big) { d.type = "button"; d.setAttribute("aria-label", "Drawer " + (i + 1)); }
      d.innerHTML = `<span class="cab-face">${skySVG(SKY[skyIdx], { cls: "etched" })}</span><span class="cab-knob"></span><span class="cab-no">${i + 1}</span>`;
      host.appendChild(d);
    });
  }
  function renderChart(host) {
    if (!host) return;
    host.innerHTML = "";
    SKY.forEach((pat) => {
      const c = document.createElement("span");
      c.className = "ch-fig";
      c.innerHTML = skySVG(pat, { cls: "inked" }) + `<b>${pat.name}</b>`;
      host.appendChild(c);
    });
  }
  const OPTIC_SVG = `<svg class="optic" viewBox="0 0 220 70" aria-hidden="true">
    <ellipse cx="110" cy="35" rx="6" ry="26" class="lens"/>
    <path d="M28 48 L28 14 M22 22 L28 14 L34 22" class="obj"/>
    <path d="M192 22 L192 56 M186 48 L192 56 L198 48" class="obj"/>
    <path d="M28 14 L110 14 L192 56 M28 48 L110 48 L192 22 M28 14 L192 56 M28 48 L192 22" class="ray"/>
    <path d="M40 60 h140" class="base"/>
  </svg>`;

  // ---- the dome and the crank
  const DOME_TOL = 6;
  const domeAngle = () => ((level().domeStart + state.wheel * 0.35) % 360 + 360) % 360;
  function syncDome() {
    const lv = levelEl();
    if (!lv || level().id !== 7) return;
    const { w } = stageSize();
    const dome = state.domeOpen ? 0 : domeAngle();
    state.dome = dome;
    // the dome is unrolled across the stage: the band is W wide for 360°, so the slit is always in view
    let off = (-dome / 360) * w;
    off = ((off + w / 2) % w + w) % w - w / 2;
    lv.style.setProperty("--dx", off.toFixed(1) + "px");
    lv.style.setProperty("--slit", (w / 2 + off).toFixed(1) + "px");
    lv.style.setProperty("--wheel", state.wheel.toFixed(1) + "deg");
    document.querySelectorAll(".ck-wheel").forEach((el) => el.style.setProperty("--wheel", state.wheel.toFixed(1) + "deg"));
    const rim = $("ckRim");
    if (rim) {
      let d = dome; if (d > 180) d -= 360;   // signed distance to the index, in degrees
      rim.style.setProperty("--d", d.toFixed(1));
    }
    const rd = $("ckRead");
    if (rd) rd.textContent = state.domeOpen ? "OPEN" : String(Math.round(dome)).padStart(3, "0") + "°";
  }
  function turnWheel(delta) {
    if (state.domeOpen || state.busy) return;
    state.wheel += delta;
    syncDome();
    const d = state.dome > 180 ? state.dome - 360 : state.dome;
    if (Math.abs(d) <= DOME_TOL) openDome();
  }
  async function openDome() {
    state.domeOpen = true;
    state.busy = true;
    state.attempts++;
    sfx.domeOpen();
    syncDome();
    const lv = levelEl();
    lv.classList.add("is-opening");
    const note = $("ckNote");
    if (note) note.textContent = "The pawl drops into its notch. Above you, something heavy starts to slide.";
    await wait(1900);
    lv.classList.add("is-open");
    discover("crank");
    toast("The slit finds the sky. Starlight comes down the tube.", 3800);
    if (note) note.textContent = "The slit is over the telescope. Leave the wheel now.";
    await wait(700);
    state.busy = false;
  }
  function openCrank() {
    openModal("crank", "The Dome Crank", (body) => {
      const z = zoomClone("crank", null, true);
      body.appendChild(z);
      const wheel = z.querySelector(".ck-wheel");
      const rim = document.createElement("div");
      rim.className = "ck-rimwin";
      rim.innerHTML = '<span class="ck-rim" id="ckRim"><i class="ck-ticks"></i><i class="ck-notch"></i></span><span class="ck-index"></span><span class="ck-read" id="ckRead">---</span>';
      body.appendChild(rim);
      const bar = document.createElement("div");
      bar.className = "scope-bar";
      bar.innerHTML = '<button type="button" class="btn btn-ghost" id="ckL" aria-label="Turn the wheel left">◀ TURN</button>' +
        '<span class="sc-stn">DOME</span>' +
        '<button type="button" class="btn btn-ghost" id="ckR" aria-label="Turn the wheel right">TURN ▶</button>';
      body.appendChild(bar);
      body.appendChild(p(state.domeOpen
        ? "The wheel is pawled off. The slit sits where the tube is pointing and the cold is coming straight down it."
        : "An iron wheel on a bracket, a chain running up into the dark. Turn it and the whole dome grinds round on its rail. The little window above the wheel shows the rim passing — and a pointer that does not move."));
      const note = p("", "modal-clue"); note.id = "ckNote"; body.appendChild(note);
      let dragging = false, last = 0;
      const ang = (e) => { const r = wheel.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
      wheel.addEventListener("pointerdown", (e) => { if (state.domeOpen) return; dragging = true; last = ang(e); wheel.setPointerCapture(e.pointerId); e.preventDefault(); });
      wheel.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const a = ang(e); let d = a - last; if (d > 180) d -= 360; if (d < -180) d += 360; last = a;
        if (Math.abs(d) > 0.4) { turnWheel(d); if (Math.random() < 0.08) sfx.grind(); }
      });
      const stop = () => { dragging = false; };
      wheel.addEventListener("pointerup", stop); wheel.addEventListener("pointercancel", stop);
      $("ckL").addEventListener("click", () => { sfx.grind(); turnWheel(-14); });
      $("ckR").addEventListener("click", () => { sfx.grind(); turnWheel(14); });
      syncDome();
    });
  }

  // ---- the eyepiece
  function openEyepiece() {
    openModal("telescope", "The Eyepiece", (body) => {
      const eye = document.createElement("div");
      eye.className = "eyepiece" + (state.domeOpen ? " is-sky" : "");
      eye.innerHTML = state.domeOpen
        ? skySVG(SKY[level().answer], { inverted: true, cls: "seen", field: true }) + '<span class="ep-reticle"></span><span class="ep-glass"></span>'
        : '<span class="ep-dark"></span><span class="ep-reticle"></span><span class="ep-glass"></span>';
      body.appendChild(eye);
      if (!state.domeOpen) {
        body.appendChild(p("You put your eye to the brass. Black — the painted inside of the dome, a foot from the objective. The tube is pointing at a closed roof."));
        body.appendChild(p("Nothing to see until the dome is open.", "modal-dud"));
        return;
      }
      body.appendChild(p("Cold on your eye. A handful of stars, very far away, standing in a shape — and the rest of the sky black around them."));
      body.appendChild(p("Remember the shape exactly as the glass shows it.", "modal-clue"));
      discover("telescope");
    });
  }

  // ---- the lens cabinet (the lock)
  function buildCabinet(body) {
    body.appendChild($("tplCabinet").content.cloneNode(true));
    const grid = $("cabGrid");
    renderDrawers(grid, true);
    const big = $("cabBig");
    if (state.lockOpen) {
      big.classList.add("is-open");
      const d = grid.querySelector(`[data-dr="${level().drawers.indexOf(level().answer)}"]`);
      if (d) d.classList.add("is-out");
      $("lockText").textContent = state.keyObtained ? "The drawer stands open and empty." : "One drawer stands open. Something is lying in it.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    grid.addEventListener("click", (e) => {
      const d = e.target.closest(".cab-dr");
      if (d) pullDrawer(+d.dataset.dr, d);
    });
    wireKey();
  }
  function pullDrawer(i, el) {
    if (state.lockOpen || state.busy) return;
    state.attempts++;
    if (level().drawers[i] === level().answer) return solveLock();
    lockFailed(() => { el.classList.remove("is-stuck"); void el.offsetWidth; el.classList.add("is-stuck"); });
  }

  /* ---------- room 8: the plan, and the plan behind it ---------- */
  const VOICE_MS = 4600;
  function voice(text, ms = VOICE_MS) { toast("“" + text + "”", ms, "is-voice"); }
  const CAL_MARKS = { 3: "car", 14: "cake", 22: "cross", 27: "phone" };
  const DOODLE = {
    cake: '<svg viewBox="0 0 24 24"><path d="M5 12h14v8H5z"/><path d="M4 12c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2" fill="none"/><path d="M9 12V8M12 12V7M15 12V8" fill="none"/><path d="M9 6c0 1 1 1 1 0s-1-2-1-1zM12 5c0 1 1 1 1 0s-1-2-1-1zM15 6c0 1 1 1 1 0s-1-2-1-1z"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="M3 15l2-5h14l2 5v3H3z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M7 10l1.5-3h7L17 10" fill="none"/></svg>',
    cross: '<svg viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19" fill="none"/></svg>',
    phone: '<svg viewBox="0 0 24 24"><path d="M6 4h5l2 5-2.5 1.5a11 11 0 005 5L17 13l5 2v5c-9 1-17-7-16-16z"/></svg>',
  };
  function renderCalendar(host, big) {
    if (!host) return;
    host.innerHTML = "";
    ["S", "M", "T", "W", "T", "F", "S"].forEach((d) => { const h = document.createElement("i"); h.className = "cal-h"; h.textContent = d; host.appendChild(h); });
    for (let i = 0; i < 31 + 0; i++) {
      const c = document.createElement("i");
      c.className = "cal-d";
      const day = i + 1;
      c.innerHTML = `<b>${day}</b>` + (CAL_MARKS[day] ? `<span class="cal-doodle ${CAL_MARKS[day]}">${DOODLE[CAL_MARKS[day]]}</span>` : "");
      host.appendChild(c);
    }
  }
  function renderBoxes(host, big) {
    if (!host) return;
    host.innerHTML = "";
    for (let i = 0; i < 24; i++) {
      const b = document.createElement(big ? "button" : "span");
      b.className = "bx";
      b.dataset.bx = i;
      if (big) { b.type = "button"; b.setAttribute("aria-label", "Box " + (i + 1)); }
      b.innerHTML = `<span class="bx-door"><i class="bx-no">${i + 1}</i><i class="bx-hole"></i><i class="bx-hole k"></i></span><span class="bx-in"><i class="bx-junk"></i></span>`;
      host.appendChild(b);
    }
  }

  // ---- the vault (plan A)
  function openVault() {
    if (state.vaultOpen) {
      openModal("vault", "The Vault", (body) => {
        body.appendChild($("tplVault").content.cloneNode(true));
        const big = $("vaultBig");
        big.classList.add("is-open", "is-gate");
        big.querySelector(".vb-door").style.transition = "none";
        $("vaultSubmit").disabled = true;
        $("vaultText").textContent = "The door stands open on a gate that does not. Bars to the ceiling, and a display that is counting down to eight in the morning.";
      });
      lastFocus = null;
      objEl("vault").blur();
      return;
    }
    openModal("vault", "The Vault", (body) => {
      body.appendChild($("tplVault").content.cloneNode(true));
      wireDials(body, "digits");
      $("vaultSubmit").addEventListener("click", submitVault);
      renderWord();
    });
  }
  function submitVault() {
    if (state.vaultOpen || state.busy) return;
    state.attempts++;
    if (state.dials.join("") === level().vaultCode) return vaultFail();
    state.wrongAttempts++;
    sfx.wrong();
    const wl = $("wordlock");
    wl.classList.add("is-error"); nudge("#wordlock");
    screens.room.classList.add("is-shaking");
    setTimeout(() => screens.room.classList.remove("is-shaking"), 500);
    const msgs = ["The handle turns a quarter and stops dead.", "Nothing. The wheels roll back to zero.", "Wrong. He said the manager's head — you are guessing.", "Still shut."];
    $("vaultText").textContent = msgs[Math.min(msgs.length - 1, state.wrongAttempts - 1)];
    setTimeout(() => { wl.classList.remove("is-error"); state.dials = [0, 0, 0, 0]; state.slot = 0; renderWord(); }, 800);
  }
  async function vaultFail() {
    state.vaultOpen = true;
    state.busy = true;
    sfx.correct();
    const big = $("vaultBig"), txt = $("vaultText");
    const room = objEl("vault");
    if (txt) txt.textContent = "The wheels seat. The handle goes all the way round, and a ton of steel starts to move…";
    $("vaultSubmit").disabled = true;
    big.classList.add("is-vibrating");
    await wait(700);
    big.classList.remove("is-vibrating");
    sfx.safeOpen();
    big.classList.add("is-open");
    room.classList.add("is-open");
    screens.room.classList.add("is-rumbling");
    await wait(2000);
    screens.room.classList.remove("is-rumbling");
    sfx.gate();
    big.classList.add("is-gate");
    room.classList.add("is-gate");
    // Chromium refuses to paint the swung door while its button holds focus: let focus go elsewhere
    lastFocus = null;
    room.blur();
    if (txt) txt.textContent = "Behind the door: a second gate, bars floor to ceiling, and a small display counting down to eight in the morning. A time lock. The door was never the door.";
    discover("vault");
    await wait(1200);
    // the silent alarm is not silent in here
    state.alarm = true;
    levelEl().classList.add("is-alarm");
    sfx.alarm();
    setScanner("SILENT ALARM · CENTRAL BRANCH · UNITS RESPONDING");
    await wait(900);
    voice("That's the door saying no. I said it might. Page two, now.", 5200);
    state.busy = false;
    ambTimers.push(setTimeout(() => setScanner("UNIT 4 · TWO MINUTES OUT"), 9000));
    ambTimers.push(setTimeout(() => voice("They won't cut the vault open. They'll freeze it — mains off. Be ready."), 14000));
    ambTimers.push(setTimeout(() => setScanner("CENTRAL — ISOLATE THE MAINS. HOLD THE PERIMETER."), 22000));
    ambTimers.push(setTimeout(powerCutNow, 27000));
  }
  function setScanner(text) {
    document.querySelectorAll("[data-scanner]").forEach((el) => { el.textContent = text; });
  }
  function powerCutNow() {
    if (state.powerCut || state.levelId !== 8 || state.screen !== "room" || state.completed || state.gameOver) return;
    state.powerCut = true;
    sfx.powerDown();
    const lv = levelEl();
    lv.classList.add("is-dark");
    setScanner("— MAINS DOWN — BATTERY —");
    objEl("door").classList.add("is-dead");
    toast("The lights die. A fan somewhere spins down. On the grille by the floor, the little lamp goes out.", 4200);
    ambTimers.push(setTimeout(() => voice("There. Now they are outside a locked building, and you are not."), 4600));
  }

  // ---- the boxes (plan B — the real lock)
  function buildBoxes(body) {
    body.appendChild($("tplBoxes").content.cloneNode(true));
    const grid = $("bbGrid");
    renderBoxes(grid, true);
    const big = $("boxesBig");
    state.junk.forEach((i) => { const b = grid.querySelector(`[data-bx="${i}"]`); if (b) b.classList.add("is-open", "is-junk"); });
    if (state.lockOpen) {
      big.classList.add("is-open");
      const b = grid.querySelector(`[data-bx="${level().answer}"]`);
      if (b) b.classList.add("is-open", "is-key");
      $("lockText").textContent = state.keyObtained ? "The right box stands open and empty." : "One box stands open with something heavier than paper in it.";
      if (state.keyObtained) { $("theKey").classList.add("is-taken"); $("safeEmptyText").hidden = false; }
    }
    grid.addEventListener("click", (e) => {
      const b = e.target.closest(".bx");
      if (b) openBox(+b.dataset.bx, b);
    });
    wireKey();
  }
  function openBox(i, el) {
    if (state.lockOpen || state.busy) return;
    if (state.junk.includes(i)) { sfx.click(); $("lockText").textContent = "Paper. You already looked."; return; }
    state.attempts++;
    if (i === level().answer) return solveLock();
    state.junk.push(i);
    const room = objEl("boxes").querySelector(`[data-bx="${i}"]`);
    if (room) room.classList.add("is-open", "is-junk");
    sfx.drawer();
    el.classList.add("is-open", "is-junk");
    lockFailed(() => { nudge("#boxesBig"); });
    if (state.wrongAttempts === 2) ambTimers.push(setTimeout(() => voice("Stop guessing. I did not leave you a guess. Go and count."), 900));
  }

  /* ---------- room 9: the gear train ---------- */
  const GT_K = 1.6;                                   // px of radius per tooth, in the close-up
  const gtR = (teeth) => teeth * GT_K;
  const GT_TOL = 1.5;
  function gearHTML(teeth, cls = "") {
    const r = gtR(teeth);
    return `<span class="gt-gear ${cls}" style="--r:${r.toFixed(1)}px;--n:${teeth}" data-teeth="${teeth}"><i class="gt-teeth"></i><i class="gt-disc"></i><b>${teeth}</b></span>`;
  }
  // geometry of the wall plate: crank at 0, pegs to the right, the rack sitting above peg 4
  function gtLayout() {
    const lv = level();
    const rc = gtR(lv.crankTeeth);
    const sol = lv.answer.map(gtR);
    const pegs = [];
    let x = rc + sol[0]; pegs.push(x);
    for (let i = 1; i < 4; i++) { x += sol[i - 1] + sol[i]; pegs.push(x); }
    return { rc, pegs, rackGap: sol[3] };
  }
  function renderTray(host, big) {
    if (!host) return;
    host.innerHTML = "";
    level().gears.forEach((t, i) => {
      const s = document.createElement(big ? "button" : "span");
      s.className = "gt-slot" + (state.pegs.includes(i) ? " is-empty" : "") + (state.held === i ? " is-held" : "");
      s.dataset.gear = i;
      s.dataset.teeth = t;
      s.style.setProperty("--s", Math.min(1.5, 27 / gtR(t)).toFixed(3));
      if (big) { s.type = "button"; s.setAttribute("aria-label", t + " teeth"); }
      s.innerHTML = gearHTML(t);
      host.appendChild(s);
    });
  }
  function renderPegs(host, big) {
    if (!host) return;
    const { pegs } = gtLayout();
    host.innerHTML = "";
    pegs.forEach((x, i) => {
      const pg = document.createElement(big ? "button" : "span");
      pg.className = "gt-peg" + (state.pegs[i] !== null ? " is-set" : "");
      pg.dataset.peg = i;
      pg.style.setProperty("--x", x.toFixed(1) + "px");
      if (big) { pg.type = "button"; pg.setAttribute("aria-label", "Peg " + (i + 1)); }
      const g = state.pegs[i];
      pg.innerHTML = '<i class="gt-pin"></i>' + (g !== null ? gearHTML(level().gears[g], "is-set") : "");
      host.appendChild(pg);
    });
  }
  function syncGeartrain() {
    const lv = level();
    const big = $("gtBig");
    if (big) {
      renderPegs($("gtPegs"), true);
      renderTray($("gtTray"), true);
      const held = $("gtHeld");
      if (held) held.textContent = state.held === null ? "NOTHING IN HAND" : "IN HAND · " + lv.gears[state.held] + " TEETH";
    }
    const room = objEl("geartrain");
    if (room) renderPegs(room.querySelector("[data-pegs]"), false);
    const tray = objEl("tray");
    if (tray) renderTray(tray.querySelector("[data-tray]"), false);
  }
  function buildGeartrain(body) {
    body.appendChild($("tplGeartrain").content.cloneNode(true));
    const lv = level();
    const { rc, pegs, rackGap } = gtLayout();
    const wall = body.querySelector(".gt-wall");
    wall.style.setProperty("--rc", rc.toFixed(1) + "px");
    wall.style.setProperty("--span", (pegs[3] + gtR(lv.answer[3]) + 40).toFixed(1) + "px");
    wall.style.setProperty("--rack", rackGap.toFixed(1) + "px");
    wall.style.setProperty("--peg4", pegs[3].toFixed(1) + "px");
    $("gtCrank").innerHTML = gearHTML(lv.crankTeeth, "is-crank") + '<b class="gt-handle2"></b>';
    discover("geartrain");
    if (state.lockOpen) {
      $("gtBig").classList.add("is-open", "is-running");
      $("gtTurn").disabled = true;
      $("lockText").textContent = "The train runs true and the bolt is drawn. Above you, the trapdoor is unlatched.";
    }
    $("gtTray").addEventListener("click", (e) => { const s = e.target.closest(".gt-slot"); if (s) pickGear(+s.dataset.gear); });
    $("gtPegs").addEventListener("click", (e) => { const pg = e.target.closest(".gt-peg"); if (pg) tapPeg(+pg.dataset.peg); });
    $("gtTurn").addEventListener("click", turnCrank);
    syncGeartrain();
  }
  function pickGear(i) {
    if (state.lockOpen || state.busy) return;
    if (state.pegs.includes(i)) return;            // already on the wall
    state.held = state.held === i ? null : i;
    sfx.click();
    syncGeartrain();
  }
  // does gear (radius r) on peg i sit cleanly against its neighbours?  returns "ok" | "jam" | "gap"
  function fitOnPeg(i, r) {
    const lv = level();
    const { rc, pegs, rackGap } = gtLayout();
    const leftX = i === 0 ? 0 : pegs[i - 1];
    const leftR = i === 0 ? rc : (state.pegs[i - 1] !== null ? gtR(lv.gears[state.pegs[i - 1]]) : null);
    let jam = false, gap = false;
    if (leftR !== null) {
      const d = pegs[i] - leftX, need = leftR + r;
      if (need > d + GT_TOL) jam = true; else if (need < d - GT_TOL) gap = true;
    }
    if (i < 3 && state.pegs[i + 1] !== null) {
      const d = pegs[i + 1] - pegs[i], need = r + gtR(lv.gears[state.pegs[i + 1]]);
      if (need > d + GT_TOL) jam = true; else if (need < d - GT_TOL) gap = true;
    }
    if (i === 3) { if (r > rackGap + GT_TOL) jam = true; else if (r < rackGap - GT_TOL) gap = true; }
    return jam ? "jam" : gap ? "gap" : "ok";
  }
  function tapPeg(i) {
    if (state.lockOpen || state.busy) return;
    const lv = level();
    if (state.held === null) {
      // take a gear back
      if (state.pegs[i] !== null) { state.held = state.pegs[i]; state.pegs[i] = null; sfx.dial(); syncGeartrain(); }
      return;
    }
    if (state.pegs[i] !== null) { $("lockText").textContent = "That peg is taken. Take the gear off it first."; sfx.locked(); return; }
    const r = gtR(lv.gears[state.held]);
    const fit = fitOnPeg(i, r);
    if (fit === "jam") {
      state.jams++;
      sfx.grind(); sfx.locked();
      const pg = $("gtPegs").querySelector(`[data-peg="${i}"]`);
      if (pg) { pg.classList.remove("is-jam"); void pg.offsetWidth; pg.classList.add("is-jam"); }
      const cost = state.jams > lv.freeJams;
      if (cost) { state.wrongAttempts++; state.attempts++; }
      $("lockText").textContent = (cost ? "Jammed again — " : "Jammed. ") + "The teeth ride up on the next wheel and it will not seat." + (cost ? " That one cost you." : "");
      return;
    }
    state.pegs[i] = state.held;
    state.held = null;
    sfx.latch();
    syncGeartrain();
    $("lockText").textContent = fit === "gap"
      ? "It seats — loosely. Daylight between the teeth. Turn the crank and see what turns."
      : "It seats, and the teeth take up against the next wheel with a click.";
  }
  async function turnCrank() {
    if (state.lockOpen || state.busy) return;
    const lv = level();
    state.attempts++;
    // walk the drive from the crank: stop at the first empty peg or gap; a jam anywhere locks the crank
    // a jam anywhere on the wall locks everything; otherwise follow the contacts left to right
    const jammed = state.pegs.some((g, i) => g !== null && fitOnPeg(i, gtR(lv.gears[g])) === "jam");
    let driven = 0;
    if (!jammed) {
      const { rc, pegs, rackGap } = gtLayout();
      let leftX = 0, leftR = rc;
      for (let i = 0; i < 4; i++) {
        const g = state.pegs[i];
        if (g === null) break;
        const r = gtR(lv.gears[g]);
        if (leftR + r < pegs[i] - leftX - GT_TOL) break;          // daylight: not driven
        if (i === 3 && r < rackGap - GT_TOL) { driven = 4; break; } // turns, but never reaches the rack
        driven++;
        leftX = pegs[i]; leftR = r;
      }
      if (driven === 4 && gtR(lv.gears[state.pegs[3]]) < rackGap - GT_TOL) driven = 3.5;
    }
    const big = $("gtBig");
    if (jammed) {
      state.wrongAttempts++;
      sfx.grind(); sfx.wrong();
      big.classList.remove("is-jam"); void big.offsetWidth; big.classList.add("is-jam");
      $("lockText").textContent = "The crank moves a finger's width and locks solid. Something on the wall is fighting something else.";
      return;
    }
    if (driven === 4) return solveLock();
    state.busy = true;
    const turning = Math.floor(driven);
    big.dataset.driven = turning;
    big.classList.add("is-running");
    sfx.grind();
    const rid = ["at the crank", "between the first wheel and the second", "between the second wheel and the third", "between the third wheel and the fourth"];
    $("lockText").textContent = driven === 0
      ? "The crank turns and nothing follows it. The first wheel does not even touch."
      : driven === 3.5
        ? "All four wheels turn — and the last one spins under the rack without touching it. The bolt does not move."
        : `The crank turns, ${turning === 1 ? "one wheel turns" : turning + " wheels turn"} — and the drive dies ${rid[turning]}. Nothing past it moves.`;
    await wait(1700);
    big.classList.remove("is-running");
    big.removeAttribute("data-driven");
    state.busy = false;
  }
  function cuckooCall() {
    const c = objEl("cuckoo");
    if (!c) return;
    c.classList.add("is-out");
    sfx.cuckoo();
    setTimeout(() => c.classList.remove("is-out"), 1600);
  }

  /* ---------- shared lock behaviour ---------- */
  function nudge(sel) {
    const el = document.querySelector(sel);
    if (!el) return;
    el.classList.remove("is-shaking"); void el.offsetWidth; el.classList.add("is-shaking");
  }
  function lockFailed(effect) {
    state.wrongAttempts++;
    sfx.wrong();
    effect();
    screens.room.classList.add("is-shaking");
    setTimeout(() => screens.room.classList.remove("is-shaking"), 500);
    const msgs = {
      safe: ["The lock refuses.", "Nothing. The bolts hold.", "A dull click — wrong.", "Still locked."],
      chest: ["The dials spin back.", "The lock will not give.", "Wrong word. The brass barely moves.", "Still shut."],
      pipes: ["The pipes shriek and slam shut.", "Steam, and nothing else. The valves reset.", "Wrong order. Everything closes again.", "The wall hisses at you."],
      suitcase: ["The latches hold.", "Nothing gives. The wheels spin back to zero.", "Wrong number — the case stays strapped.", "Still locked."],
      padlock: ["The shackle does not move.", "Solid. The wheels roll back to zero.", "Wrong number. The brass does not care.", "Still shut."],
      gridsafe: ["The handle will not throw.", "Nothing. The bolts stay out.", "Wrong reference — the dials spin back.", "Still locked."],
      cabinet: ["The drawer does not budge.", "Locked. The knob turns in your hand and nothing follows it.", "Not that one. The brass does not care how sure you were.", "Still shut."],
      boxes: ["Paper. Bonds, deeds, somebody's will. Not a key.", "More paper. He said count, not guess.", "Paper again. Two lines of tiles leave that door — you want the one that ends at the desk.", "Paper."],
      geartrain: ["The crank locks.", "Jammed solid.", "Something is fighting something.", "Locked."],
    }[level().lock];
    const t = $("lockText");
    if (t) t.textContent = msgs[Math.min(msgs.length - 1, state.wrongAttempts - 1)] + (state.wrongAttempts >= 3 ? " The room has already told you the answer." : "");
  }
  async function solveLock() {
    state.lockOpen = true;
    state.busy = true;
    sfx.correct();
    const kind = level().lock;
    const txt = $("lockText");   // grab now: the player may close the modal mid-cinematic
    screens.room.classList.add("is-rumbling");

    if (kind === "safe") {
      const big = $("safeBig"), disp = $("keypadDisplay");
      disp.classList.add("is-ok"); $("keypadDigits").textContent = "OPEN";
      txt.textContent = "Something heavy moves inside the door…";
      big.classList.add("is-vibrating");
      await wait(650);
      big.classList.add("is-unlocking"); sfx.safeOpen();
      await wait(900);
      big.classList.remove("is-vibrating");
      big.classList.add("is-open");
      objEl("safe").classList.add("is-open");
      await wait(1200);
      txt.textContent = "The door swings open. A brass key glints inside — take it.";
      toast("The safe is open.");
    } else if (kind === "chest") {
      const big = $("chestBig"), wl = $("wordlock");
      wl.classList.add("is-ok");
      txt.textContent = "The dials bite, and the brass gives…";
      big.classList.add("is-vibrating");
      await wait(600);
      sfx.chestOpen();
      big.classList.remove("is-vibrating");
      big.classList.add("is-open");
      objEl("chest").classList.add("is-open");
      await wait(1300);
      txt.textContent = "The lid falls back on old velvet. A brass key is lying in it — take it.";
      toast("The chest is open.");
    } else if (kind === "suitcase") {
      const big = $("caseBig"), wl = $("wordlock");
      wl.classList.add("is-ok");
      txt.textContent = "Four wheels line up. The latches jump…";
      big.classList.add("is-vibrating");
      await wait(500);
      sfx.latch();
      await wait(400);
      big.classList.remove("is-vibrating");
      big.classList.add("is-open");
      sfx.chestOpen();
      objEl("suitcase").classList.add("is-open");
      await wait(1300);
      txt.textContent = "Inside: a page from the conductor's log, and a brass handle strapped into the lining.";
      toast("The suitcase is open.");
    } else if (kind === "gridsafe") {
      const big = $("grSafe");
      txt.textContent = "The dials seat, and something heavy lets go behind the door…";
      big.classList.add("is-vibrating");
      await wait(600);
      sfx.latch();
      big.classList.remove("is-vibrating");
      big.classList.add("is-open");
      objEl("gridsafe").classList.add("is-open");
      sfx.safeOpen();
      $("wordSubmit").disabled = true;
      await wait(1300);
      txt.textContent = "One steel shelf, and one card on it.";
      toast("The safe is open.");
    } else if (kind === "padlock") {
      const big = $("lockBig"), wl = $("wordlock");
      wl.classList.add("is-ok");
      txt.textContent = "Four wheels drop into line…";
      big.classList.add("is-vibrating");
      await wait(500);
      sfx.latch();
      big.classList.remove("is-vibrating");
      big.classList.add("is-open");
      objEl("padlock").classList.add("is-open");
      await wait(700);
      sfx.safeOpen();
      objEl("door").classList.add("is-unlocked");
      $("wordSubmit").disabled = true;
      await wait(900);
      txt.textContent = "The shackle springs out of the hasp, and behind you the deadbolt slides back on its own weight.";
      toast("The padlock is off. The door will open.");
    } else if (kind === "cabinet") {
      const big = $("cabBig");
      const idx = level().drawers.indexOf(level().answer);
      const d = big.querySelector(`[data-dr="${idx}"]`);
      txt.textContent = "The knob comes towards you, and the drawer with it…";
      if (d) d.classList.add("is-vibrating");
      await wait(500);
      sfx.drawer();
      if (d) { d.classList.remove("is-vibrating"); d.classList.add("is-out"); }
      const room = objEl("cabinet");
      room.classList.add("is-open");
      const rd = room.querySelector(`[data-dr="${idx}"]`); if (rd) rd.classList.add("is-out");
      await wait(600);
      big.classList.add("is-open");
      sfx.chestOpen();
      await wait(1100);
      txt.textContent = "Green baize, a lens in a paper sleeve, and beside it — a key. Take it.";
      toast("The drawer is open.");
    } else if (kind === "boxes") {
      const big = $("boxesBig");
      const b = big.querySelector(`[data-bx="${level().answer}"]`);
      txt.textContent = "This one is heavier. The door swings on the drilled hinge…";
      if (b) b.classList.add("is-vibrating");
      await wait(500);
      sfx.drawer();
      if (b) { b.classList.remove("is-vibrating"); b.classList.add("is-open", "is-key"); }
      const room = objEl("boxes").querySelector(`[data-bx="${level().answer}"]`);
      if (room) room.classList.add("is-open", "is-key");
      objEl("boxes").classList.add("is-open");
      await wait(600);
      big.classList.add("is-open");
      sfx.chestOpen();
      await wait(1000);
      txt.textContent = "Felt, and on it a short iron key with a square bit. Bolt key. Take it.";
      toast("The right box.");
    } else if (kind === "geartrain") {
      const big = $("gtBig");
      txt.textContent = "The crank turns. The first wheel takes it, and the second, and the third — and the fourth walks the rack along its teeth…";
      big.dataset.driven = 4;
      big.classList.add("is-running");
      sfx.ratchet();
      await wait(1400);
      sfx.ratchet();
      big.classList.add("is-open");
      objEl("geartrain").classList.add("is-open", "is-running");
      objEl("door").classList.add("is-unlocked");
      await wait(900);
      sfx.latch();
      $("gtTurn").disabled = true;
      txt.textContent = "The rod lifts. Above you, with a bang, the bolt comes clear of the trapdoor.";
      toast("The bolt is drawn. The trapdoor is free.");
    } else {
      const wall = $("valveWall");
      txt.textContent = "Somewhere behind the wall, water starts to move…";
      sfx.steam();
      $("steam").classList.add("go");
      await wait(700);
      sfx.water();
      objEl("pipes").classList.add("is-open");
      wall.querySelectorAll(".bigvalve").forEach((b) => { b.disabled = true; });
      await wait(1400);
      wall.classList.add("is-open");
      sfx.keyPickup();
      await wait(700);
      txt.textContent = "The last of the water drains away — and an iron key drops out of the pipe. Take it.";
      toast("The pipes give up their key.");
    }
    screens.room.classList.remove("is-rumbling");
    state.busy = false;
  }

  /* ---------- room 4: the split-flap destination board ---------- */
  const FLAP_CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function boardConf() { return level().board; }
  function initBoard() {
    const { word, locked } = boardConf();
    state.board = [...word].map((ch, i) => (locked.includes(i) ? ch : " "));
    state.boardSlot = [...word].findIndex((_, i) => !locked.includes(i));
  }
  function openBoard() {
    markInvestigated("board");
    openModal("board", "The Destination Board", (body) => {
      body.appendChild($("tplBoard").content.cloneNode(true));
      const wrap = $("bbFlaps");
      const { locked } = boardConf();
      state.board.forEach((ch, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "flap" + (locked.includes(i) ? " locked" : "");
        b.dataset.slot = String(i);
        b.textContent = ch === " " ? " " : ch;
        if (!locked.includes(i)) b.addEventListener("click", () => { state.boardSlot = i; rollFlap(i, 1); });
        wrap.appendChild(b);
      });
      if (state.boardSet) {
        $("bbStatus").textContent = "ROUTE SET · " + boardConf().word;
        $("bbStatus").classList.add("ok");
        $("lockText").textContent = "The route reads true. The interlock has released.";
      } else {
        $("lockText").textContent = "Six flaps. Three are seized in place; the rest still turn. The ticket said the name — the paper spelled it out.";
      }
      renderBoard();
    });
  }
  function renderBoard() {
    const { locked } = boardConf();
    document.querySelectorAll("#bbFlaps .flap").forEach((f, i) => {
      f.textContent = state.board[i] === " " ? " " : state.board[i];
      f.classList.toggle("is-active", !locked.includes(i) && i === state.boardSlot);
    });
  }
  function rollFlap(i, dir) {
    if (state.boardSet || state.busy) return;
    const cur = FLAP_CHARS.indexOf(state.board[i]);
    state.board[i] = FLAP_CHARS[(cur + dir + FLAP_CHARS.length) % FLAP_CHARS.length];
    sfx.flap();
    const el = document.querySelector(`#bbFlaps .flap[data-slot="${i}"]`);
    if (el) { el.classList.remove("flipping"); void el.offsetWidth; el.classList.add("flipping"); }
    renderBoard();
    checkBoard();
  }
  function setFlap(i, ch) {
    if (state.boardSet || state.busy) return;
    state.board[i] = ch;
    sfx.flap();
    const el = document.querySelector(`#bbFlaps .flap[data-slot="${i}"]`);
    if (el) { el.classList.remove("flipping"); void el.offsetWidth; el.classList.add("flipping"); }
    const free = [...boardConf().word].map((_, k) => k).filter((k) => !boardConf().locked.includes(k));
    const next = free.find((k) => k > i);
    if (next !== undefined) state.boardSlot = next;
    renderBoard();
    checkBoard();
  }
  async function checkBoard() {
    if (state.board.join("") !== boardConf().word) return;
    state.boardSet = true;
    state.busy = true;
    state.attempts++;
    sfx.correct();
    $("bbStatus").textContent = "ROUTE SET · " + boardConf().word;
    $("bbStatus").classList.add("ok");
    $("lockText").textContent = "Every flap turns over at once, and the whole board settles on one name.";
    const roomBoard = objEl("board");
    roomBoard.querySelector("[data-boardname]").textContent = boardConf().word;
    roomBoard.classList.add("is-set");
    document.querySelector(".level-4 .ctrl-panel").classList.add("is-armed");
    await wait(900);
    sfx.flap(); sfx.flap();
    await wait(700);
    closeModal();
    await announcement();
    state.busy = false;
    toast("The interlock is live. The brake will answer now.", 3600);
  }
  /* the tannoy: two chimes, then the line */
  async function announcement() {
    const el = levelEl().querySelector("[data-announce]");
    sfx.announce();
    el.textContent = "Next station…";
    el.classList.add("on");
    await wait(2100);
    el.classList.remove("on");
    await wait(700);
    el.textContent = "You.";
    el.classList.add("on");
    sfx.thunder(true);
    flashLightning();
    await wait(1900);
    el.classList.remove("on");
    await wait(600);
  }

  /* ---------- room 4: the emergency brake ---------- */
  function openBrake() {
    markInvestigated("brake");
    openModal("brake", "The Emergency Brake", (body) => {
      body.appendChild($("tplBrake").content.cloneNode(true));
      const big = $("brakeBig"), lever = $("bgLever"), socket = $("bgSocket"), btn = $("brakePull");
      if (state.keyObtained) { lever.classList.add("armed"); socket.classList.add("filled"); }
      if (state.brakePulled) { big.classList.add("is-pulled"); btn.disabled = true; btn.textContent = "THE TRAIN IS SLOWING"; }
      const ready = state.keyObtained && state.boardSet && !state.brakePulled;
      btn.disabled = !ready;
      if (!state.brakePulled) {
        $("lockText").textContent = !state.keyObtained
          ? "A steel lever behind glass long since broken — but the handle socket is empty. Somebody took it."
          : !state.boardSet
            ? "The handle fits. The lever will not move: a steel dog holds it, wired back to the route board. Set the route first."
            : "The dog has dropped clear. Nothing is holding this lever now.";
      }
      btn.addEventListener("click", pullBrake);
    });
  }
  async function pullBrake() {
    if (state.brakePulled || state.busy || !state.keyObtained || !state.boardSet) return;
    state.brakePulled = true;
    state.busy = true;
    const btn = $("brakePull"), big = $("brakeBig"), txt = $("lockText");
    btn.disabled = true;
    big.classList.add("is-pulled");
    objEl("brake").classList.add("is-pulled");
    sfx.brakePull();
    const lv = levelEl();
    lv.classList.add("is-braking");
    document.querySelector(".level-4 .ctrl-panel").classList.add("is-braking");
    txt.textContent = "The lever goes over. Somewhere under the floor, steel closes on steel.";
    screens.room.classList.add("is-rumbling");
    await wait(2400);
    lv.classList.remove("is-braking");
    lv.classList.add("is-stopping");
    sfx.alarm();
    sfx.ambience.stop();
    screens.room.classList.remove("is-rumbling");
    btn.textContent = "THE TRAIN IS SLOWING";
    txt.textContent = "Wheels screaming, lamps swinging, the whole compartment dragging forward. And then — slower. Slower. The door latch drops.";
    toast("The train is stopping. The door will open now.", 4000);
    await wait(1800);
    closeModal();
    state.busy = false;
  }

  // ---------------------------------------------------------------- key & exit
  function wireKey() {
    const k = $("theKey");
    if (!k) return;
    k.addEventListener("click", takeKey);
    k.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); takeKey(); } });
  }
  function takeKey() {
    if (!state.lockOpen || state.keyObtained || state.busy) return;
    state.keyObtained = true;
    sfx.keyPickup();
    const key = $("theKey");
    if (key) key.classList.add("is-taken");
    const empty = $("safeEmptyText"); if (empty) empty.hidden = false;
    const isHandle = level().lock === "suitcase";
    const txt = $("lockText"); if (txt) txt.textContent = isHandle ? "The handle is heavier than it looks. Now — the brake." : "You pocket the key. Now — the way out.";
    const src = objEl(level().lock); if (src) src.classList.add("is-empty");
    if (isHandle) objEl("brake").classList.add("has-handle");
    if (level().lock === "gridsafe") objEl("door").classList.add("has-card");

    const slot = $("invSlot");
    slot.innerHTML = "";
    const tpl = { safe: "tplSafe", chest: "tplChest", pipes: "tplValves", suitcase: "tplSuitcase", gridsafe: "tplBankSafe", cabinet: "tplCabinet", boxes: "tplBoxes" }[level().lock];
    if (!tpl) return;
    const k = $(tpl).content.querySelector(".key, .card").cloneNode(true);
    k.removeAttribute("id"); k.removeAttribute("tabindex"); k.removeAttribute("role"); k.removeAttribute("aria-label");
    k.style.opacity = "1"; k.style.transform = "none";
    if (k.classList.contains("card")) { const c = document.createElement("span"); c.className = "inv-card"; slot.appendChild(c); }
    else slot.appendChild(k);
    slot.classList.add("has-key");
    toast(isHandle ? "Brake handle obtained." : "Key obtained. The way out might open now.", 3200);
    setTimeout(closeModal, 900);
  }

  async function tryExit() {
    const door = objEl("door");
    state.investigated.add("door");
    const ready = level().exitReady ? level().exitReady(state) : state.keyObtained;
    if (!ready) {
      sfx.locked();
      door.classList.remove("is-rattling"); void door.offsetWidth; door.classList.add("is-rattling");
      const eh = level().exitHint;
      toast(typeof eh === "function" ? eh(state) : (state.lockOpen ? eh.half : eh.locked), 3600);
      return;
    }
    if (state.doorUnlocked) return;
    state.doorUnlocked = true;
    state.busy = true;
    stopTimer();
    door.classList.add("is-unlocked");
    sfx.doorOpen();
    toast(level().exitToast || "The key turns…");
    await wait(700);
    door.classList.add("is-open");
    screens.room.classList.add("is-rumbling");
    await wait(1600);
    screens.room.classList.remove("is-rumbling");
    $("flash").classList.add("go");
    screens.room.classList.add("is-leaving");
    sfx.whoosh();
    await wait(1100);
    finishGame();
  }

  // ---------------------------------------------------------------- end screens
  function ratingStars() {
    const penalty = state.hintsUsed * 2 + state.wrongAttempts + (state.timeLeft < 45 ? 2 : 0) + (state.timeLeft < 20 ? 2 : 0);
    if (penalty <= 1) return 3;
    if (penalty <= 4) return 2;
    return 1;
  }
  const RATING_TEXT = { 3: "⭐⭐⭐ PERFECT ESCAPE", 2: "⭐⭐ GOOD ESCAPE", 1: "⭐ BARELY MADE IT" };
  function finishGame() {
    state.completed = true;
    state.busy = false;
    stopAmbient();
    const stars = ratingStars();
    progress.stars[state.levelId] = Math.max(progress.stars[state.levelId] || 0, stars);
    const next = state.levelId + 1;
    if (next <= LEVELS.length) progress.unlocked = Math.max(progress.unlocked, next);
    saveProgress();

    $("statTime").textContent = fmt(state.timeLeft);
    $("statClues").textContent = `${state.clues.size}/${lvClueTotal(level())}`;
    $("statAttempts").textContent = String(state.attempts);
    $("statHints").textContent = String(state.hintsUsed);
    $("rating").textContent = RATING_TEXT[stars];

    const hasNext = next <= LEVELS.length;
    $("nextBtn").hidden = !hasNext;
    $("nextBtn").textContent = hasNext ? `NEXT ROOM · ${LEVELS[next - 1].name.toUpperCase()}` : "NEXT ROOM";
    $("winEyebrow").textContent = hasNext ? `Room ${state.levelId} of ${LEVELS.length} — ${level().name}` : "Every room behind you";
    $("winTitle").textContent = hasNext ? "YOU ESCAPED" : "YOU ESCAPED THEM ALL";
    showScreen("victory");
    setTimeout(() => sfx.victory(), 300);
  }

  // ---------------------------------------------------------------- hints
  const hintModal = $("hintModal");
  function openHints() {
    if (state.gameOver || state.completed) return;
    sfx.click();
    closeModal();
    state.modal = "hint";
    renderHints();
    hintModal.hidden = false;
    setTimeout(() => $("hintReveal").focus({ preventScroll: true }), 30);
  }
  function closeHints() {
    if (hintModal.hidden) return;
    hintModal.hidden = true;
    if (state.modal === "hint") state.modal = null;
    $("hintBtn").focus({ preventScroll: true });
  }
  function renderHints() {
    const list = $("hintList");
    list.innerHTML = "";
    level().hints.slice(0, state.hintsUsed).forEach((h) => { const li = document.createElement("li"); li.innerHTML = `<em>${h}</em>`; list.appendChild(li); });
    if (state.hintsUsed === 0) { const li = document.createElement("li"); li.className = "locked"; li.textContent = "No hints revealed yet."; list.appendChild(li); }
    const left = HINT_TOTAL - state.hintsUsed;
    $("hintCount").textContent = String(left);
    const btn = $("hintReveal");
    btn.disabled = left === 0;
    btn.textContent = left === 0 ? "No hints left" : `Reveal hint ${state.hintsUsed + 1} of ${HINT_TOTAL}`;
  }
  function revealHint() {
    if (state.hintsUsed >= HINT_TOTAL) return;
    state.hintsUsed++;
    sfx.hint();
    renderHints();
  }
  $("hintBtn").addEventListener("click", openHints);
  $("hintReveal").addEventListener("click", revealHint);
  $("hintClose").addEventListener("click", () => { sfx.click(); closeHints(); });
  hintModal.addEventListener("click", (e) => { if (e.target === hintModal) { sfx.click(); closeHints(); } });

  // ---------------------------------------------------------------- room ambience
  // Storm events for the train: lightning + thunder, and the odd rail joint that
  // shakes the compartment. Both are cleared when the room is left.
  let ambTimers = [];
  function flashLightning() {
    const el = levelEl() && levelEl().querySelector("[data-lightning]");
    if (!el) return;
    el.classList.remove("is-flash"); void el.offsetWidth; el.classList.add("is-flash");
  }
  function startAmbient() {
    stopAmbient();
    const lv = level();
    if (lv.ambience) sfx.ambience.start(lv.ambience);
    if (lv.id === 9) {
      const call = () => {
        if (state.levelId !== 9 || state.screen !== "room") return;
        cuckooCall();
        ambTimers.push(setTimeout(call, 60000));
      };
      ambTimers.push(setTimeout(call, 60000));
      return;
    }
    if (lv.id === 8) {
      const crackle = () => {
        if (state.levelId !== 8 || state.screen !== "room") return;
        sfx.radio();
        ambTimers.push(setTimeout(crackle, rnd(6000, 14000)));
      };
      ambTimers.push(setTimeout(crackle, 2500));
      ambTimers.push(setTimeout(() => { if (!state.alarm) voice("Envelope. Desk. Plan A first — always the plan first."); }, 5200));
      return;
    }
    if (lv.id !== 4) return;
    const storm = () => {
      if (state.levelId !== 4 || state.screen !== "room") return;
      const near = Math.random() < 0.4;
      flashLightning();
      ambTimers.push(setTimeout(() => sfx.thunder(near), near ? 260 : rnd(900, 2200)));
      ambTimers.push(setTimeout(storm, rnd(7000, 15000)));
    };
    const jolt = () => {
      if (state.levelId !== 4 || state.screen !== "room") return;
      const el = levelEl();
      if (el && !state.busy) {
        el.classList.remove("is-bumping"); void el.offsetWidth; el.classList.add("is-bumping");
        sfx.bump();
      }
      ambTimers.push(setTimeout(jolt, rnd(9000, 18000)));
    };
    const tick = () => {
      if (state.levelId !== 4 || state.screen !== "room") return;
      const c = objEl("clock");
      if (c) c.classList.toggle("alt");
      ambTimers.push(setTimeout(tick, 3400));
    };
    ambTimers.push(setTimeout(storm, 3200));
    ambTimers.push(setTimeout(jolt, 6500));
    ambTimers.push(setTimeout(tick, 1500));
  }
  function stopAmbient() {
    ambTimers.forEach(clearTimeout);
    ambTimers = [];
    sfx.ambience.stop();
  }

  // ---------------------------------------------------------------- level setup / reset
  function prepareLevel(id) {
    stopTimer(); stopAmbient();
    closeModal(); closeHints();
    state = fresh(id);
    const lv = LEVELS[id - 1];
    if (lv.board) initBoard();
    document.querySelectorAll(".level").forEach((l) => l.classList.toggle("is-active", +l.dataset.level === id));
    document.querySelectorAll(".obj").forEach((el) => el.classList.remove("is-done", "is-revealed", "is-bright", "is-open", "is-empty", "is-unlocked", "is-rattling", "is-vibrating", "is-set", "is-pulled", "has-handle", "alt", "seq-1", "seq-2", "seq-3", "seq-4"));
    document.querySelectorAll("[data-marks]").forEach((el) => el.classList.remove("is-visible"));
    document.querySelectorAll(".level").forEach((l) => l.classList.remove("is-lit", "is-bumping", "is-braking", "is-stopping"));
    document.querySelectorAll(".ctrl-panel").forEach((el) => el.classList.remove("is-armed", "is-braking"));
    document.querySelectorAll("[data-boardname]").forEach((el) => { el.textContent = "V?R?E?"; });
    document.querySelectorAll("[data-announce]").forEach((el) => el.classList.remove("on"));
    document.querySelectorAll(".level").forEach((l) => l.classList.remove("is-lamp"));
    document.querySelectorAll(".obj").forEach((el) => el.classList.remove("is-taken", "is-lit", "is-live", "is-fixed", "mk1", "mk2", "mk3", "is-tripped", "has-card", "on"));
    document.querySelectorAll(".level").forEach((l) => l.classList.remove("is-powered", "is-opening", "is-open"));
    document.querySelectorAll(".cab-dr").forEach((el) => el.classList.remove("is-out", "is-stuck"));
    if (lv.id === 7) {
      const el = document.querySelector(".level-7");
      renderDrawers(el.querySelector("[data-drawers]"), false);
      renderChart(el.querySelector("[data-chartmini]"));
      state.wheel = 0;
      syncDome();
    }
    document.querySelectorAll(".level").forEach((l) => l.classList.remove("is-alarm", "is-dark", "is-gate"));
    document.querySelectorAll(".obj").forEach((el) => el.classList.remove("is-gate", "is-dead", "is-read"));
    document.querySelectorAll(".bx").forEach((el) => el.classList.remove("is-open", "is-junk", "is-key"));
    $("toast").classList.remove("is-voice");
    if (lv.id === 8) {
      const el = document.querySelector(".level-8");
      renderBoxes(el.querySelector("[data-boxes]"), false);
      renderCalendar(el.querySelector("[data-cal]"), false);
      setScanner("SCANNER · CH 3 · QUIET");
    }
    document.querySelectorAll(".obj").forEach((el) => el.classList.remove("is-running", "is-out"));
    if (lv.id === 9) {
      const el = document.querySelector(".level-9");
      const sk = el.querySelector("[data-sktrain]");
      if (sk) sk.innerHTML = lv.answer.slice(0, 3).map((t) => gearHTML(t, "is-model")).join("");
      const wc = el.querySelector("[data-clocks]");
      if (wc) wc.innerHTML = ["4:50", "11:10", "7:25", "2:40", "9:05", "6:15", "12:55", "3:30", "8:45", "1:20", "10:35"].map((t, i) => {
        const [h, m] = t.split(":").map(Number);
        return `<i class="wk-clock c${i + 1}"><b class="wk-h" style="--a:${(h % 12) * 30 + m * 0.5}deg"></b><b class="wk-m" style="--a:${m * 6}deg"></b></i>`;
      }).join("");
      syncGeartrain();
    }
    document.querySelectorAll(".bp-sw").forEach((el) => el.classList.remove("on"));
    document.querySelectorAll(".scope").forEach((el) => { el.style.removeProperty("--brg"); el.style.removeProperty("--sx"); el.style.removeProperty("--sy"); });
    screens.room.classList.remove("is-shaking", "is-rumbling", "is-leaving");
    $("flash").classList.remove("go");
    $("invSlot").innerHTML = '<span class="inv-empty">—</span>';
    $("invSlot").classList.remove("has-key");
    $("cluesCount").textContent = `0/${lvClueTotal(lv)}`;
    $("roomLabel").textContent = `ROOM ${id} · ${lv.name.toUpperCase()}`;
    document.querySelector("#inventory .hud-label").textContent = lv.itemLabel || "KEY";
    $("hintCount").textContent = String(HINT_TOTAL);
    $("toast").classList.remove("is-visible");
    particles.setLevel(lv);
    renderTimer();
  }
  function enterRoom(id, quiet) {
    prepareLevel(id);
    sfx.unlock();
    if (!quiet) sfx.whoosh();
    showScreen("room");
    startTimer();
    startAmbient();
    setTimeout(() => toast(LEVELS[id - 1].opener, 3400), 900);
  }
  function toMenu() {
    stopTimer(); stopAmbient(); closeModal(); closeHints();
    selected = clamp(state.levelId, 1, progress.unlocked);
    renderCards(); updateEnterLabel();
    state = fresh(selected);
    showScreen("intro");
  }

  // ---------------------------------------------------------------- sound toggle
  function setSound(v) {
    soundOn = v;
    sfx.setEnabled(v);
    if (v && state.screen === "room" && level().ambience) sfx.ambience.start(level().ambience);
    [$("introSoundBtn"), $("roomSoundBtn")].forEach((b) => {
      b.classList.toggle("is-off", !v);
      b.setAttribute("aria-pressed", String(v));
      b.textContent = b.id === "introSoundBtn" ? (v ? "🔊 SOUND ON" : "🔇 SOUND OFF") : (v ? "🔊" : "🔇");
    });
  }
  $("introSoundBtn").addEventListener("click", () => { setSound(!soundOn); if (soundOn) sfx.click(); });
  $("roomSoundBtn").addEventListener("click", () => { setSound(!soundOn); if (soundOn) sfx.click(); });

  // ---------------------------------------------------------------- input wiring
  $("enterBtn").addEventListener("click", () => { sfx.click(); enterRoom(selected); });
  $("retryBtn").addEventListener("click", () => { sfx.click(); enterRoom(state.levelId); });
  $("failMenuBtn").addEventListener("click", () => { sfx.click(); toMenu(); });
  $("playAgainBtn").addEventListener("click", () => { sfx.click(); toMenu(); });
  $("nextBtn").addEventListener("click", () => {
    sfx.click();
    const from = state.levelId, to = Math.min(LEVELS.length, from + 1);
    playTransition(from, to);
  });
  $("resetProgress").addEventListener("click", () => {
    progress = { unlocked: 1, stars: {} };
    saveProgress();
    selected = 1;
    renderCards(); updateEnterLabel();
    sfx.click();
  });
  document.querySelectorAll(".obj[data-object]").forEach((el) => el.addEventListener("click", () => inspect(el.dataset.object)));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (state.modal === "hint") closeHints(); else closeModal(); return; }
    if (state.screen === "transition") { if (transSkip) transSkip(); return; }
    if (state.screen === "intro") {
      if ((e.key === "Enter" || e.key === " ") && document.activeElement === document.body) { e.preventDefault(); $("enterBtn").click(); return; }
      if (/^[1-9]$/.test(e.key) && +e.key <= progress.unlocked && +e.key <= LEVELS.length) { selected = +e.key; sfx.click(); renderCards(); updateEnterLabel(); return; }
      return;
    }
    if (state.modal === "board") {
      const { locked, word } = boardConf();
      const free = [...word].map((_, i) => i).filter((i) => !locked.includes(i));
      if (/^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); setFlap(state.boardSlot, e.key.toUpperCase()); }
      else if (e.key === "ArrowUp") { e.preventDefault(); rollFlap(state.boardSlot, 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); rollFlap(state.boardSlot, -1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); const i = free.indexOf(state.boardSlot); state.boardSlot = free[Math.max(0, i - 1)]; renderBoard(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); const i = free.indexOf(state.boardSlot); state.boardSlot = free[Math.min(free.length - 1, i + 1)]; renderBoard(); }
      else if (e.key === "Backspace") { e.preventDefault(); setFlap(state.boardSlot, " "); }
      return;
    }
    if (state.modal === "brake") { if (e.key === "Enter") { e.preventDefault(); pullBrake(); } return; }
    if (state.modal === "vault") {
      if (/^\d$/.test(e.key)) { e.preventDefault(); typeChar(e.key); }
      else if (e.key === "Enter") { e.preventDefault(); submitVault(); }
      else if (e.key === "Backspace") { e.preventDefault(); state.slot = Math.max(0, state.slot - 1); state.dials[state.slot] = 0; renderWord(); sfx.dial(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); rollDial(state.slot, 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); rollDial(state.slot, -1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); state.slot = Math.max(0, state.slot - 1); renderWord(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); state.slot = Math.min(3, state.slot + 1); renderWord(); }
      return;
    }
    if (state.modal !== "lock") return;
    const kind = level().lock;
    if (kind === "safe") {
      if (/^\d$/.test(e.key)) { e.preventDefault(); pressKey(e.key); }
      else if (e.key === "Enter") { e.preventDefault(); pressKey("enter"); }
      else if (e.key === "Backspace") { e.preventDefault(); pressKey("back"); }
      else if (e.key === "Delete") { e.preventDefault(); pressKey("clear"); }
    } else if (kind === "chest" || kind === "suitcase" || kind === "padlock") {
      if (/^[a-zA-Z0-9]$/.test(e.key)) { e.preventDefault(); typeChar(e.key.toUpperCase()); }
      else if (e.key === "Enter") { e.preventDefault(); submitWord(); }
      else if (e.key === "Backspace") {
        e.preventDefault(); state.slot = Math.max(0, state.slot - 1);
        if (isDigits()) state.dials[state.slot] = 0; else state.word[state.slot] = "A";
        renderWord(); sfx.dial();
      }
      else if (e.key === "ArrowUp") { e.preventDefault(); rollDial(state.slot, 1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); rollDial(state.slot, -1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); state.slot = Math.max(0, state.slot - 1); renderWord(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); state.slot = Math.min(3, state.slot + 1); renderWord(); }
    } else if (kind === "pipes") {
      const map = { 1: "green", 2: "crimson", 3: "blue", 4: "amber" };
      if (map[e.key]) { e.preventDefault(); turnValve(map[e.key]); }
    }
  });
  ["pointerdown", "touchstart", "keydown"].forEach((ev) => document.addEventListener(ev, () => sfx.unlock(), { once: true, passive: true }));
  document.addEventListener("visibilitychange", () => { if (document.hidden) sfx.ambience.stop(); else if (state.screen === "room" && level().ambience) sfx.ambience.start(level().ambience); });

  // ---------------------------------------------------------------- boot
  const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  document.querySelector(".intro-eyebrow").textContent = `${WORDS[LEVELS.length] || LEVELS.length} rooms. Five minutes each.`;
  renderCards();
  updateEnterLabel();
  particles.setLevel(LEVELS[0]);
  renderTimer();
  fitStage();
  setSound(true);
  showScreen("intro");

  window.__escape = {
    get state() { return state; },
    get progress() { return progress; },
    levels: LEVELS,
  };
})();
