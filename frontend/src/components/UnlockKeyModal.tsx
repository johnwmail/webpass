import { useState, useEffect, useRef } from 'preact/hooks';
import { KeyRound, X, Eye, EyeOff } from 'lucide-preact';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey } from '../lib/crypto';

interface Props {
  onClose: () => void;
  onUnlocked: () => void;
}

export function UnlockKeyModal({ onClose, onUnlocked }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleUnlock = async () => {
    if (!passphrase) return;
    setError('');
    setLoading(true);
    try {
      const fp = session.fingerprint;
      if (!fp) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');
      const privateKey = await decryptPrivateKey(account.privateKey, passphrase);
      session.setCachedPrivateKey(privateKey);
      onUnlocked();
    } catch (e: any) {
      setError(e.message || 'Failed to unlock key');
      setPassphrase('');
    }
    setLoading(false);
  };

  return (
    <div class="modal-overlay modal-overlay-no-blur" onClick={onClose}>
      <div class="modal" style="max-width: 420px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2><KeyRound size={18} style="margin-right: 8px; vertical-align: -2px;" /> Unlock PGP Key</h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div class="modal-body">
          <p style="margin-bottom: 16px; font-size: 14px; color: var(--text-muted);">
            Enter your PGP passphrase to decrypt your private key. The key will stay in memory until you lock it or the session expires.
          </p>
          <div class="field">
            <label class="label">PGP Passphrase</label>
            <div class="input-with-icon">
              <input
                ref={inputRef}
                class="input"
                type={showPassphrase ? 'text' : 'password'}
                value={passphrase}
                onInput={(e) => { setPassphrase((e.target as HTMLInputElement).value); setError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleUnlock(); }}
                placeholder="Enter your PGP passphrase"
                autocomplete="one-time-code"
                name="pgp-passphrase-unlock"
                data-lpignore="true"
                data-bwignore="true"
                data-1p-ignore="true"
                style={{ paddingRight: '40px' }}
              />
              <button
                type="button"
                class="btn btn-ghost btn-icon"
                style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)' }}
                onClick={() => setShowPassphrase(!showPassphrase)}
                title={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
              >
                {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <p class="error-msg">{error}</p>}
        </div>
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 12px;">
          <button class="btn" onClick={onClose}>Cancel</button>
          <button class="btn btn-primary" onClick={handleUnlock} disabled={!passphrase || loading}>
            {loading ? <><span class="spinner" /> Unlocking...</> : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}
