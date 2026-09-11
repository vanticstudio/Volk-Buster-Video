// The SERVICE MODE performance diagnostic, as a live hint.
//
// The tracer (perf-trace.ts) is always on and attributes every hitch to a
// named span; the scene's getPerfInfo() already exposes tier, draw calls and
// the resolution scale. This module composes the two into the one-screen
// verdict a kiosk owner can read without devtools: select the row in the
// settings drawer's SERVICE MODE page and the footer bar prints it.
//
// There is deliberately no scripted sweep: the person holding the remote IS
// the sweep. Browse around for a few seconds, then reopen this row — the
// numbers cover the tracer's ring (~2000 frames), which reaches back far
// enough to include whatever they just did. Registration lives in
// settings.ts (hidden: true → SERVICE MODE page only); this module stays
// node-testable and DOM-free.

import type { GpuVerdict } from './three-scene';

interface TraceReport {
  frames: number;
  dtMs: { p50: number; p90: number; p99: number; max: number; mean: number };
  slotTotals: Record<string, number>;
  slotMaxPerFrame: Record<string, number>;
  hitches: Array<{ dt: number; slots: Record<string, number> }>;
}

interface PerfInfo {
  tier: string;
  isRendering: boolean;
  resScale: number;
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  composites: number;
  partials: number;
}

/** One plain-language line for the adapter verdict. */
function gpuLine(v: GpuVerdict | null): string {
  if (!v) return 'GPU: not measured yet.';
  if (v.software) return 'GPU: SOFTWARE RENDERING (no GPU acceleration) — the store will be slow on any machine.';
  if (v.integrated) return `GPU: integrated (${v.name}) — medium tier.`;
  return `GPU: ${v.name} — ${v.tier} tier.`;
}

/**
 * The verdict string. Long by design — the footer bar clips to 62 chars, so
 * the FIRST line always carries the headline (frame time + the verdict), and
 * the rest is detail for the F8 log / console where it is not clipped.
 */
export function perfDiagnostic(): string {
  const scene = (window as unknown as { storeScene?: { getPerfInfo(): PerfInfo & { resScale: number; partialArmed?: boolean } } }).storeScene;
  const trace = (window as unknown as { __perfTrace?: { report(): TraceReport } }).__perfTrace;
  const verdict = (window as unknown as { __gpuVerdict?: GpuVerdict | null }).__gpuVerdict ?? null;

  const lines: string[] = [];
  lines.push(gpuLine(verdict));

  if (!scene || !trace) {
    lines.push('Scene not built yet — wait for the store, then reopen this row.');
    return lines.join(' ');
  }

  const info = scene.getPerfInfo();
  const report = trace.report();

  if (report.frames < 30) {
    lines.push('Not enough frames yet — browse for a few seconds, then reopen this row.');
    return lines.join(' ');
  }

  const p50 = report.dtMs.p50;
  const fps = p50 > 0 ? Math.round(1000 / p50) : 0;
  lines.push(`Frames: ${fps}fps median (${p50.toFixed(1)}ms p50, ${report.dtMs.p90.toFixed(1)} p90, worst ${report.dtMs.max.toFixed(0)}ms over ${report.frames}f).`);
  lines.push(`Tier ${info.tier} · res ${(info.resScale * 100).toFixed(0)}% · ${info.calls} draw calls · ${info.textures} textures.`);

  // The worst hitch's attributed spans: WHAT the frame spent its time on.
  const worst = report.hitches.length
    ? report.hitches.reduce((a, b) => (b.dt > a.dt ? b : a))
    : null;
  if (worst) {
    const parts = Object.entries(worst.slots)
      .filter(([, v]) => v > 1)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 3)
      .map(([k, v]) => `${k} ${Math.round(v)}ms`);
    lines.push(`Worst hitch ${Math.round(worst.dt)}ms: ${parts.length ? parts.join(', ') : 'no spans — GPU backpressure'}.`);
  }

  lines.push(`Composites ${info.composites} full / ${info.partials} partial. Opening the console and typing __perfTrace.report() gives the full hitch log.`);
  return lines.join(' ');
}