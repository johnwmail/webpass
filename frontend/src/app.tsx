import { useState, useEffect, useCallback } from 'preact/hooks';
import { Welcome } from './components/Welcome';
import { Setup } from './components/Setup';
import { MainApp } from './components/MainApp';
import { session } from './lib/session';

type Route = 'welcome' | 'setup' | 'main';

export function App() {
  const [route, setRoute] = useState<Route>('welcome');
  const [, setTick] = useState(0);

  useEffect(() => {
    return session.subscribe(() => setTick((t) => t + 1));
  }, []);

  const goToSetup = useCallback(() => setRoute('setup'), []);
  const goToWelcome = useCallback(() => {
    session.clear();
    setRoute('welcome');
  }, []);
  const goToMain = useCallback(() => setRoute('main'), []);

  if (route === 'setup') {
    return <Setup onComplete={goToWelcome} onCancel={goToWelcome} onAuthenticated={goToMain} />;
  }

  if (route === 'main' && session.isActive()) {
    return <MainApp onLock={goToWelcome} />;
  }

  return <Welcome onSetup={goToSetup} onLogin={goToMain} />;
}
