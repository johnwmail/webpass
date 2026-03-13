import { VERSION } from '../lib/version';
import { SessionTimer } from './SessionTimer';

interface Props {
  onSessionExpired?: () => void;
}

export function Footer({ onSessionExpired }: Props) {
  return (
    <footer class="app-footer">
      {onSessionExpired ? <SessionTimer onExpired={onSessionExpired} /> : null}
      <span class="footer-version" title="Frontend version">WebPass {VERSION}</span>
    </footer>
  );
}
