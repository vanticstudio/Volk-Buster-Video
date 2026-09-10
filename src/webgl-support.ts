/**
 * WebGL2 capability probe.
 *
 * This fork is stream-only: the 3D store is rendered by a headless instance on
 * the host and delivered to viewers as video, so a VIEWER's browser needs no
 * WebGL2 at all — it plays a stream and sends input. The only browser that must
 * have it is the instance itself.
 *
 * That inverts what this check is for. It is no longer a gate asking a visitor
 * to pick a simpler mode (the 2.5D store this fork removed); it is a diagnostic
 * that tells a REMOTE INSTANCE it landed on a host with no usable GPU, which is
 * precisely what a container without `/dev/dri` mapped in looks like. Reporting
 * that clearly is the difference between a fixable error and every viewer
 * parked on "Store is still booting…" forever.
 *
 * Extracted from the deleted device-gate.ts, which paired it with a modal
 * offering 2.5D as an alternative. Only the probe survives.
 */

/**
 * True when this browser can create a WebGL2 context.
 *
 * Immediately releases the probe context via `WEBGL_lose_context`: browsers cap
 * how many live WebGL contexts a page may hold, and the real renderer needs the
 * slot this probe would otherwise occupy for the life of the document.
 */
export function hasWebGL2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}
