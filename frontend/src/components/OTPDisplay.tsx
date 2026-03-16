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

      {copied && (
        <div class="otp-toast">
          ✓ Copied — auto-clears in 45s
        </div>
      )}

      <style>{`
        .otp-display {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 8px;
          padding: 10px 12px;
          margin: 10px 0;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }

        .otp-code-container {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .otp-code {
          flex: 1;
          font-family: 'SF Mono', SFMono-Regular, ui-monospace, 'DejaVu Sans Mono', Menlo, Consolas, monospace;
          font-size: 20px;
          font-weight: 600;
          text-align: center;
          padding: 8px 12px;
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 6px;
          letter-spacing: 3px;
          color: #3fb950;
          box-shadow: inset 0 1px 2px rgba(0,0,0,0.2);
        }

        .otp-copy {
          background: #21262d;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 6px 10px;
          cursor: pointer;
          font-size: 16px;
          transition: all 0.2s;
          flex-shrink: 0;
          color: #c9d1d9;
        }

        .otp-copy:hover:not(:disabled) {
          background: #30363d;
          border-color: #8b949e;
          transform: translateY(-1px);
        }

        .otp-copy:active:not(:disabled) {
          transform: translateY(0);
        }

        .otp-copy:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .otp-progress {
          height: 3px;
          background: #21262d;
          border-radius: 2px;
          overflow: hidden;
          margin-top: 8px;
        }

        .otp-progress-bar {
          height: 100%;
          background: linear-gradient(90deg, #3fb950 0%, #56d364 100%);
          transition: width 1s linear;
        }

        .otp-toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: #238636;
          color: #ffffff;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: 500;
          z-index: 1000;
          animation: fadeIn 0.2s ease;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}
