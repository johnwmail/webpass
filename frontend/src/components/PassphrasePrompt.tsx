import { useState, useRef, useEffect } from 'preact/hooks';
import { Lock } from 'lucide-preact';

interface Props {
  title?: string;
  message?: string;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}

export function PassphrasePrompt({ title, message, onSubmit, onCancel }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (passphrase) onSubmit(passphrase);
  };

  return (
    <div class="modal-overlay" onClick={onCancel}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>
            <Lock size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            {title || 'Enter PGP Passphrase'}
          </h2>
          <button class="btn btn-ghost btn-icon" onClick={onCancel}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div class="modal-body">
            {message && <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px; line-height: 1.6;">{message}</p>}
            <div class="field">
              <label class="label">Passphrase</label>
              <input
                ref={inputRef}
                class="input"
                type="password"
                value={passphrase}
                onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
                placeholder="Enter your PGP passphrase"
                autocomplete="off"
              />
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" onClick={onCancel}>Cancel</button>
            <button type="submit" class="btn btn-primary" disabled={!passphrase}>Unlock</button>
          </div>
        </form>
      </div>
    </div>
  );
}

let _resolve: ((v: string) => void) | null = null;
let _reject: (() => void) | null = null;
let _setVisible: ((v: boolean) => void) | null = null;

export function usePassphrasePrompt() {
  const [visible, setVisible] = useState(false);
  _setVisible = setVisible;

  const prompt = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
      setVisible(true);
    });
  };

  const handleSubmit = (passphrase: string) => {
    setVisible(false);
    _resolve?.(passphrase);
    _resolve = null;
    _reject = null;
  };

  const handleCancel = () => {
    setVisible(false);
    _reject?.();
    _resolve = null;
    _reject = null;
  };

  const dialog = visible ? (
    <PassphrasePrompt onSubmit={handleSubmit} onCancel={handleCancel} />
  ) : null;

  return { prompt, dialog };
}
