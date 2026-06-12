import { render } from 'preact';
import { App } from './app';
import './style.css';

render(<App />, document.getElementById('app')!);

// Warm-start openpgp fetch after first paint so crypto ops don't wait
// for a large chunk download when user first needs it
import('openpgp');
