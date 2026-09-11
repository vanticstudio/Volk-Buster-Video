/// <reference types="vite/client" />

// Build-time substitution from package.json (vite.config.ts's define). Every
// version consumer — failure reports, the server's Plex identity — must read
// THIS, never a literal; the last literal drifted four releases.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_DEMO?: string;
  readonly VITE_JELLYFIN_URL?: string;
  readonly VITE_JELLYFIN_USERNAME?: string;
  readonly VITE_JELLYFIN_PASSWORD?: string;
  readonly VITE_JELLYSEERR_URL?: string;
  readonly VITE_JELLYSEERR_APIKEY?: string;
  readonly VITE_ROMM_URL?: string;
  readonly VITE_ROMM_APIKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

