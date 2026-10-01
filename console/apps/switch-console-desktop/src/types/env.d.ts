/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Switch Cloud's origin for a packaged build; see `main/core/switch-servers/switch-cloud.ts`. */
  readonly MAIN_VITE_SWITCH_CLOUD_URL?: string;
}
