// Which media-server backends this build knows how to talk to (GH #32).
//
// Same shape as fixture-registry.ts: backends register a factory under a kind,
// and the boot flow creates one by name. Adding a backend is one new module
// plus one line here — the store's own code never names a server product.
//
// Only `import type` above the fold, so this module still runs under
// `node --test` type-stripping (tests/provider-registry.test.ts); the
// implementations it stores drag in Tauri and DOM globals a test process can't
// load, which is exactly why the registry keeps FACTORIES rather than
// instances. Nothing is constructed until someone asks for it by name.
import type { MediaSourceProvider } from './media-source-provider.ts';

export type ProviderFactory = () => MediaSourceProvider;

const registry = new Map<string, ProviderFactory>();

/** The kind assumed when an install has no `provider_kind` on disk.
 *
 *  Upstream defaulted to Jellyfin so that installs predating the provider
 *  boundary kept booting into their own library untouched. This fork has no
 *  such installs to protect — it is Plex-only and deployed fresh — so the
 *  default is simply the one backend that exists. */
export const DEFAULT_PROVIDER_KIND = 'plex';

/** Where the chosen backend is remembered. Lives here rather than in
 *  active-provider.ts because reading it must not drag in the registered
 *  implementations: playback-routing.ts needs the KIND on a hot, synchronous
 *  path, and tests need it without loading Tauri. active-provider.ts
 *  re-exports both for its existing callers. */
export const PROVIDER_KIND_KEY = 'provider_kind';

/** Which backend THIS INSTALL is pointed at. Absent until the setup flow
 *  writes it, which is why it falls back to the default rather than prompting. */
export function activeProviderKind(): string {
  try {
    return localStorage.getItem(PROVIDER_KIND_KEY) || DEFAULT_PROVIDER_KIND;
  } catch {
    // Private-mode/locked storage: still open, on the backend everyone uses.
    return DEFAULT_PROVIDER_KIND;
  }
}

export function registerProvider(kind: string, factory: ProviderFactory): void {
  registry.set(kind, factory);
}

/** Every registered kind, for the setup screen's server picker and tooling. */
export function listProviderKinds(): string[] {
  return [...registry.keys()].sort();
}

export function hasProvider(kind: string): boolean {
  return registry.has(kind);
}

/**
 * Build the provider for `kind`. Throws on an unknown kind rather than falling
 * back to Jellyfin: a stored `provider_kind` this build doesn't carry means the
 * user downgraded, or a backend was dropped, and silently stocking the store
 * from the wrong server would read as data loss. Callers that want the
 * forgiving behaviour ask for DEFAULT_PROVIDER_KIND explicitly.
 */
export function createProvider(kind: string): MediaSourceProvider {
  const factory = registry.get(kind);
  if (!factory) {
    const known = listProviderKinds().join(', ') || 'none registered';
    throw new Error(`Unknown media-source provider: ${kind} (known: ${known})`);
  }
  return factory();
}

/** Test seam — the registry is module-global, so a test that registers a fake
 *  would otherwise leak into the next one. Not called by app code. */
export function resetProviderRegistry(): void {
  registry.clear();
}
