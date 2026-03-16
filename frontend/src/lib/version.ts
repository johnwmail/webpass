// Version information injected at build time via Vite define
// Falls back to reading from DOM meta tags if not available
export const VERSION = (import.meta.env.FRONTEND_VERSION as string) 
  || document.querySelector('meta[name="build-version"]')?.getAttribute('content') 
  || 'vdev';

export const COMMIT = (import.meta.env.FRONTEND_COMMIT as string) 
  || document.querySelector('meta[name="build-commit"]')?.getAttribute('content') 
  || 'unknown';

export const BUILD_TIME = (import.meta.env.FRONTEND_BUILD_TIME as string) 
  || document.querySelector('meta[name="build-time"]')?.getAttribute('content') 
  || 'unknown';
