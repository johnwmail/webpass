import { useState, useEffect, useRef } from 'preact/hooks';
import {
  extractLastTOTPURI,
  parseOTPURI,
  generateTOTPCode,
  hasAnyOTPURI,
  findInvalidOTPUris,
  getTOTPErrorHint,
} from '../lib/otp';

interface Props {
  content: string;
}

export function OTPDisplay({ content }: Props) {
  const [code, setCode] = useState<string>('');
  const [expiresIn, setExpiresIn] = useState<number>(0);
  const [period, setPeriod] = useState<number>(30);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Extract and validate TOTP URI on mount
  useEffect(() => {
    const uri = extractLastTOTPURI(content);
    
    if (!uri) {
      // Check if there are invalid URIs to show warning
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

    // Generate initial code
    updateCode(entry.secret, entry.period);

    // Set up timer to refresh code
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
    
    // Calculate seconds until next period
    const now = Math.floor(Date.now() / 1000);
    const remaining = period - (now % period);
    setExpiresIn(remaining);
  };

  const copyCode = async () => {
    if (!code) return;
    
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      
      // Auto-clear after 45 seconds
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 45000);
      
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
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

  // Show warning for invalid URIs
  if (error && !code) {
    return (
      <div class="otp-display otp-warning">
        <div class="otp-warning-icon">⚠️</div>
        <div class="otp-warning-content">
          <div class="otp-warning-title">Invalid TOTP URI format</div>
          <div class="otp-warning-hint">{error}</div>
          <div class="otp-warning-footer">
            Edit entry to fix or remove the URI
          </div>
        </div>
        <style>{`
          .otp-display.otp-warning {
            background: #fff8c5;
            border: 1px solid #d9b300;
            border-radius: 6px;
            padding: 12px;
            margin: 12px 0;
            display: flex;
            gap: 12px;
            align-items: flex-start;
          }

          .otp-warning-icon {
            font-size: 20px;
            flex-shrink: 0;
          }

          .otp-warning-content {
            flex: 1;
          }

          .otp-warning-title {
            font-weight: 600;
            font-size: 13px;
            color: #7d6b00;
            margin-bottom: 4px;
          }

          .otp-warning-hint {
            font-size: 12px;
            color: #8b7d00;
            margin-bottom: 4px;
          }

          .otp-warning-footer {
            font-size: 11px;
            color: #9c8f00;
          }
        `}</style>
      </div>
    );
  }

  // Don't show anything if no TOTP URI
  if (!code && !error) {
    return null;
  }

  return (
    <div class="otp-display">
      <div class="otp-header">
        <span class="otp-title">🔐 TOTP Code</span>
      </div>

      <div class="otp-code-container">
        <code class="otp-code">{code}</code>
        <button
          class="otp-copy"
          onClick={copyCode}
          title="Copy to clipboard"
          disabled={!code}
        >
          {copied ? '✓' : '📋'}
        </button>
      </div>

      <div class="otp-progress">
        <div
          class="otp-progress-bar"
          style={{ width: `${(expiresIn / period) * 100}%` }}
        />
      </div>

      <div class="otp-footer">
        <span class="otp-expires">
          Refreshes in {expiresIn}s
        </span>
        {period !== 30 && (
          <span class="otp-period-hint">
            ({period}s period)
          </span>
        )}
      </div>

      {copied && (
        <div class="otp-toast">
          ✓ Copied — auto-clears in 45s
        </div>
      )}

      <style>{`
        .otp-display {
          background: #f6f8fa;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          padding: 12px;
          margin: 12px 0;
        }

        .otp-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }

        .otp-title {
          font-weight: 600;
          font-size: 13px;
          color: #24292f;
        }

        .otp-code-container {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 12px 0;
        }

        .otp-code {
          flex: 1;
          font-family: 'SF Mono', SFMono-Regular, ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace;
          font-size: 28px;
          font-weight: 600;
          text-align: center;
          padding: 12px;
          background: #fff;
          border: 2px solid #d0d7de;
          border-radius: 6px;
          letter-spacing: 4px;
          color: #24292f;
        }

        .otp-copy {
          background: #f6f8fa;
          border: 1px solid #d0d7de;
          border-radius: 6px;
          padding: 8px 12px;
          cursor: pointer;
          font-size: 18px;
        }

        .otp-copy:hover:not(:disabled) {
          background: #f3f4f6;
        }

        .otp-copy:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .otp-progress {
          height: 4px;
          background: #d0d7de;
          border-radius: 2px;
          overflow: hidden;
          margin: 12px 0;
        }

        .otp-progress-bar {
          height: 100%;
          background: #2da44e;
          transition: width 1s linear;
        }

        .otp-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: #8b949e;
        }

        .otp-period-hint {
          font-size: 11px;
        }

        .otp-toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: #2da44e;
          color: white;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 500;
          z-index: 1000;
          animation: fadeIn 0.2s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}
