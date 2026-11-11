import { useEffect, useRef } from 'preact/hooks';
import { session } from '../lib/session';

/**
 * Calls `onLock` when the cached PGP key transitions from unlocked to locked
 * (idle timeout, manual lock, logout). The callback is kept in a ref so callers
 * do not need a stable identity.
 */
export function useKeyLock(onLock: () => void): void {
  const callbackRef = useRef(onLock);
  callbackRef.current = onLock;

  useEffect(() => {
    let wasUnlocked = session.keyRemainingSeconds() > 0;
    return session.subscribe(() => {
      const unlocked = session.keyRemainingSeconds() > 0;
      if (wasUnlocked && !unlocked) {
        callbackRef.current();
      }
      wasUnlocked = unlocked;
    });
  }, []);
}
