import { useState, useEffect, useCallback } from 'preact/hooks';
import { Copy, Check, Sparkles, RotateCcw } from 'lucide-preact';

interface Props {
  onUse?: (password: string) => void;
  onClose: () => void;
}

const CHARS = {
  uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lowercase: 'abcdefghijklmnopqrstuvwxyz',
  numbers: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?',
};

function generatePassword(
  length: number,
  opts: { uppercase: boolean; lowercase: boolean; numbers: boolean; symbols: boolean }
): string {
  let charset = '';
  if (opts.uppercase) charset += CHARS.uppercase;
  if (opts.lowercase) charset += CHARS.lowercase;
  if (opts.numbers) charset += CHARS.numbers;
  if (opts.symbols) charset += CHARS.symbols;
  if (!charset) charset = CHARS.lowercase + CHARS.numbers;

  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (n) => charset[n % charset.length]).join('');
}

export function GeneratorModal({ onUse, onClose }: Props) {
  const [length, setLength] = useState(20);
  const [uppercase, setUppercase] = useState(true);
  const [lowercase, setLowercase] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const regenerate = useCallback(() => {
    setPassword(generatePassword(length, { uppercase, lowercase, numbers, symbols }));
    setCopied(false);
  }, [length, uppercase, lowercase, numbers, symbols]);

  useEffect(() => {
    regenerate();
  }, [regenerate]);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 45000);
    } catch {
      // fallback
    }
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>
            <Sparkles size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            Password Generator
          </h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="generator-display">{password}</div>
          <div class="generator-actions">
            <button class="btn btn-sm" onClick={copyToClipboard}>
              {copied ? <><Check size={14} style={{ marginRight: '6px', color: 'var(--success)' }} /> Copied</> : <><Copy size={14} style={{ marginRight: '6px' }} /> Copy</>}
            </button>
            <button class="btn btn-sm" onClick={regenerate}>
              <RotateCcw size={14} style={{ marginRight: '6px' }} /> Regenerate
            </button>
          </div>

          <div class="slider-group">
            <label>Length</label>
            <input
              type="range"
              min="8"
              max="128"
              value={length}
              onInput={(e) => setLength(Number((e.target as HTMLInputElement).value))}
            />
            <span class="value">{length}</span>
          </div>

          <div class="checkbox-group">
            <label class="checkbox-label">
              <input type="checkbox" checked={uppercase} onChange={() => setUppercase(!uppercase)} />
              Uppercase (A-Z)
            </label>
            <label class="checkbox-label">
              <input type="checkbox" checked={lowercase} onChange={() => setLowercase(!lowercase)} />
              Lowercase (a-z)
            </label>
            <label class="checkbox-label">
              <input type="checkbox" checked={numbers} onChange={() => setNumbers(!numbers)} />
              Numbers (0-9)
            </label>
            <label class="checkbox-label">
              <input type="checkbox" checked={symbols} onChange={() => setSymbols(!symbols)} />
              Symbols (!@#$...)
            </label>
          </div>

          {onUse && (
            <button
              class="btn btn-primary btn-block"
              onClick={() => onUse(password)}
            >
              Use This Password
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
