import { useState, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { Clock } from 'lucide-preact';

interface Props {
  onExpired: () => void;
}

export function SessionTimer({ onExpired }: Props) {
  const [remaining, setRemaining] = useState(session.remainingSeconds());

  useEffect(() => {
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
  }, [onExpired]);

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
