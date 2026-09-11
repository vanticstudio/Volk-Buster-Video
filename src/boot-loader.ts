// Friendly boot loader for the public store (:3355).
//
// Viewers get a status line, a progress bar and rotating flavor text; the
// owner console keeps the raw operations log instead. Full detail still lands
// in console.log and the dev-console — nothing is hidden from anyone who opens
// the tools. Extracted from main.ts (its line budget is a hard gate).

import { isViewerOnly } from './store-config-keys';

const BOOT_FLAVOR_LINES = [
  'Warming up the fluorescents…',
  'Rewinding the returns…',
  'Facing out the new releases…',
  'Dusting the candy counter…',
  'Balancing the register…',
  'Stocking the staff picks…',
  'Queuing the previews…',
];

let bootFlavorTimer: ReturnType<typeof setInterval> | null = null;
let bootFlavorIdx = 0;

export function initBootLoader(): void {
  const viewer = isViewerOnly();
  const loader = document.getElementById('boot-loader');
  const panel = document.getElementById('boot-console-panel');
  // Explicit display, not the `hidden` attribute alone: .boot-console sets
  // display:flex, which (author origin) defeats the UA stylesheet's [hidden]
  // rule — both panels used to render on the public side, which is exactly
  // what the attribute was supposed to prevent. The viewer sees the friendly
  // loader ONLY; the owner sees the ops log ONLY. Full detail still reaches
  // console.log and the dev-console for either.
  if (loader) {
    loader.hidden = !viewer;
    loader.style.display = viewer ? '' : 'none';
  }
  if (panel) {
    panel.hidden = viewer;
    panel.style.display = viewer ? 'none' : '';
  }
  if (!viewer || bootFlavorTimer !== null) return;
  bootFlavorTimer = setInterval(() => {
    const el = document.getElementById('boot-flavor');
    if (!el) return;
    el.classList.add('swap');
    setTimeout(() => {
      bootFlavorIdx = (bootFlavorIdx + 1) % BOOT_FLAVOR_LINES.length;
      el.textContent = BOOT_FLAVOR_LINES[bootFlavorIdx];
      el.classList.remove('swap');
    }, 400);
  }, 2600);
}

/** Map a raw [System] boot line to a friendly status for the public loader. */
export function friendlyBootStatus(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes('planning the store floor')) return 'Planning the aisles…';
  if (m.includes('loading store textures')) return 'Stocking the shelves…';
  if (m.includes('textures finished decoding')) return 'Stocking the shelves…';
  if (m.includes('all textures loaded') || m.includes('store ready')) return 'Ready — opening the doors…';
  if (m.includes('signing') || m.includes('plex')) return 'Checking your library card…';
  if (m.includes('librar')) return 'Fetching your libraries…';
  if (m.includes('staff pick')) return 'Shelving the staff picks…';
  if (m.includes('coming-soon') || m.includes('coming soon')) return 'Shelving the staff picks…';
  if (m.includes('jellyseerr')) return 'Shelving the staff picks…';
  if (m.includes('video games') || m.includes('romm') || m.includes('games department')) return 'Building the games department…';
  if (m.includes('webgl context lost')) return 'One moment — resetting the projector…';
  if (m.includes('applying store changes')) return 'Re-arranging the store…';
  return null; // anything else keeps the current line
}

/**
 * Feed a raw [System] line from main.ts's logToConsole: the one call the
 * log path needs. No-op outside the viewer loader (the owner console shows
 * the raw log, and the overlay is hidden after boot anyway).
 */
export function feedBootLoader(message: string): void {
  const friendly = friendlyBootStatus(message);
  if (friendly) setBootStatus(friendly);
}

export function setBootStatus(text: string): void {
  const el = document.getElementById('boot-status');
  if (el && isViewerOnly()) el.textContent = text;
}

export function setBootProgress(pct: number): void {
  const el = document.getElementById('boot-progress-fill') as HTMLElement | null;
  if (el && isViewerOnly()) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

/**
 * The texture-load progress hook's viewer half: percent on the bar. main.ts
 * calls it with every (loaded, total) tick; the log throttling stays there.
 */
export function setBootProgressRatio(loaded: number, total: number): void {
  if (total <= 0) return;
  setBootProgress((loaded / total) * 100);
}

/**
 * Reveal when the shelves are READY ENOUGH, not when the slowest title in
 * the catalog finishes: one hung poster URL used to hold the whole store
 * behind the overlay. 90% settled (or 20s, whichever first) opens the
 * doors; the remaining art streams in via loadShelfDetails exactly as it
 * does when browsing past an unloaded section today.
 */
export function openRevealGate(
  scene: { onTextureLoadProgress?: ((loaded: number, total: number) => void) | null; texturesReadyPromise: Promise<void> },
): Promise<void> {
  const REVEAL_AT_PCT = 90;
  const REVEAL_TIMEOUT_MS = 20_000;
  return new Promise<void>((resolve) => {
    let settledCount = 0;
    let total = 0;
    const origProgress = scene.onTextureLoadProgress;
    scene.onTextureLoadProgress = (loaded, t) => {
      settledCount = loaded; total = t;
      origProgress?.(loaded, t);
      if (total > 0 && (settledCount / total) * 100 >= REVEAL_AT_PCT) resolve();
    };
    setTimeout(resolve, REVEAL_TIMEOUT_MS);
    scene.texturesReadyPromise.then(() => resolve());
  });
}

/**
 * The renderer exists, so the GPU verdict is in. A software-rendered machine
 * is the answer to "why is the store slow on a good PC" — say so on the
 * loader while it is still up, in plain words, instead of leaving the verdict
 * in a console log nobody opens. Called right after the StoreScene builds.
 */
export async function warnIfSoftwareGpu(): Promise<void> {
  try {
    const { gpuVerdict } = await import('./three-scene');
    if (gpuVerdict && gpuVerdict.software && isViewerOnly()) {
      setBootStatus('This device is drawing the store without a graphics card — it will run slowly.');
    }
  } catch {
    // three-scene failed to import — the boot error path reports that anyway.
  }
}
