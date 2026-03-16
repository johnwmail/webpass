// Version information injected at build time via Vite define
// Falls back to reading from DOM meta tags if not available
const injectedVersion = import.meta.env.FRONTEND_VERSION as string;
const metaVersion = typeof document !== 'undefined' 
  ? document.querySelector('meta[name="build-version"]')?.getAttribute('content') 
  : null;

export const VERSION = (injectedVersion && injectedVersion !== 'vdev') ? injectedVersion : (metaVersion || 'vdev');

const injectedCommit = import.meta.env.FRONTEND_COMMIT as string;
const metaCommit = typeof document !== 'undefined' 
  ? document.querySelector('meta[name="build-commit"]')?.getAttribute('content') 
  : null;

export const COMMIT = (injectedCommit && injectedCommit !== 'unknown') ? injectedCommit : (metaCommit || 'unknown');

const injectedTime = import.meta.env.FRONTEND_BUILD_TIME as string;
const metaTime = typeof document !== 'undefined' 
  ? document.querySelector('meta[name="build-time"]')?.getAttribute('content') 
  : null;

export const BUILD_TIME = (injectedTime && injectedTime !== 'unknown') ? injectedTime : (metaTime || 'unknown');
