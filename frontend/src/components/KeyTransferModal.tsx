import { useState, useRef, useEffect } from 'preact/hooks';
import QRCode from 'qrcode';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { encryptKeyTransfer } from '../lib/keyTransfer';

interface Props {
  onClose: () => void;
}

interface TransferInfo {
  token: string;
  expiresAt: number;
  link: string;
}

type TransferStatus = 'waiting' | 'redeemed' | 'expired';

export function KeyTransferModal({ onClose }: Props) {
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [transfer, setTransfer] = useState<TransferInfo | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [status, setStatus] = useState<TransferStatus>('waiting');
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!transfer) return;
    const update = () => {
      const left = Math.max(0, Math.round((transfer.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setStatus((s) => (s === 'waiting' ? 'expired' : s));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [transfer]);

  useEffect(() => {
    if (transfer && qrRef.current) {
      QRCode.toCanvas(qrRef.current, transfer.link, { width: 260, margin: 1 }).catch(() => {});
    }
  }, [transfer]);

  useEffect(() => {
    if (!transfer || status !== 'waiting') return;
    const timer = setInterval(async () => {
      try {
        const st = await session.api?.keyTransferStatus();
        if (!st) return;
        if (st.redeemed) setStatus('redeemed');
        else if (!st.active) setStatus('expired');
      } catch {
        // Ignore transient status errors; the countdown still expires locally.
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [transfer, status]);

  const createTransfer = async () => {
    setError('');
    if (!code.trim()) {
      setError('Enter a pairing code');
      return;
    }
    if (code !== confirm) {
      setError('Pairing codes do not match');
      return;
    }
    const fp = session.fingerprint;
    if (!fp || !session.api) {
      setError('Not logged in');
      return;
    }
    setLoading(true);
    try {
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');
      const envelope = await encryptKeyTransfer(account.privateKey, code, fp);
      const res = await session.api.createKeyTransfer(envelope);
      const link = `${window.location.origin}/#/transfer?api=${encodeURIComponent(session.api.baseUrl)}&fp=${encodeURIComponent(fp)}&t=${encodeURIComponent(res.token)}`;
      const parsed = Date.parse(res.expires_at);
      setTransfer({
        token: res.token,
        expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + 15 * 60 * 1000,
        link,
      });
      // The pairing code is never displayed or sent to the server.
      setCode('');
      setConfirm('');
    } catch (e: any) {
      setError(e.message || 'Failed to create transfer');
    }
    setLoading(false);
  };

  const revoke = async () => {
    try {
      await session.api?.revokeKeyTransfer();
    } catch {
      // Best effort.
    }
    onClose();
  };

  const copyLink = async () => {
    if (!transfer) return;
    try {
      await navigator.clipboard.writeText(transfer.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied; the link is still selectable.
    }
  };

  const reset = () => {
    setTransfer(null);
    setStatus('waiting');
    setRemaining(0);
    setError('');
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 560px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Transfer to New Device</h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>

        <div class="modal-body">
          {!transfer ? (
            <>
              <p class="help-text" style="margin-bottom: 16px;">
                Choose a temporary pairing code. The encrypted PGP key is uploaded for
                15 minutes; the server never sees this code or your PGP passphrase.
                You will type the same code on the new device. It is not shown again,
                so remember it until the new device finishes restoring.
              </p>
              <div class="field">
                <label class="label">Pairing code</label>
                <input
                  class="input"
                  type="password"
                  value={code}
                  onInput={(e) => { setCode((e.target as HTMLInputElement).value); setError(''); }}
                  placeholder="Enter a temporary pairing code"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  disabled={loading}
                />
              </div>
              <div class="field">
                <label class="label">Confirm pairing code</label>
                <input
                  class="input"
                  type="password"
                  value={confirm}
                  onInput={(e) => { setConfirm((e.target as HTMLInputElement).value); setError(''); }}
                  placeholder="Confirm the pairing code"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="off"
                  spellcheck={false}
                  data-lpignore="true"
                  data-bwignore="true"
                  data-1p-ignore="true"
                  disabled={loading}
                />
              </div>
              {error && <p class="error-msg">{error}</p>}
              <button
                class="btn btn-primary"
                style="width: 100%; margin-top: 8px;"
                onClick={createTransfer}
                disabled={loading || !code || !confirm}
              >
                {loading ? <><span class="spinner" /> Creating...</> : 'Create 15-minute link'}
              </button>
            </>
          ) : status === 'redeemed' ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">✓ Key transferred</p>
              <p class="help-text">The new device has the encrypted key. You can close this window.</p>
              <button class="btn btn-primary" style="margin-top: 16px;" onClick={onClose}>Done</button>
            </div>
          ) : status === 'expired' ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">Link expired</p>
              <p class="help-text">The 15-minute window has passed. Create a new link to try again.</p>
              <button class="btn btn-primary" style="margin-top: 16px;" onClick={reset}>Create another link</button>
            </div>
          ) : (
            <>
              <p class="help-text" style="margin-bottom: 12px;">
                Scan this QR code, or open the link on the new device. Then log in and
                enter the pairing code you chose. The code is not shown here.
              </p>
              <div style="display: flex; justify-content: center; margin-bottom: 12px;">
                <canvas ref={qrRef} aria-label="Key transfer QR code" />
              </div>
              <label class="label">Link</label>
              <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                <input
                  class="input input-mono"
                  type="text"
                  readonly
                  value={transfer.link}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  style="font-size: 11px;"
                />
                <button class="btn btn-sm" onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p style="text-align: center; font-size: 13px; margin-bottom: 12px;">
                Expires in <strong>{remaining}s</strong>
              </p>
              <div style="display: flex; justify-content: flex-end;">
                <button class="btn btn-ghost btn-sm" onClick={revoke}>Revoke link</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
