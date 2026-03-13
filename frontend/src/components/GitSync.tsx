import { useState, useEffect } from 'preact/hooks';
import * as openpgp from 'openpgp';
import { session } from '../lib/session';
import { getPublicKey, getDecryptedPrivateKey } from '../lib/storage';
import { encryptPAT, decryptPAT, decryptPrivateKey } from '../lib/crypto';

interface GitStatus {
  configured: boolean;
  repo_url?: string;
  has_encrypted_pat?: boolean;
  success_count: number;
  failed_count: number;
}

interface GitLogEntry {
  id: number;
  operation: string;
  status: string;
  message: string;
  entries_changed: number;
  created_at: string;
}

interface Conflict {
  path: string;
  local_modified: boolean;
  remote_modified: boolean;
}

interface PullResult {
  status: string;
  operation: string;
  entries_changed?: number;
  message: string;
  conflicts?: Conflict[];
}

interface Props {
  onClose: () => void;
  onSuccess?: () => void;
}

export function GitSync({ onClose, onSuccess }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [logs, setLogs] = useState<GitLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [showConflictDialog, setShowConflictDialog] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

  // Config form
  const [repoUrl, setRepoUrl] = useState('');
  const [pat, setPat] = useState('');
  const [encryptedPat, setEncryptedPat] = useState('');
  const [configuring, setConfiguring] = useState(false);

  // Password prompt for encryption/decryption
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordForPat, setPasswordForPat] = useState('');
  const [pendingAction, setPendingAction] = useState<'configure' | 'push' | 'pull' | null>(null);

  const fp = session.fingerprint || '';

  const formatTime = (iso?: string) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleString();
  };

  const loadStatus = async () => {
    if (!session.api) return;
    try {
      const s = await session.api.getGitStatus();
      setStatus(s);
      if (s.configured && s.repo_url) {
        setRepoUrl(s.repo_url);
      }
      
      // Fetch encrypted_pat from config endpoint
      const config = await session.api.getGitConfig();
      if (config.configured && config.encrypted_pat) {
        setEncryptedPat(config.encrypted_pat);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to load status');
    }
  };

  const loadLogs = async () => {
    if (!session.api) return;
    try {
      const result = await session.api.getGitLog();
      setLogs(result.logs || []);
    } catch (e: any) {
      // Ignore log errors
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Show password prompt and wait for user input
  const promptForPassword = async (action: 'configure' | 'push' | 'pull'): Promise<string | null> => {
    setPendingAction(action);
    setPasswordForPat('');
    setShowPasswordPrompt(true);
    
    // Wait for user to submit or cancel
    return new Promise((resolve) => {
      const checkPassword = setInterval(() => {
        if (!showPasswordPrompt) {
          clearInterval(checkPassword);
          if (passwordForPat) {
            resolve(passwordForPat);
          } else {
            resolve(null);
          }
        }
      }, 100);
      
      // Timeout after 5 minutes
      setTimeout(() => {
        setShowPasswordPrompt(false);
        resolve(null);
      }, 300000);
    });
  };

  const handleConfigure = async () => {
    if (!repoUrl || !pat) {
      setError('Repository URL and PAT are required');
      return;
    }

    setConfiguring(true);
    setError('');

    try {
      if (!session.api) throw new Error('Not logged in');

      // Get password to encrypt PAT
      const password = await promptForPassword('configure');
      if (!password) {
        setError('Password required to encrypt PAT');
        setConfiguring(false);
        return;
      }

      // Get public key for PGP encryption
      const publicKey = await getPublicKey(fp);
      if (!publicKey) throw new Error('Public key not found');

      // Double-encrypt PAT: PGP + password
      const encryptedPat = await encryptPAT(pat, publicKey, password);

      // Configure server
      await session.api.configureGit(repoUrl, encryptedPat);

      setSuccess('Git sync configured successfully');
      setTimeout(() => setSuccess(''), 3000);
      setPat(''); // Clear PAT after config
      loadStatus();
      onSuccess?.();
    } catch (e: any) {
      setError(e.message || 'Configuration failed');
    }
    setConfiguring(false);
    setShowPasswordPrompt(false);
  };

  const handlePush = async () => {
    setLoading(true);
    setError('');

    try {
      if (!session.api) throw new Error('Not logged in');
      if (!status?.configured) throw new Error('Git sync not configured');

      // Get password to decrypt PAT
      const password = await promptForPassword('push');
      if (!password) {
        setError('Password required to decrypt PAT');
        setLoading(false);
        return;
      }

      // Get encrypted PAT from server and decrypt it
      if (!encryptedPat) {
        setError('PAT not configured. Please reconfigure Git sync.');
        setLoading(false);
        return;
      }

      // Get armored private key from storage
      const armoredPrivateKey = await getDecryptedPrivateKey(fp, password);
      if (!armoredPrivateKey) {
        setError('Failed to get private key. Check password.');
        setLoading(false);
        return;
      }

      // Decrypt the private key with the password
      const privateKey = await decryptPrivateKey(armoredPrivateKey, password);

      // Decrypt PAT: password + PGP
      const patToUse = await decryptPAT(encryptedPat, privateKey, password);
      if (!patToUse) {
        setError('Failed to decrypt PAT. Check password.');
        setLoading(false);
        return;
      }

      // Set session token
      await session.api.setGitSession(patToUse);

      // Push
      const result = await session.api.gitPush(patToUse);
      setSuccess(result.message || 'Pushed to remote');
      setTimeout(() => setSuccess(''), 3000);
      loadStatus();
      onSuccess?.();
    } catch (e: any) {
      setError(e.message || 'Push failed');
    }
    setLoading(false);
    setShowPasswordPrompt(false);
  };

  const handlePull = async () => {
    setLoading(true);
    setError('');
    setConflicts([]);

    try {
      if (!session.api) throw new Error('Not logged in');
      if (!status?.configured) throw new Error('Git sync not configured');

      // Get password to decrypt PAT
      const password = await promptForPassword('pull');
      if (!password) {
        setError('Password required to decrypt PAT');
        setLoading(false);
        return;
      }

      // Get encrypted PAT from server and decrypt it
      if (!encryptedPat) {
        setError('PAT not configured. Please reconfigure Git sync.');
        setLoading(false);
        return;
      }

      // Get armored private key from storage
      const armoredPrivateKey = await getDecryptedPrivateKey(fp, password);
      if (!armoredPrivateKey) {
        setError('Failed to get private key. Check password.');
        setLoading(false);
        return;
      }

      // Decrypt the private key with the password
      const privateKey = await decryptPrivateKey(armoredPrivateKey, password);

      // Decrypt PAT: password + PGP
      const patToUse = await decryptPAT(encryptedPat, privateKey, password);
      if (!patToUse) {
        setError('Failed to decrypt PAT. Check password.');
        setLoading(false);
        return;
      }

      // Set session token
      await session.api.setGitSession(patToUse);

      // Pull
      const result: PullResult = await session.api.gitPull(patToUse);

      if (result.status === 'conflict' && result.conflicts) {
        setConflicts(result.conflicts);
        setShowConflictDialog(true);
        setError('');
      } else {
        setSuccess(result.message || 'Pulled from remote');
        setTimeout(() => setSuccess(''), 3000);
        loadStatus();
        onSuccess?.();
      }
    } catch (e: any) {
      setError(e.message || 'Pull failed');
    }
    setLoading(false);
    setShowPasswordPrompt(false);
  };

  const handleResolveConflicts = async (resolution: 'local' | 'remote' | 'skip') => {
    setShowConflictDialog(false);
    setConflicts([]);

    if (resolution === 'remote') {
      // Force pull with --strategy-option=theirs (would need backend support)
      setError('Conflict resolution not yet implemented. Please resolve manually in git repo.');
    } else if (resolution === 'local') {
      // Push local changes
      await handlePush();
    }
    // skip: do nothing
  };

  const handleViewLogs = async () => {
    setShowLogs(true);
    await loadLogs();
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 600px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>🔄 Git Sync</h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div class="modal-body">
          {error && <p class="error-msg" style="margin-bottom: 12px;">{error}</p>}
          {success && <p class="success-msg" style="margin-bottom: 12px;">{success}</p>}

          {!status?.configured ? (
            // Configuration form
            <div class="settings-section">
              <h3>Configure Git Sync</h3>
              <p class="help-text" style="margin-bottom: 16px;">
                Sync your password store to a private Git repository.
                Your PAT will be double-encrypted (PGP + password) and stored securely.
              </p>

              <div class="input-group" style="flex-direction: column; gap: 12px;">
                <div>
                  <label class="label-text">Repository URL (HTTPS)</label>
                  <input
                    class="input"
                    type="url"
                    placeholder="https://github.com/user/private-repo.git"
                    value={repoUrl}
                    onInput={(e) => setRepoUrl((e.target as HTMLInputElement).value)}
                    style="width: 100%; margin-top: 4px;"
                  />
                </div>
                <div>
                  <label class="label-text">Personal Access Token (PAT)</label>
                  <input
                    class="input"
                    type="password"
                    placeholder="ghp_..."
                    value={pat}
                    onInput={(e) => setPat((e.target as HTMLInputElement).value)}
                    style="width: 100%; margin-top: 4px;"
                  />
                  <p class="help-text" style="font-size: 11px; margin-top: 4px;">
                    PAT will be encrypted with your PGP key, then encrypted with your login password.
                    Server stores the encrypted blob but cannot decrypt it.
                  </p>
                </div>
              </div>

              <div class="settings-buttons" style="margin-top: 16px;">
                <button
                  class="btn btn-primary"
                  onClick={handleConfigure}
                  disabled={configuring || !repoUrl || !pat}
                >
                  {configuring ? <><span class="spinner" /> Configuring...</> : '✓ Configure'}
                </button>
              </div>
            </div>
          ) : (
            // Status view
            <>
              <div class="settings-section">
                <h3>Status</h3>
                <div class="settings-row">
                  <span class="label-text">Repository</span>
                  <span class="value-text" style="font-size: 12px;" title={status.repo_url}>
                    {status.repo_url?.replace(/https:\/\/[^@]+@/, 'https://')}
                  </span>
                </div>
                <div class="settings-row">
                  <span class="label-text">Sync History</span>
                  <span class="value-text">
                    ✅ {status.success_count} / ❌ {status.failed_count}
                  </span>
                </div>
              </div>

              <div class="settings-section">
                <h3>Actions</h3>
                <p class="help-text" style="margin-bottom: 12px;">
                  Manual push/pull only. You will be prompted for your login password to decrypt the PAT.
                </p>
                <div class="settings-buttons">
                  <button
                    class="btn btn-sm"
                    onClick={handlePush}
                    disabled={loading || configuring}
                  >
                    {loading ? <><span class="spinner" /> Pushing...</> : '⬆️ Push Now'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handlePull}
                    disabled={loading || configuring}
                  >
                    {loading ? <><span class="spinner" /> Pulling...</> : '⬇️ Pull Now'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handleViewLogs}
                  >
                    📋 View Logs
                  </button>
                </div>
              </div>

              <div class="settings-section">
                <h3>Update Configuration</h3>
                <div class="input-group" style="flex-direction: column; gap: 12px;">
                  <div>
                    <label class="label-text">Repository URL</label>
                    <input
                      class="input"
                      type="url"
                      value={repoUrl}
                      onInput={(e) => setRepoUrl((e.target as HTMLInputElement).value)}
                      style="width: 100%; margin-top: 4px;"
                    />
                  </div>
                  <div>
                    <label class="label-text">New PAT (leave blank to keep current)</label>
                    <input
                      class="input"
                      type="password"
                      placeholder="ghp_..."
                      value={pat}
                      onInput={(e) => setPat((e.target as HTMLInputElement).value)}
                      style="width: 100%; margin-top: 4px;"
                    />
                  </div>
                </div>
                <div class="settings-buttons" style="margin-top: 12px;">
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={handleConfigure}
                    disabled={configuring || !repoUrl}
                  >
                    {configuring ? <><span class="spinner" /> Updating...</> : '💾 Update Config'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Password Prompt Modal */}
          {showPasswordPrompt && (
            <div class="modal-overlay">
              <div class="modal" style="max-width: 400px;">
                <div class="modal-header">
                  <h2>🔐 Enter Password</h2>
                </div>
                <div class="modal-body">
                  <p class="help-text" style="margin-bottom: 16px;">
                    Enter your login password to {pendingAction === 'configure' ? 'encrypt' : 'decrypt'} the PAT.
                  </p>
                  <input
                    class="input"
                    type="password"
                    placeholder="Login password"
                    value={passwordForPat}
                    onInput={(e) => setPasswordForPat((e.target as HTMLInputElement).value)}
                    style="width: 100%; margin-bottom: 16px;"
                    autoFocus
                  />
                  <div class="settings-buttons">
                    <button
                      class="btn btn-ghost"
                      onClick={() => {
                        setShowPasswordPrompt(false);
                        setPasswordForPat('');
                        setPendingAction(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      class="btn btn-primary"
                      onClick={() => {
                        setShowPasswordPrompt(false);
                        // Password is stored in state, action will continue
                      }}
                      disabled={!passwordForPat}
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Conflict Dialog */}
          {showConflictDialog && (
            <div class="modal-overlay" onClick={() => setShowConflictDialog(false)}>
              <div class="modal" style="max-width: 500px;" onClick={(e) => e.stopPropagation()}>
                <div class="modal-header">
                  <h2>⚠️ Sync Conflicts</h2>
                  <button class="btn btn-ghost btn-icon" onClick={() => setShowConflictDialog(false)}>✕</button>
                </div>
                <div class="modal-body">
                  <p class="help-text" style="margin-bottom: 16px;">
                    {conflicts.length} file(s) have conflicting changes on local and remote.
                  </p>
                  <div style="max-height: 200px; overflow-y: auto; margin-bottom: 16px;">
                    {conflicts.map((c, i) => (
                      <div key={i} class="settings-row" style="padding: 8px 0; border-bottom: 1px solid #eee;">
                        <span class="value-text" style="font-size: 12px;">{c.path}</span>
                      </div>
                    ))}
                  </div>
                  <div class="settings-buttons">
                    <button
                      class="btn btn-ghost"
                      onClick={() => handleResolveConflicts('skip')}
                    >
                      Skip
                    </button>
                    <button
                      class="btn btn-sm"
                      onClick={() => handleResolveConflicts('local')}
                    >
                      Keep Local (Push)
                    </button>
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={() => handleResolveConflicts('remote')}
                    >
                      Keep Remote (Pull)
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Logs Modal */}
          {showLogs && (
            <div class="modal-overlay" onClick={() => setShowLogs(false)}>
              <div class="modal" style="max-width: 500px;" onClick={(e) => e.stopPropagation()}>
                <div class="modal-header">
                  <h2>📋 Sync Logs</h2>
                  <button class="btn btn-ghost btn-icon" onClick={() => setShowLogs(false)}>✕</button>
                </div>
                <div class="modal-body" style="max-height: 400px; overflow-y: auto;">
                  {logs.length === 0 ? (
                    <p class="help-text">No sync activity yet.</p>
                  ) : (
                    <div class="log-list">
                      {logs.map((log) => (
                        <div
                          key={log.id}
                          class={`log-entry ${log.status === 'success' ? 'log-success' : 'log-error'}`}
                        >
                          <div class="log-header">
                            <span class="log-operation">{log.operation.toUpperCase()}</span>
                            <span class="log-status">{log.status === 'success' ? '✅' : '❌'}</span>
                            <span class="log-time">{new Date(log.created_at).toLocaleString()}</span>
                          </div>
                          <div class="log-message">{log.message}</div>
                          {log.entries_changed > 0 && (
                            <div class="log-changed">{log.entries_changed} entries</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
