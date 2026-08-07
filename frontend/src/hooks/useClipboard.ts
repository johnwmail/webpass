import { useState, useCallback, useRef, useEffect } from 'preact/hooks';

interface UseClipboardOptions {
  clearAfterMs?: number;
}

export function useClipboard({ clearAfterMs = 30000 }: UseClipboardOptions = {}) {
  const [copied, setCopied] = useState(false);
  const clearTimerRef = useRef<number | null>(null);
  const pendingClearRef = useRef<boolean>(false);

  const clearClipboard = useCallback(async () => {
    try {
      if (document.hasFocus() && document.visibilityState === 'visible') {
        await navigator.clipboard.writeText('');
        pendingClearRef.current = false;
      } else {
        // Document is not focused; mark pending clear so focus handler can execute it
        pendingClearRef.current = true;
      }
    } catch {
      // Browser permission error or unfocused document
      pendingClearRef.current = true;
    }
  }, []);

  const copyToClipboard = useCallback(
    async (text: string) => {
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        pendingClearRef.current = false;

        // Reset visual copied indicator after 2s
        window.setTimeout(() => setCopied(false), 2000);

        // Schedule clipboard wipe
        if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
        clearTimerRef.current = window.setTimeout(() => {
          clearClipboard();
        }, clearAfterMs);

        return true;
      } catch (err) {
        console.warn('Clipboard write failed:', err);
        return false;
      }
    },
    [clearAfterMs, clearClipboard]
  );

  // Handle window focus/visibility changes to clear pending wipes
  useEffect(() => {
    const handleFocus = () => {
      if (pendingClearRef.current) {
        clearClipboard();
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, [clearClipboard]);

  return { copied, copyToClipboard };
}
