/**
 * Helpers for tests that depend on a Git server.
 *
 * The git-sync E2E tests talk to a real repository configured through
 * WEBPASS_REPO_URL. That server is outside our control, so an outage must
 * not fail the whole CI run: probe it first and skip the tests instead.
 *
 * A local bare repository (file://) is also supported so CI does not need
 * an external Gitea/GitHub instance at all.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const probeCache = new Map<string, Promise<boolean>>();

/**
 * Returns true when the Git server hosting repoURL is reachable and not
 * reporting a server-side outage.
 *
 * A private repository normally answers 401/403 (or 404) without
 * credentials, which still proves the server is healthy. Only network
 * errors and 5xx responses are treated as unavailable.
 */
export function isGitServerAvailable(repoURL: string): Promise<boolean> {
  if (!repoURL) {
    return Promise.resolve(false);
  }

  const cached = probeCache.get(repoURL);
  if (cached) {
    return cached;
  }

  // Local bare repositories need no network: just check the path exists.
  if (repoURL.startsWith('file://') || repoURL.startsWith('/')) {
    try {
      const path = repoURL.startsWith('file://') ? fileURLToPath(repoURL) : repoURL;
      return Promise.resolve(existsSync(path));
    } catch {
      return Promise.resolve(false);
    }
  }

  const probe = (async () => {
    const base = repoURL.replace(/\/+$/, '');
    try {
      const res = await fetch(`${base}/info/refs?service=git-upload-pack`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return res.status < 500;
    } catch {
      return false;
    }
  })();

  probeCache.set(repoURL, probe);
  return probe;
}
