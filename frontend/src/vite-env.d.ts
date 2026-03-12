/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly FRONTEND_VERSION: string;
  readonly FRONTEND_COMMIT: string;
  readonly FRONTEND_BUILD_TIME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
