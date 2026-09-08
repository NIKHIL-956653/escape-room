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
  function toast(text, ms = 2400) {
    const t = $("toast");
    t.textContent = text;
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
  window.addEventListener("resize", () => { if (state.screen === "room") fitStage(); });
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
  const isDigits = () => level().lock === "suitcase" || level().lock === "padlock";
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
    if (state.lockOpen || state.busy) return;
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
    const tpl = { safe: "tplSafe", chest: "tplChest", pipes: "tplValves", suitcase: "tplSuitcase", gridsafe: "tplBankSafe" }[level().lock];
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
      toast(state.lockOpen ? level().exitHint.half : level().exitHint.locked);
      return;
    }
    if (state.doorUnlocked) return;
    state.doorUnlocked = true;
    state.busy = true;
    stopTimer();
    door.classList.add("is-unlocked");
    sfx.doorOpen();
    toast("The key turns…");
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
    document.querySelectorAll(".level").forEach((l) => l.classList.remove("is-powered"));
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
