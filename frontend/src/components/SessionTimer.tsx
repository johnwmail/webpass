import { useState, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { Clock } from 'lucide-preact';

interface Props {
  onExpired: () => void;
}

export function SessionTimer({ onExpired }: Props) {
  const [remaining, setRemaining] = useState(session.remainingSeconds());

  useEffect(() => {
    // With cookie-based auth, remainingSeconds() returns 0 but session doesn't expire client-side
    // The server validates cookie expiry on each request
    // So we skip the timer when remaining is 0 (cookie auth mode)
    if (remaining === 0) {
      return;
    }
    
    const timer = setInterval(() => {
      const secs = session.remainingSeconds();
      setRemaining(secs);
      if (secs <= 0) {
        clearInterval(timer);
        session.clear();
        onExpired();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [onExpired, remaining]);

  // Don't show timer for cookie-based auth (remaining === 0)
  if (remaining === 0) {
    return null;
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const isLow = remaining < 60;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      color: isLow ? 'var(--danger)' : 'var(--text-muted)',
      fontSize: '12px'
    }}>
      <Clock size={14} />
      {mins}:{secs.toString().padStart(2, '0')}
    </span>
  );
}
