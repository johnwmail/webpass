import { useState, useRef, useCallback, useEffect } from 'preact/hooks';

export function useAutoHide(autoHideSeconds = 15) {
  const [isVisible, setIsVisible] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [autoHidden, setAutoHidden] = useState(false);

  const hideTimerRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (countdownRef.current) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  const show = useCallback(() => {
    clearTimers();
    setIsVisible(true);
    setTimeRemaining(autoHideSeconds);

    countdownRef.current = window.setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    hideTimerRef.current = window.setTimeout(() => {
      setIsVisible(false);
      setTimeRemaining(0);
      setAutoHidden(true);
      setTimeout(() => setAutoHidden(false), 3000);
    }, autoHideSeconds * 1000);
  }, [autoHideSeconds, clearTimers]);

  const hide = useCallback(() => {
    clearTimers();
    setIsVisible(false);
    setTimeRemaining(0);
  }, [clearTimers]);

  const toggle = useCallback(() => {
    if (isVisible) {
      hide();
    } else {
      show();
    }
  }, [isVisible, show, hide]);

  useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  return {
    isVisible,
    timeRemaining,
    autoHidden,
    show,
    hide,
    toggle,
  };
}
