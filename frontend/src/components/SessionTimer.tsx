import { useState, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { Clock } from 'lucide-preact';

interface Props {
  onExpired: () => void;
}

export function SessionTimer({ onExpired }: Props) {
  const [remaining, setRemaining] = useState(session.remainingSeconds());

  useEffect(() => {
    // If no expiry time is set, don't start the timer
    if (remaining <= 0) {
      return;
    }

    const timer = setInterval(() => {
      const secs = session.remainingSeconds();
      setRemaining(secs);
      if (secs <= 0) {
        clearInterval(timer);
        // Session expired — clear client state and notify parent
        // The server-side cookie is also expired (httpOnly)
        session.clear();
        onExpired();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [onExpired, remaining]);

  // Don't show timer if we don't know the expiry time
  if (remaining <= 0) {
    return null;
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const isLow = remaining <= 60;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        color: isLow ? 'var(--danger)' : 'var(--text-muted)',
        fontSize: '12px',
        cursor: 'default',
      }}
      title={isLow ? 'Session is about to expire' : 'Session time remaining'}
    >
      <Clock size={14} />
      {mins}:{secs.toString().padStart(2, '0')}
    </span>
  );
}
