// Shop-door bell — the recorded bell-ring sample (public/sounds/door_bell.mp3),
// played whenever the entrance or exit doors are passed. No synth fallback: if
// the sample has not loaded yet the pass retries the fetch and rings as soon as
// it lands; if WebAudio is unavailable the doors open silently.
//
// Extracted from three-scene.ts (the class keeps one-line delegating stubs).
// State lives on the StoreScene; these functions take it as first parameter.
import { assetUrl } from './asset-url';
import type { StoreScene } from './three-scene';

// One ring per door pass: the entry/exit calls (boot, playback-end re-entry,
// the checkout exit walk) and the vestibule-door proximity hook all fire on
// the SAME pass, within a second or two of each other — a trigger that lands
// while the bell is still audible is a duplicate, not a new pass.
const CHIME_DEBOUNCE_MS = 4000;

// Kick off (once) the fetch+decode of the recorded door-bell sample. Decode
// works on a suspended context, so by the time the doors are passed again the
// real recording is ready.
export function loadDoorBell(scene: StoreScene, ctx: AudioContext): Promise<void> {
  if (!scene.doorBellLoad) {
    scene.doorBellLoad = fetch(assetUrl('sounds/door_bell.mp3'))
      .then((r) => { if (!r.ok) throw new Error(`door_bell.mp3 HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => ctx.decodeAudioData(ab))
      .then((buf) => { scene.doorBellBuffer = buf; })
      .catch(() => { /* sample unavailable — doors stay silent; next pass retries */ });
  }
  return scene.doorBellLoad;
}

export function playDoorChime(scene: StoreScene): void {
  try {
    const now = performance.now();
    if (now - scene.lastDoorChimeAt < CHIME_DEBOUNCE_MS) return;
    scene.lastDoorChimeAt = now;
    if (!scene.chimeCtx) scene.chimeCtx = new AudioContext();
    const ctx = scene.chimeCtx;
    ctx.resume().catch(() => {});

    // Owner's pick (settings registry: bb_door_chime, Store Look). Read
    // straight from localStorage — door-chime must not import settings.ts's
    // browser-heavy graph, and every other bb_ knob has a direct reader too.
    let mode: string;
    try { mode = localStorage.getItem('bb_door_chime') || 'recorded'; }
    catch { mode = 'recorded'; }

    if (mode === 'electronic') return playSynthChime(ctx, 'electronic');
    if (mode === 'brass') return playSynthChime(ctx, 'brass');
    if (mode === 'glass') return playSynthChime(ctx, 'glass');

    if (!scene.doorBellBuffer) {
      scene.doorBellLoad = null; // a settled-but-failed load retries here
      loadDoorBell(scene, ctx).then(() => { if (scene.doorBellBuffer) playDoorChime(scene); });
      return;
    }
    // Background storefront cue — it must sit under movie audio.
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = scene.doorBellBuffer;
    src.connect(gain);
    src.start(ctx.currentTime + 0.02);
  } catch {
    // Audio unavailable — the doors open silently.
  }
}

// ─── Synthesized alternatives ───────────────────────────────────────────────
//
// Three period-correct shop-bell flavors with no asset to install. Each is a
// handful of oscillators with a plain exponential decay into the same
// background-cue gain (0.35) the recording uses. Frequency choices:
//  - electronic: the two-tone "ding-DONG" doorbell (E5 then C5)
//  - brass: a struck hand bell — fundamental plus inharmonic overtones
//  - glass: a small wind chime — three quick bright partials
function playSynthChime(
  ctx: AudioContext,
  kind: 'electronic' | 'brass' | 'glass',
): void {
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  const strike = (freq: number, at: number, dur: number, type: OscillatorType, vol: number) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  };

  if (kind === 'electronic') {
    strike(659.25, t0, 0.55, 'sine', 0.5);        // E5 — "ding"
    strike(523.25, t0 + 0.28, 0.7, 'sine', 0.5);  // C5 — "dong"
  } else if (kind === 'brass') {
    // Inharmonic overtones are what make a struck bell read as metal.
    strike(1760, t0, 1.1, 'triangle', 0.42);
    strike(2637, t0 + 0.004, 0.7, 'sine', 0.2);   // ~1.5x, slightly sharp
    strike(3520, t0 + 0.002, 0.5, 'sine', 0.12);
    strike(1760, t0 + 0.45, 0.9, 'triangle', 0.3); // second, softer strike
  } else {
    // glass — a quick descending sparkle, like a chime bar set by the door.
    strike(2093, t0, 0.5, 'sine', 0.4);
    strike(2637, t0 + 0.09, 0.45, 'sine', 0.3);
    strike(1568, t0 + 0.12, 0.6, 'sine', 0.25);
  }
}

// Idle-governor hook (same contract as retailAudio.suspendForIdle): park the
// door-chime AudioContext so its audio thread stops burning CPU across days of
// screensaver/occlusion. No matching resume hook is needed — playDoorChime
// already calls ctx.resume() before every ring, so the next door pass wakes it
// transparently.
export function suspendChimeForIdle(scene: StoreScene): void {
  try {
    if (scene.chimeCtx && scene.chimeCtx.state === 'running') {
      scene.chimeCtx.suspend().catch(() => {});
    }
  } catch { /* no WebAudio here — nothing to park */ }
}
