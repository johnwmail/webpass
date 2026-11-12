import { useState, useEffect, useCallback } from 'preact/hooks';
import { session } from './lib/session';
import { Welcome } from './components/Welcome';
import { Setup } from './components/Setup';
import { MainApp } from './components/MainApp';
import { TransferRestore } from './components/TransferRestore';

// Expose session for E2E tests (e.g. to override auto-lock timeout)
if (typeof window !== 'undefined') {
  (window as any).__webpass = { session };
}

type Route = 'welcome' | 'setup' | 'main';

interface TransferParams {
  apiUrl: string;
  fingerprint: string;
  token: string;
}

function parseTransferParams(): TransferParams | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash.startsWith('#/transfer')) return null;
  const queryIndex = hash.indexOf('?');
  const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : '');
  const apiUrl = params.get('api');
  const fingerprint = params.get('fp');
  const token = params.get('t');
  if (!apiUrl || !fingerprint || !token) return null;
  return { apiUrl, fingerprint, token };
}

function clearTransferHash(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

export function App() {
  const [route, setRoute] = useState<Route>(
    session.isActive() ? 'main' : 'welcome'
  );
  const [transferParams, setTransferParams] = useState<TransferParams | null>(parseTransferParams);
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

  if (transferParams) {
    return (
      <div class="route-view">
        <TransferRestore
          {...transferParams}
          onComplete={() => {
            clearTransferHash();
            setTransferParams(null);
            setRoute('main');
          }}
          onCancel={() => {
            clearTransferHash();
            setTransferParams(null);
            setRoute(session.isActive() ? 'main' : 'welcome');
          }}
        />
      </div>
    );
  }

  if (route === 'setup') {
    return <div class="route-view"><Setup onComplete={goToWelcome} onCancel={goToWelcome} onAuthenticated={goToMain} /></div>;
  }

  if (route === 'main' && session.isActive()) {
    return <div class="route-view"><MainApp onLock={goToWelcome} /></div>;
  }

  return <div class="route-view"><Welcome onSetup={goToSetup} onLogin={goToMain} /></div>;
}
