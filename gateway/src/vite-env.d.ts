/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** MUI X Pro licence key, injected at build time. See src/muiLicense.ts. */
  readonly VITE_MUI_X_LICENSE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
