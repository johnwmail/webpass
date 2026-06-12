import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { session } from './lib/session';

// Expose session for E2E tests (e.g. to override auto-lock timeout)
if (typeof window !== 'undefined') {
  (window as any).__webpass = { session };
}

const Welcome = lazy(() => import('./components/Welcome').then((m) => ({ default: m.Welcome })));
const Setup = lazy(() => import('./components/Setup').then((m) => ({ default: m.Setup })));
const MainApp = lazy(() => import('./components/MainApp').then((m) => ({ default: m.MainApp })));

function RouteFallback() {
  return (
    <div class="route-loading">
      <span class="spinner" /> Loading...
    </div>
  );
}

type Route = 'welcome' | 'setup' | 'main';

export function App() {
  const [route, setRoute] = useState<Route>(
    // Check if session is active on initial load
    session.isActive() ? 'main' : 'welcome'
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    return session.subscribe(() => setTick((t) => t + 1));
  }, []);

  const goToSetup = useCallback(() => setRoute('setup'), []);
  const goToWelcome = useCallback(async () => {
    // Call logout endpoint to clear auth cookie
    if (session.api) {
      try {
        await session.api.logout();
      } catch {
        // Ignore logout errors (cookie will still be cleared by session.clear())
      }
    }
    session.clear();
    setRoute('welcome');
  }, []);
  const goToMain = useCallback(() => setRoute('main'), []);

  useEffect(() => {
    const handler = () => {
      void goToWelcome();
    };
    window.addEventListener('session-expired', handler);
    return () => window.removeEventListener('session-expired', handler);
  }, [goToWelcome]);

  if (route === 'setup') {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Setup onComplete={goToWelcome} onCancel={goToWelcome} onAuthenticated={goToMain} />
      </Suspense>
    );
  }

  if (route === 'main' && session.isActive()) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <MainApp onLock={goToWelcome} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Welcome onSetup={goToSetup} onLogin={goToMain} />
    </Suspense>
  );
}
