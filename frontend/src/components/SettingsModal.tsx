import { useState, useRef, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount, deleteAccount as deleteAccountFromDB } from '../lib/storage';
import QRCode from 'qrcode';
import { GitSync } from './GitSync';
import { VERSION as FRONTEND_VERSION, COMMIT as FRONTEND_COMMIT, BUILD_TIME as FRONTEND_BUILD_TIME } from '../lib/version';

interface Props {
  onClose: () => void;
  onLock: () => void;
}

export function SettingsModal({ onClose, onLock }: Props) {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Version state
  const [backendVersion, setBackendVersion] = useState<{ version: string; commit: string; build_time: string } | null>(null);

  // 2FA state
  const [totpSecret, setTotpSecret] = useState('');
  const [totpUrl, setTotpUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpConfirmed, setTotpConfirmed] = useState(false);
  const [show2faSetup, setShow2faSetup] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  // Import state
  const [importing, setImporting] = useState(false);

  // Git sync state
  const [showGitSync, setShowGitSync] = useState(false);

  const fp = session.fingerprint || '';
  const apiUrl = session.api?.baseUrl || '';

  const formatFp = (f: string) => f.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

  // Fetch backend version
  useEffect(() => {
    if (session.api) {
      session.api.fetchVersion().then(setBackendVersion).catch(() => {});
    }
  }, []);

  // QR code rendering
  useEffect(() => {
    if (totpUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, totpUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(() => {});
    }
  }, [totpUrl]);

  // Export public key
  const exportPublicKey = async () => {
    const account = await getAccount(fp);
    if (!account) return;
    const blob = new Blob([account.publicKey], { type: 'text/plain' });
    downloadBlob(blob, `webpass-public-${fp.slice(0, 8)}.asc`);
  };

  // Export private key
  const exportPrivateKey = async () => {
    const account = await getAccount(fp);
    if (!account) return;
    const blob = new Blob([account.privateKey], { type: 'text/plain' });
    downloadBlob(blob, `webpass-private-${fp.slice(0, 8)}.asc`);
  };

  // Export all entries
  const exportAll = async () => {
    setError('');
    try {
      if (!session.api) throw new Error('Not logged in');
      const blob = await session.api.exportAll();
      downloadBlob(blob, 'password-store.tar.gz');
      setSuccess('Export complete');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) {
      setError(e.message || 'Export failed');
    }
  };

  // Import archive
  const handleImport = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !session.api) return;
    setImporting(true);
    setError('');
    try {
      const result = await session.api.importArchive(file);
      setSuccess(`Imported ${result.imported} entries`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      setError(err.message || 'Import failed');
    }
    setImporting(false);
    input.value = '';
  };

  // Setup 2FA
  const initTOTP = async () => {
    if (!session.api) return;
    setTotpLoading(true);
    setError('');
    try {
      const result = await session.api.setupTOTP();
      setTotpSecret(result.secret);
      setTotpUrl(result.url);
      setShow2faSetup(true);
    } catch (e: any) {
      setError(e.message || 'TOTP setup failed');
    }
    setTotpLoading(false);
  };

  const confirmTOTP = async () => {
    if (!session.api || !totpSecret || !totpCode) return;
    setTotpLoading(true);
    setError('');
    try {
      await session.api.confirmTOTP(totpSecret, totpCode);
      setTotpConfirmed(true);
      setSuccess('2FA enabled successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (e: any) {
      setError(e.message || 'Invalid code');
    }
    setTotpLoading(false);
  };

  // Delete account
  const handleDeleteAccount = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteAccountFromDB(fp);
      session.clear();
      onLock();
    } catch (e: any) {
      setError(e.message || 'Delete failed');
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFileRef = useRef<HTMLInputElement>(null);

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 520px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>⚙️ Settings</h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div class="modal-body">
          {error && <p class="error-msg" style="margin-bottom: 12px;">{error}</p>}
          {success && <p class="success-msg" style="margin-bottom: 12px;">{success}</p>}

          {/* Account info */}
          <div class="settings-section">
            <h3>Account</h3>
            <div class="settings-row">
              <span class="label-text">Fingerprint</span>
              <span class="value-text" title={fp}>{formatFp(fp)}</span>
            </div>
            <div class="settings-row">
              <span class="label-text">Key Type</span>
              <span class="value-text">ECC Curve25519</span>
            </div>
            <div class="settings-row">
              <span class="label-text">API Server</span>
              <span class="value-text" title={apiUrl}>{apiUrl}</span>
            </div>
          </div>

          {/* Version info */}
          <div class="settings-section">
            <h3>Version</h3>
            <div class="version-details">
              <div class="version-block">
                <div class="version-label">Frontend</div>
                <div class="version-value">{FRONTEND_VERSION}</div>
                <div class="version-meta">Commit: {FRONTEND_COMMIT}</div>
                <div class="version-meta">Built: {FRONTEND_BUILD_TIME}</div>
              </div>
              {backendVersion ? (
                <div class="version-block">
                  <div class="version-label">Backend</div>
                  <div class="version-value">{backendVersion.version}</div>
                  <div class="version-meta">Commit: {backendVersion.commit}</div>
                  <div class="version-meta">Built: {backendVersion.build_time}</div>
                  {backendVersion.version !== FRONTEND_VERSION && (
                    <div class="version-warning">⚠️ Versions differ</div>
                  )}
                </div>
              ) : (
                <div class="version-block">
                  <div class="version-label">Backend</div>
                  <div class="version-value" style="color: var(--text-muted);">Loading...</div>
                </div>
              )}
            </div>
          </div>

          {/* PGP Key Management */}
          <div class="settings-section">
            <h3>PGP Key Management</h3>
            <div class="settings-buttons">
              <button class="btn btn-sm" onClick={exportPublicKey}>
                📤 Export Public Key
              </button>
              <button class="btn btn-sm" onClick={exportPrivateKey}>
                📤 Export Private Key (encrypted)
              </button>
            </div>
          </div>

          {/* Data */}
          <div class="settings-section">
            <h3>Data</h3>
            <div class="settings-buttons">
              <button class="btn btn-sm" onClick={exportAll}>
                📦 Export All (.tar.gz)
              </button>
              <button
                class="btn btn-sm"
                onClick={() => importFileRef.current?.click()}
                disabled={importing}
              >
                {importing ? <><span class="spinner" /> Importing...</> : '📥 Import .password-store'}
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                style="display: none;"
                onChange={handleImport}
              />
            </div>
          </div>

          {/* Git Sync */}
          <div class="settings-section">
            <h3>🔄 Git Sync</h3>
            <p class="help-text" style="margin-bottom: 12px;">
              Sync your encrypted passwords to a private Git repository.
            </p>
            <button class="btn btn-sm" onClick={() => setShowGitSync(true)}>
              {showGitSync ? 'Configuring...' : '⚙️ Configure Git Sync'}
            </button>
          </div>

          {/* 2FA */}
          <div class="settings-section">
            <h3>Two-Factor Authentication</h3>
            {show2faSetup ? (
              totpConfirmed ? (
                <div class="notice notice-success">
                  <span>✓</span>
                  <span>2FA is enabled.</span>
                </div>
              ) : (
                <>
                  {totpUrl && (
                    <>
                      <div class="qr-container">
                        <canvas ref={qrRef} />
                      </div>
                      <div class="totp-secret">{totpSecret}</div>
                      <p style="color: var(--text-muted); font-size: 12px; text-align: center; margin-bottom: 12px;">
                        Scan with your authenticator app.
                      </p>
                      <div class="input-group">
                        <input
                          class="input input-mono"
                          type="text"
                          value={totpCode}
                          onInput={(e) => setTotpCode((e.target as HTMLInputElement).value)}
                          placeholder="6-digit code"
                          maxLength={6}
                          inputMode="numeric"
                        />
                        <button
                          class="btn btn-primary btn-sm"
                          onClick={confirmTOTP}
                          disabled={totpCode.length < 6 || totpLoading}
                        >
                          {totpLoading ? <span class="spinner" /> : 'Verify'}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )
            ) : (
              <button
                class="btn btn-sm"
                onClick={initTOTP}
                disabled={totpLoading}
              >
                {totpLoading ? <><span class="spinner" /> Setting up...</> : '🔐 Enable 2FA'}
              </button>
            )}
          </div>

          {/* Danger Zone */}
          <div class="settings-section">
            <h3 style="color: var(--danger);">Danger Zone</h3>
            <button
              class={`btn btn-sm ${confirmDelete ? 'btn-danger' : ''}`}
              onClick={handleDeleteAccount}
            >
              {confirmDelete ? '⚠️ Confirm — Delete Account Permanently' : '🗑️ Delete Account'}
            </button>
            {confirmDelete && (
              <button
                class="btn btn-sm btn-ghost"
                style="margin-top: 4px;"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Git Sync Modal */}
      {showGitSync && <GitSync onClose={() => setShowGitSync(false)} onSuccess={() => {
        // Refresh entries after successful sync
        window.location.reload();
      }} />}
    </div>
  );
}
