import { useState, useEffect, useCallback } from 'preact/hooks';
import { createElement } from 'preact';
import type { ComponentType } from 'preact';
import { session } from './lib/session';
import './diag';

// Expose session for E2E tests (e.g. to override auto-lock timeout)
if (typeof window !== 'undefined') {
  (window as any).__webpass = { session };
}

function RouteFallback() {
  return (
    <div class="route-loading">
      <span class="spinner" /> Loading...
    </div>
  );
}

type Route = 'welcome' | 'setup' | 'main';
type Comp = ComponentType<any> | null;

export function App() {
  const [route, setRoute] = useState<Route>(
    session.isActive() ? 'main' : 'welcome'
  );
  const [Welcome, setWelcome] = useState<Comp>(null);
  const [Setup, setSetup] = useState<Comp>(null);
  const [Main, setMain] = useState<Comp>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    import('./components/Welcome').then((m) => setWelcome(() => m.Welcome));
    import('./components/Setup').then((m) => setSetup(() => m.Setup));
    import('./components/MainApp').then((m) => setMain(() => m.MainApp));
  }, []);

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
    if (!Setup) return <RouteFallback />;
    return createElement(Setup, {
      onComplete: goToWelcome,
      onCancel: goToWelcome,
      onAuthenticated: goToMain,
    });
  }

  if (route === 'main' && session.isActive()) {
    if (!Main) return <RouteFallback />;
    return createElement(Main, { onLock: goToWelcome });
  }

  if (!Welcome) return <RouteFallback />;
  return createElement(Welcome, { onSetup: goToSetup, onLogin: goToMain });
}
