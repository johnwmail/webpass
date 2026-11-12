import { useState, useRef, useEffect } from 'preact/hooks';
import QRCode from 'qrcode';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { encryptKeyTransfer, computePairingProof } from '../lib/keyTransfer';

interface Props {
  onClose: () => void;
}

interface TransferInfo {
  token: string;
  expiresAt: number;
  link: string;
}

interface TransferStatus {
  active: boolean;
  requested: boolean;
  requested_at: string | null;
  requested_ip: string;
  requested_user_agent: string;
  requested_proof: string;
  challenge: string;
  approved: boolean;
  denied: boolean;
  redeemed: boolean;
  expires_at: string | null;
}

type ProofState = 'idle' | 'checking' | 'verified' | 'invalid';

export function KeyTransferModal({ onClose }: Props) {
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [transfer, setTransfer] = useState<TransferInfo | null>(null);
  const [statusInfo, setStatusInfo] = useState<TransferStatus | null>(null);
  const [proofState, setProofState] = useState<ProofState>('idle');
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);
  const pairingCodeRef = useRef('');
  const envelopeSaltRef = useRef('');
  const challengeRef = useRef('');
  const lastProofRef = useRef('');

  useEffect(() => {
    if (!transfer) return;
    const update = () => {
      const left = Math.max(0, Math.round((transfer.expiresAt - Date.now()) / 1000));
      setRemaining(left);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [transfer]);

  useEffect(() => {
    if (!transfer) return;
    const timer = setInterval(async () => {
      try {
        const st = await session.api?.keyTransferStatus();
        if (st) setStatusInfo(st);
      } catch {
        // Keep the countdown; transient status errors are non-fatal.
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [transfer]);

  useEffect(() => {
    const st = statusInfo;
    if (!st || !st.requested || st.approved || st.denied) return;
    if (!st.requested_proof || lastProofRef.current === st.requested_proof) return;
    lastProofRef.current = st.requested_proof;
    setProofState('checking');
    (async () => {
      try {
        const fp = session.fingerprint;
        if (!fp) throw new Error('Not logged in');
        const expected = await computePairingProof(
          pairingCodeRef.current,
          envelopeSaltRef.current,
          st.challenge || challengeRef.current,
          fp
        );
        setProofState(expected === st.requested_proof ? 'verified' : 'invalid');
      } catch {
        setProofState('invalid');
      }
    })();
  }, [statusInfo]);

  useEffect(() => {
    if (transfer && !statusInfo?.requested && qrRef.current) {
      QRCode.toCanvas(qrRef.current, transfer.link, { width: 260, margin: 1 }).catch(() => {});
    }
  }, [transfer, statusInfo?.requested]);

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
      // Keep the pairing code in memory only; it is used to verify the
      // target device's proof. It is never displayed or sent to the server.
      pairingCodeRef.current = code;
      envelopeSaltRef.current = envelope.salt;
      challengeRef.current = res.challenge;
      lastProofRef.current = '';
      setTransfer({
        token: res.token,
        expiresAt: Number.isFinite(parsed) ? parsed : Date.now() + 15 * 60 * 1000,
        link,
      });
      setStatusInfo(null);
      setProofState('idle');
      setCode('');
      setConfirm('');
    } catch (e: any) {
      setError(e.message || 'Failed to create transfer');
    }
    setLoading(false);
  };

  const approve = async () => {
    if (proofState !== 'verified') return;
    setApprovalLoading(true);
    setError('');
    try {
      await session.api?.approveKeyTransfer();
    } catch (e: any) {
      setError(e.message || 'Approve failed');
    }
    setApprovalLoading(false);
  };

  const deny = async () => {
    setApprovalLoading(true);
    setError('');
    try {
      await session.api?.denyKeyTransfer();
      setStatusInfo((s) => (s ? { ...s, denied: true, active: false } : s));
    } catch (e: any) {
      setError(e.message || 'Deny failed');
    }
    setApprovalLoading(false);
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
    setStatusInfo(null);
    setProofState('idle');
    setRemaining(0);
    setError('');
    pairingCodeRef.current = '';
    envelopeSaltRef.current = '';
    challengeRef.current = '';
    lastProofRef.current = '';
  };

  const requested = !!statusInfo?.requested && !statusInfo.approved && !statusInfo.denied;
  const expired = !!transfer && remaining === 0 && !statusInfo?.redeemed && !statusInfo?.approved;

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
                The new device must enter the same code before you can approve it.
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
          ) : statusInfo?.redeemed ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">✓ Key transferred</p>
              <p class="help-text">The new device has the encrypted key. You can close this window.</p>
              <button class="btn btn-primary" style="margin-top: 16px;" onClick={onClose}>Done</button>
            </div>
          ) : statusInfo?.denied ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">Transfer denied</p>
              <p class="help-text">The link is no longer valid.</p>
              <button class="btn btn-primary" style="margin-top: 16px;" onClick={reset}>Create another link</button>
            </div>
          ) : requested ? (
            <>
              <p style="font-size: 15px; font-weight: 600; margin-bottom: 12px;">
                A new device is requesting your key
              </p>
              <div class="settings-section" style="margin: 0 0 12px; padding: 12px;">
                <div class="version-row"><span class="version-meta-label">IP:</span><span class="version-value">{statusInfo?.requested_ip || 'unknown'}</span></div>
                <div class="version-row"><span class="version-meta-label">Requested:</span><span class="version-value">{statusInfo?.requested_at ? new Date(statusInfo.requested_at).toLocaleString() : ''}</span></div>
                <div class="version-row" style="align-items: flex-start;">
                  <span class="version-meta-label">Device:</span>
                  <span class="version-value" style="word-break: break-all; font-size: 11px;">{statusInfo?.requested_user_agent || 'unknown'}</span>
                </div>
              </div>
              <p class="help-text" style="margin-bottom: 12px;">
                Only approve if you started this transfer on the new device.
              </p>
              <p style="font-size: 13px; margin-bottom: 12px;">
                {proofState === 'checking' && <><span class="spinner" /> Verifying pairing code...</>}
                {proofState === 'verified' && <span style="color: var(--success);">✓ Pairing code verified</span>}
                {proofState === 'invalid' && <span style="color: var(--danger);">✗ Pairing code does not match</span>}
              </p>
              {error && <p class="error-msg">{error}</p>}
              <div style="display: flex; gap: 10px;">
                <button
                  class="btn btn-primary"
                  style="flex: 1;"
                  onClick={approve}
                  disabled={proofState !== 'verified' || approvalLoading}
                >
                  {approvalLoading ? <><span class="spinner" /> Approving...</> : 'Approve'}
                </button>
                <button class="btn" onClick={deny} disabled={approvalLoading}>Deny</button>
              </div>
            </>
          ) : statusInfo?.approved ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">Approved ✓</p>
              <p class="help-text">Waiting for the new device to finish restoring...</p>
              <p style="margin-top: 12px; font-size: 13px;">Expires in <strong>{remaining}s</strong></p>
            </div>
          ) : expired ? (
            <div style="text-align: center; padding: 12px 0;">
              <p style="font-size: 16px; margin-bottom: 8px;">Link expired</p>
              <p class="help-text">The 15-minute window has passed. Create a new link to try again.</p>
              <button class="btn btn-primary" style="margin-top: 16px;" onClick={reset}>Create another link</button>
            </div>
          ) : (
            <>
              <p class="help-text" style="margin-bottom: 12px;">
                Scan this QR code, or open the link on the new device. Then log in and
                enter the pairing code you chose. It is not shown here. You will be
                asked to approve the new device after it verifies the code.
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
