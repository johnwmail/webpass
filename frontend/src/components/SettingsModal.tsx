import { useState, useRef, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount, deleteAccount as deleteAccountFromDB } from '../lib/storage';
import QRCode from 'qrcode';
import { GitSync } from './GitSync';
import { ImportDialog } from './ImportDialog';
import { VERSION as FRONTEND_VERSION, COMMIT as FRONTEND_COMMIT, BUILD_TIME as FRONTEND_BUILD_TIME } from '../lib/version';

interface Props {
  onClose: () => void;
  onLock: () => void;
  onEntriesChanged?: () => void;
}

export function SettingsModal({ onClose, onLock, onEntriesChanged }: Props) {
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Passphrase prompt for delete operations
  const [showDeletePrompt, setShowDeletePrompt] = useState<'local' | 'full' | null>(null);
  const [deletePassphrase, setDeletePassphrase] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Version state
  const [backendVersion, setBackendVersion] = useState<{ version: string; commit: string; build_time: string } | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);

  // 2FA state
  const [totpSecret, setTotpSecret] = useState('');
  const [totpUrl, setTotpUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpLoading, setTotpLoading] = useState(false);
  const [totpConfirmed, setTotpConfirmed] = useState(false);
  const [show2faSetup, setShow2faSetup] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  // Import state
  const [showImport, setShowImport] = useState(false);

  // Git sync state
  const [showGitSync, setShowGitSync] = useState(false);
  const [gitConfigured, setGitConfigured] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState('');
  const [gitSuccess, setGitSuccess] = useState('');

  const fp = session.fingerprint || '';
  const apiUrl = session.api?.baseUrl || '';

  const formatFp = (f: string) => f.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

  // Fetch backend version
  useEffect(() => {
    if (session.api) {
      session.api.fetchVersion()
        .then(setBackendVersion)
        .catch((err) => {
          console.error('Version fetch error:', err);
          setVersionError(err.message || 'Failed to fetch version');
        });
    }
  }, []);

  // Fetch git sync status
  useEffect(() => {
    const fetchGitStatus = async () => {
      if (session.api) {
        try {
          const status = await session.api.getGitStatus();
          setGitConfigured(!!(status.configured && status.has_encrypted_pat));
        } catch (err) {
          // Ignore errors - git not configured
        }
      }
    };
    fetchGitStatus();
  }, []);

  // QR code rendering
  useEffect(() => {
    if (totpUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, totpUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(() => { });
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

  // Import archive - now opens ImportDialog
  const handleImportClick = () => {
    setShowImport(true);
  };

  const handleImportSuccess = (imported: number) => {
    setSuccess(`Imported ${imported} entries`);
    setTimeout(() => setSuccess(''), 5000);
    // Reload entries in main app
    onEntriesChanged?.();
  };

  // Git sync handlers
  const handleGitPush = async () => {
    setGitLoading(true);
    setGitError('');
    try {
      if (!session.api) throw new Error('Not logged in');
      await session.api.gitPush('');
      setGitSuccess('Push successful!');
      setTimeout(() => setGitSuccess(''), 3000);
      onEntriesChanged?.();
    } catch (e: any) {
      setGitError(e.message || 'Push failed');
    }
    setGitLoading(false);
  };

  const handleGitPull = async () => {
    setGitLoading(true);
    setGitError('');
    try {
      if (!session.api) throw new Error('Not logged in');
      await session.api.gitPull('');
      setGitSuccess('Pull successful!');
      setTimeout(() => setGitSuccess(''), 3000);
      onEntriesChanged?.();
    } catch (e: any) {
      setGitError(e.message || 'Pull failed');
    }
    setGitLoading(false);
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

  // Delete local data only (IndexedDB)
  const handleDeleteLocalData = async () => {
    if (!showDeletePrompt) {
      setShowDeletePrompt('local');
      return;
    }
    setDeleteLoading(true);
    setError('');
    try {
      // Verify passphrase by attempting to get account
      const account = await getAccount(fp);
      if (!account) {
        throw new Error('Account not found');
      }
      // Delete from IndexedDB
      await deleteAccountFromDB(fp);
      setSuccess('Local data cleared');
      setShowDeletePrompt(null);
      setDeletePassphrase('');
      setTimeout(() => setSuccess(''), 3000);
      session.clear();
      onLock();
    } catch (e: any) {
      setError(e.message || 'Delete failed');
    }
    setDeleteLoading(false);
  };

  // Delete full account (server + local)
  const handleDeleteFullAccount = async () => {
    if (!showDeletePrompt) {
      setShowDeletePrompt('full');
      return;
    }
    setDeleteLoading(true);
    setError('');
    try {
      // Verify passphrase by attempting to get account
      const account = await getAccount(fp);
      if (!account) {
        throw new Error('Account not found');
      }
      // Call backend to delete account
      if (session.api) {
        await session.api.deleteAccount();
      }
      // Delete from IndexedDB
      await deleteAccountFromDB(fp);
      setSuccess('Account permanently deleted');
      setShowDeletePrompt(null);
      setDeletePassphrase('');
      setTimeout(() => setSuccess(''), 5000);
      session.clear();
      onLock();
    } catch (e: any) {
      setError(e.message || 'Delete failed');
    }
    setDeleteLoading(false);
  };

  // Logout (clear session without deleting account)
  const handleLogout = () => {
    session.clear();
    onLock();
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

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
                <div class="version-row">
                  <span class="version-meta-label">Version:</span>
                  <span class="version-value">{FRONTEND_VERSION}</span>
                </div>
                <div class="version-row">
                  <span class="version-meta-label">Commit:</span>
                  <span class="version-value">{FRONTEND_COMMIT}</span>
                </div>
                <div class="version-row">
                  <span class="version-meta-label">Built:</span>
                  <span class="version-value">{FRONTEND_BUILD_TIME}</span>
                </div>
              </div>
              {backendVersion ? (
                <div class="version-block">
                  <div class="version-label">Backend</div>
                  <div class="version-row">
                    <span class="version-meta-label">Version:</span>
                    <span class="version-value">{backendVersion.version}</span>
                  </div>
                  <div class="version-row">
                    <span class="version-meta-label">Commit:</span>
                    <span class="version-value">{backendVersion.commit}</span>
                  </div>
                  <div class="version-row">
                    <span class="version-meta-label">Built:</span>
                    <span class="version-value">{backendVersion.build_time}</span>
                  </div>
                  {backendVersion.commit !== FRONTEND_COMMIT && (
                    <div class="version-warning" title="Commit hashes differ">⚠️ Versions differ</div>
                  )}
                </div>
              ) : versionError ? (
                <div class="version-block">
                  <div class="version-label">Backend</div>
                  <div class="version-row">
                    <span class="version-meta-label">Version:</span>
                    <span class="version-value" style="color: var(--text-muted);">Unavailable</span>
                  </div>
                  <div class="version-error" style="margin-top: 8px; color: var(--danger); font-size: 12px;">
                    ⚠️ {versionError}
                  </div>
                </div>
              ) : (
                <div class="version-block">
                  <div class="version-label">Backend</div>
                  <div class="version-row">
                    <span class="version-meta-label">Version:</span>
                    <span class="version-value" style="color: var(--text-muted);">Loading...</span>
                  </div>
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
                onClick={handleImportClick}
                disabled={!session.api}
                title={!session.api ? 'Please log in first' : ''}
              >
                📥 Import .password-store
              </button>
            </div>
          </div>

          {/* Git Sync */}
          <div class="settings-section">
            <h3>🔄 Git Sync</h3>
            <p class="help-text" style="margin-bottom: 12px;">
              {gitConfigured 
                ? 'Your passwords are synced to a private Git repository.'
                : 'Sync your encrypted passwords to a private Git repository.'}
            </p>
            {gitConfigured ? (
              <>
                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                  <button
                    class="btn btn-sm"
                    onClick={handleGitPush}
                    disabled={gitLoading}
                    style="flex: 1;"
                  >
                    {gitLoading ? <><span class="spinner" /> Pushing...</> : '⬆️ Push'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handleGitPull}
                    disabled={gitLoading}
                    style="flex: 1;"
                  >
                    {gitLoading ? <><span class="spinner" /> Pulling...</> : '⬇️ Pull'}
                  </button>
                </div>
                {gitError && <p class="error-msg" style="margin-bottom: 8px;">{gitError}</p>}
                {gitSuccess && <p class="success-msg" style="margin-bottom: 8px;">{gitSuccess}</p>}
              </>
            ) : null}
            <button class="btn btn-sm" onClick={() => setShowGitSync(true)}>
              {showGitSync ? 'Configuring...' : gitConfigured ? '⚙️ Manage Git Sync' : '⚙️ Configure Git Sync'}
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

          {/* Session */}
          <div class="settings-section">
            <h3>Session</h3>
            <p class="help-text" style="margin-bottom: 12px;">
              Manage your current session.
            </p>
            <button
              class="btn btn-sm"
              onClick={handleLogout}
            >
              🚪 Logout
            </button>
          </div>

          {/* Danger Zone */}
          <div class="settings-section">
            <h3 style="color: var(--danger);">Danger Zone</h3>
            
            <div style="margin-bottom: 16px;">
              <p class="help-text" style="margin-bottom: 8px; font-size: 12px;">
                🗑️ <strong>Clear Local Data</strong> — Remove stored data from this browser only. Server account remains intact.
              </p>
              <button
                class="btn btn-sm"
                onClick={handleDeleteLocalData}
                disabled={deleteLoading}
              >
                {showDeletePrompt === 'local' ? '⚠️ Confirm with Passphrase' : 'Clear Local Data'}
              </button>
            </div>

            <div style="border-top: 1px solid var(--border); padding-top: 16px;">
              <p class="help-text" style="margin-bottom: 8px; font-size: 12px; color: var(--danger);">
                ☠️ <strong>Permanently Delete Account</strong> — Delete everything: local data, server account, database records, and git repository files. This action cannot be undone.
              </p>
              <button
                class={`btn btn-sm btn-danger`}
                onClick={handleDeleteFullAccount}
                disabled={deleteLoading}
              >
                {showDeletePrompt === 'full' ? '⚠️ Confirm with Passphrase' : '☠️ Permanently Delete Account'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Passphrase Prompt Modal */}
      {showDeletePrompt && (
        <div class="modal-overlay" onClick={() => { setShowDeletePrompt(null); setDeletePassphrase(''); }}>
          <div class="modal" style="max-width: 400px;" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h3>{showDeletePrompt === 'local' ? '🗑️ Clear Local Data' : '☠️ Delete Account'}</h3>
              <button class="btn btn-ghost btn-icon" onClick={() => { setShowDeletePrompt(null); setDeletePassphrase(''); }}>✕</button>
            </div>
            <div class="modal-body">
              <p style="margin-bottom: 16px; font-size: 13px; color: var(--text-muted);">
                {showDeletePrompt === 'local' 
                  ? 'Enter your PGP passphrase to confirm clearing local data.'
                  : 'Enter your PGP passphrase to permanently delete your account. This action cannot be undone.'}
              </p>
              <div class="field">
                <label class="label">PGP Passphrase</label>
                <input
                  class="input"
                  type="password"
                  value={deletePassphrase}
                  onInput={(e) => setDeletePassphrase((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && deletePassphrase) {
                      showDeletePrompt === 'local' ? handleDeleteLocalData() : handleDeleteFullAccount();
                    }
                  }}
                  placeholder="Enter your PGP passphrase"
                  disabled={deleteLoading}
                  autofocus
                />
              </div>
              {error && <p class="error-msg">{error}</p>}
              <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px;">
                <button
                  class="btn btn-ghost"
                  onClick={() => { setShowDeletePrompt(null); setDeletePassphrase(''); }}
                  disabled={deleteLoading}
                >
                  Cancel
                </button>
                <button
                  class="btn btn-danger"
                  onClick={() => showDeletePrompt === 'local' ? handleDeleteLocalData() : handleDeleteFullAccount()}
                  disabled={!deletePassphrase || deleteLoading}
                >
                  {deleteLoading ? <><span class="spinner" /> Deleting...</> : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Git Sync Modal */}
      {showGitSync && <GitSync onClose={() => setShowGitSync(false)} onSuccess={() => {
        // Reload entries after successful sync
        onEntriesChanged?.();
        setShowGitSync(false);
      }} />}

      {/* Import Dialog */}
      {showImport && (
        <ImportDialog
          onClose={() => setShowImport(false)}
          onSuccess={handleImportSuccess}
        />
      )}
    </div>
  );
}
