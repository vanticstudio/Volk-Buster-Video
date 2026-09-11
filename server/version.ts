/**
 * The one place the app's own version is read from package.json.
 *
 * server/index.ts used to hardcode '0.15.0' in two spots (the Plex identity
 * for the front door and the admin server), which is how a version string
 * drifts: bump package.json, forget the two literals, and the management
 * console reports a version the build no longer is. Reading it here keeps
 * package.json the single source of truth.
 */
import { readFileSync } from 'node:fs';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const APP_VERSION = readVersion();
