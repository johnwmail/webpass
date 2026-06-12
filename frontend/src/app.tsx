import { useState, useEffect, useCallback } from 'preact/hooks';
import { session } from './lib/session';
import { Welcome } from './components/Welcome';
import { Setup } from './components/Setup';
import { MainApp } from './components/MainApp';

// Expose session for E2E tests (e.g. to override auto-lock timeout)
if (typeof window !== 'undefined') {
  (window as any).__webpass = { session };
}

type Route = 'welcome' | 'setup' | 'main';

export function App() {
  const [route, setRoute] = useState<Route>(
    session.isActive() ? 'main' : 'welcome'
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    return session.subscribe(() => setTick((t) => t + 1));
  }, []);

  const goToSetup = useCallback(() => setRoute('setup'), []);
  const goToWelcome = useCallback(async () => {
    if (session.api) {
      try {
        await session.api.logout();
      } catch {}
    }
    session.clear();
    setRoute('welcome');
  }, []);
  const goToMain = useCallback(() => setRoute('main'), []);

  useEffect(() => {
    const handler = () => { void goToWelcome(); };
    window.addEventListener('session-expired', handler);
    return () => window.removeEventListener('session-expired', handler);
  }, [goToWelcome]);

  if (route === 'setup') {
    return <div class="route-view"><Setup onComplete={goToWelcome} onCancel={goToWelcome} onAuthenticated={goToMain} /></div>;
  }

  if (route === 'main' && session.isActive()) {
    return <div class="route-view"><MainApp onLock={goToWelcome} /></div>;
  }

  return <div class="route-view"><Welcome onSetup={goToSetup} onLogin={goToMain} /></div>;
}
