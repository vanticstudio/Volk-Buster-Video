/**
 * Update manager for the management console.
 *
 * Checks GitHub for a newer release and applies it by running the existing
 * deploy/update.sh — the same script an operator would run by hand, which
 * pulls the source, rebuilds the image, and replaces the container while the
 * data volume (sessions, keys, the chosen Plex server) survives untouched.
 *
 * Two deliberate limits:
 *  - The check is cached for an hour so the console is not a GitHub polling
 *    client on every page load.
 *  - applyUpdate() is a single in-flight job: a second click while one is
 *    running returns the same job id rather than stacking two docker builds.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { APP_VERSION } from './version.ts';

const REPO = 'vanticstudio/Volk-Buster-Video';
const CHECK_TTL_MS = 60 * 60_000;
const UPDATE_SCRIPT = new URL('../deploy/update.sh', import.meta.url).pathname;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  publishedAt: string | null;
  notes: string | null;
  url: string | null;
  behind: boolean;
  checkedAt: number;
  error?: string;
}

interface ReleaseJson {
  tag_name?: string;
  name?: string;
  published_at?: string;
  body?: string;
  html_url?: string;
}

let cached: UpdateInfo | null = null;

function normalizeTag(tag: string | undefined): string | null {
  if (!tag) return null;
  return tag.replace(/^v/i, '');
}

/** Compare two semver-ish versions. Returns true when `latest` is newer. */
function isNewer(current: string, latest: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = latest.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

export async function checkForUpdates(now: () => number = Date.now): Promise<UpdateInfo> {
  if (cached && now() - cached.checkedAt < CHECK_TTL_MS) return cached;
  const base: UpdateInfo = {
    current: APP_VERSION,
    latest: null,
    publishedAt: null,
    notes: null,
    url: null,
    behind: false,
    checkedAt: now(),
  };
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'volkbuster-update-check' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const releases = (await res.json()) as ReleaseJson[];
    const rel = releases[0];
    const latest = normalizeTag(rel?.tag_name || rel?.name);
    const info: UpdateInfo = {
      ...base,
      latest,
      publishedAt: rel?.published_at ?? null,
      notes: rel?.body ? rel.body.slice(0, 4000) : null,
      url: rel?.html_url ?? null,
      behind: latest ? isNewer(APP_VERSION, latest) : false,
    };
    cached = info;
    return info;
  } catch (err) {
    const info: UpdateInfo = { ...base, error: err instanceof Error ? err.message : String(err) };
    // NOT cached. A transient GitHub 403/timeout cached for the full TTL hid
    // "update available" for an hour; a failed check just retries on the next
    // console load. Only a SUCCESSFUL check earns the TTL.
    return info;
  }
}

// ─── Applying an update ─────────────────────────────────────────────────────

export interface UpdateJob {
  id: string;
  startedAt: number;
  done: boolean;
  ok: boolean | null;
  log: string;
}

let currentJob: UpdateJob | null = null;

export function updateAvailable(): boolean {
  return existsSync(UPDATE_SCRIPT);
}

// An update that runs this long has wedged (a docker build stuck on a dead
// network is the classic): mark the job failed so the console stops polling
// and the owner can try again, rather than the single-flight job blocking
// every future apply until the process restarts.
const UPDATE_JOB_TIMEOUT_MS = 20 * 60_000;

export function startUpdate(now: () => number = Date.now): UpdateJob {
  if (currentJob && !currentJob.done) return currentJob;
  const job: UpdateJob = {
    id: `upd-${now().toString(36)}`,
    startedAt: now(),
    done: false,
    ok: null,
    log: '',
  };
  currentJob = job;

  const child = spawn('sh', [UPDATE_SCRIPT], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timeout = setTimeout(() => {
    if (job.done) return;
    job.log += `\nupdate aborted: no exit within ${Math.round(UPDATE_JOB_TIMEOUT_MS / 60_000)} minutes (killed — the build likely wedged)`;
    job.done = true;
    job.ok = false;
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }, UPDATE_JOB_TIMEOUT_MS);
  const append = (chunk: Buffer) => {
    job.log += chunk.toString('utf8');
    if (job.log.length > 64 * 1024) job.log = job.log.slice(-64 * 1024);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    clearTimeout(timeout);
    job.done = true;
    job.ok = code === 0;
  });
  child.on('error', (err) => {
    clearTimeout(timeout);
    job.done = true;
    job.ok = false;
    job.log += `\nspawn failed: ${err.message}`;
  });
  return job;
}

export function updateStatus(id: string): UpdateJob | null {
  return currentJob && currentJob.id === id ? currentJob : null;
}
