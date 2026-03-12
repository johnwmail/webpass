// Version information injected at build time via Vite define
export const VERSION = import.meta.env.FRONTEND_VERSION || 'vdev';
export const COMMIT = import.meta.env.FRONTEND_COMMIT || 'unknown';
export const BUILD_TIME = import.meta.env.FRONTEND_BUILD_TIME || 'unknown';
