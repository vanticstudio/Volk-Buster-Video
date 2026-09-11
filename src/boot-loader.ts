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
  if (loader) loader.hidden = !viewer;
  if (panel) panel.hidden = viewer;
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

export function setBootStatus(text: string): void {
  const el = document.getElementById('boot-status');
  if (el && isViewerOnly()) el.textContent = text;
}

export function setBootProgress(pct: number): void {
  const el = document.getElementById('boot-progress-fill') as HTMLElement | null;
  if (el && isViewerOnly()) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
