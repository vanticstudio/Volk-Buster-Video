// Backend registration — the one file that names every server product this
// build can talk to (GH #32). Importing this module is what makes the kinds
// available; `createProvider('jellyfin')` throws until it has run.
//
// Adding a backend: implement MediaSourceProvider in a sibling file, add one
// registerProvider line here, done. Nothing in the store's own code changes.
import { registerProvider } from './provider-registry';
import { PlexProvider } from './plex-provider';

let registered = false;

/** Idempotent: the boot flow and the harness can both call this. */
export function registerBuiltInProviders(): void {
  if (registered) return;
  registered = true;
  registerProvider('plex', () => new PlexProvider());
  // This fork is deliberately Plex-only (see
  // docs/architecture/2026-09-06-plex-only-streaming-fork.md): access is gated
  // on Plex library sharing, so a second backend would need its own answer to
  // "is this viewer allowed in" and there is no second answer to give.
  //
  // The registry itself is kept. It is the only build-enforced boundary in the
  // codebase (tools/check-provider-boundary.mjs), it costs nothing to keep at
  // one implementation, and it is what stops Plex specifics leaking back into
  // the store's own code.
}

export { PlexProvider, PLEX_CAPABILITIES } from './plex-provider';
export {
  registerProvider,
  createProvider,
  listProviderKinds,
  hasProvider,
  DEFAULT_PROVIDER_KIND,
} from './provider-registry';
export type * from './media-source-provider';
