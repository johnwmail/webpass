import { useState, useEffect, useRef } from 'preact/hooks';
import {
  extractLastTOTPURI,
  parseOTPURI,
  generateTOTPCode,
  hasAnyOTPURI,
  findInvalidOTPUris,
  getTOTPErrorHint,
} from '../lib/otp';
import { Copy, Check, AlertTriangle, Eye, EyeOff } from 'lucide-preact';

interface Props {
  content: string;
}

export function OTPDisplay({ content }: Props) {
  const [code, setCode] = useState<string>('');
  const [expiresIn, setExpiresIn] = useState<number>(0);
  const [period, setPeriod] = useState<number>(30);
  const [showOTP, setShowOTP] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const uri = extractLastTOTPURI(content);

    if (!uri) {
      const invalidUris = findInvalidOTPUris(content);
      if (invalidUris.length > 0) {
        setError(getTOTPErrorHint(invalidUris[0]));
      }
      return;
    }

    const entry = parseOTPURI(uri);
    if (!entry) {
      setError('Invalid TOTP URI format');
      return;
    }

    setPeriod(entry.period);
    setError('');
    updateCode(entry.secret, entry.period);

    timerRef.current = setInterval(() => {
      updateCode(entry.secret, entry.period);
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [content]);

  const updateCode = (secret: string, period: number) => {
    const newCode = generateTOTPCode(secret, period);
    setCode(newCode);
    const now = Math.floor(Date.now() / 1000);
    const remaining = period - (now % period);
    setExpiresIn(remaining);
  };

  const copyCode = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 45000);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = code;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (error && !code) {
    return (
      <div class="notice notice-warning" style={{ marginTop: '16px' }}>
        <AlertTriangle size={18} style={{ flexShrink: 0 }} />
        <div>
          <strong>Invalid TOTP URI format</strong><br />
          <span style={{ fontSize: '12px', opacity: 0.9 }}>{error}</span><br />
          <span style={{ fontSize: '11px', opacity: 0.7, marginTop: '4px', display: 'block' }}>
            Edit entry to fix or remove the URI
          </span>
        </div>
      </div>
    );
  }

  if (!code && !error) {
    return null;
  }

  return (
    <div class="entry-field" style={{ marginTop: '20px' }}>
      <div class="entry-field-label">TOTP Code</div>
      <div class="otp-display">
        <div class="otp-code-container">
          <code class="otp-code">{showOTP ? code : '•'.repeat(6)}</code>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              class="otp-copy"
              onClick={(e) => { e.stopPropagation(); copyCode(); }}
              title="Copy to clipboard"
              disabled={!code || !showOTP}
            >
              {copied ? <Check size={16} style={{ color: 'var(--success)' }} /> : <Copy size={16} />}
            </button>
            <button
              class="otp-copy"
              onClick={() => setShowOTP(!showOTP)}
              title={showOTP ? 'Hide' : 'Show'}
              aria-label={showOTP ? 'Hide OTP code' : 'Show OTP code'}
            >
              {showOTP ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div class="otp-progress">
          <div
            class="otp-progress-bar"
            style={{ width: `${(expiresIn / period) * 100}%` }}
          />
        </div>

        {copied && (
          <div class="toast" style={{ bottom: '80px' }}>
            ✓ Copied — auto-clears in 45s
          </div>
        )}
      </div>
    </div>
  );
}
