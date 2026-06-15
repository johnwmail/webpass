import { useState, useEffect, useRef } from 'preact/hooks';
import { session } from '../lib/session';
import { getPublicKey, getDecryptedPrivateKey } from '../lib/storage';
import { encryptPAT, decryptPAT, encryptSSHKey, decryptSSHKey, decryptPrivateKey } from '../lib/crypto';

interface GitStatus {
  configured: boolean;
  repo_url?: string;
  auth_type?: string;
  has_encrypted_pat?: boolean;
  has_encrypted_ssh_key?: boolean;
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

interface TrustedHost {
  hostname: string;
  host_key_fingerprint: string;
  created_at: string;
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
  const [, forceUpdate] = useState(0);

  // Config form
  const [repoUrl, setRepoUrl] = useState('');
  const [authType, setAuthType] = useState('https');
  const [pat, setPat] = useState('');
  const [sshKey, setSshKey] = useState('');
  const [sshPassphrase, setSshPassphrase] = useState('');
  const [encryptedPat, setEncryptedPat] = useState('');
  const [encryptedSshKey, setEncryptedSshKey] = useState('');
  const [configuring, setConfiguring] = useState(false);

  // Passphrase prompt for PGP key decryption
  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  const [passphraseForPat, setPassphraseForPat] = useState('');
  const [pendingAction, setPendingAction] = useState<'configure' | 'push' | 'pull' | null>(null);

  // SSH TOFU prompt
  const [showHostKeyPrompt, setShowHostKeyPrompt] = useState(false);
  const [hostKeyInfo, setHostKeyInfo] = useState<{
    host: string;
    fingerprint: string;
    old_fingerprint?: string;
    isChanged: boolean;
  } | null>(null);
  // Pending push/pull token to retry after trusting host
  const pendingTokenRef = useRef<string>('');

  // Trusted hosts management
  const [showTrustedHosts, setShowTrustedHosts] = useState(false);
  const [trustedHosts, setTrustedHosts] = useState<TrustedHost[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);

  // Use a ref to store the current passphrase value for the resolver
  const passphraseRef = useRef<string>('');
  const resolverRef = useRef<((pwd: string | null) => void) | null>(null);

  const fp = session.fingerprint || '';

  const handleUrlChange = (url: string) => {
    setRepoUrl(url);
  };

  const formatTime = (iso?: string) => {
    if (!iso) return 'Never';
    const d = new Date(iso);
    return d.toLocaleString();
  };

  const loadStatus = async () => {
    if (!session.api) return;
    try {
      const s = await session.api.getGitStatus();
      setStatus({...s});
      if (s.configured && s.repo_url) {
        setRepoUrl(s.repo_url);
        setAuthType(s.auth_type || 'https');
      }

      // Fetch encrypted credentials from config endpoint
      const config = await session.api.getGitConfig();
      if (config.configured) {
        if (config.encrypted_pat) setEncryptedPat(config.encrypted_pat);
        if (config.encrypted_ssh_key) setEncryptedSshKey(config.encrypted_ssh_key);
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

  const loadTrustedHosts = async () => {
    if (!session.api) return;
    setLoadingHosts(true);
    try {
      const result = await session.api.getTrustedHosts();
      setTrustedHosts(result.hosts || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load trusted hosts');
    }
    setLoadingHosts(false);
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Show passphrase prompt and wait for user input
  const promptForPassphrase = async (action: 'configure' | 'push' | 'pull'): Promise<string | null> => {
    setPendingAction(action);
    setPassphraseForPat('');
    passphraseRef.current = '';
    setShowPassphrasePrompt(true);

    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  };

  // Auto-retry push/pull after trusting a host
  const retryAfterTrust = async (action: 'push' | 'pull', token: string) => {
    setShowHostKeyPrompt(false);
    setHostKeyInfo(null);
    setLoading(true);
    try {
      let result: any;
      if (action === 'push') {
        result = await session.api!.gitPush(token);
      } else {
        result = await session.api!.gitPull(token);
      }
      if (result.status === 'success') {
        setSuccess(result.message || `${action} completed`);
        setTimeout(() => setSuccess(''), 3000);
        loadStatus();
        onSuccess?.();
      } else if (result.status === 'host_key_unknown' || result.status === 'host_key_changed') {
        // Should not happen after trusting, but handle gracefully
        setError(`Host key issue: ${result.status}`);
      } else {
        setError(result.message || `${action} returned unexpected status`);
      }
    } catch (e: any) {
      setError(e.message || `${action} failed`);
    }
    setLoading(false);
    pendingTokenRef.current = '';
  };

  const handleConfigure = async () => {
    if (!repoUrl) {
      setError('Repository URL is required');
      return;
    }
    if (authType === 'https' && !pat) {
      setError('PAT is required for HTTPS');
      return;
    }
    if (authType === 'ssh' && !sshKey) {
      setError('SSH private key is required');
      return;
    }

    setConfiguring(true);
    setError('');

    try {
      if (!session.api) throw new Error('Not logged in');

      const publicKey = await getPublicKey(fp);
      if (!publicKey) throw new Error('Public key not found');

      let encryptedPatData = '';
      let encryptedSshKeyData = '';

      if (authType === 'https') {
        encryptedPatData = await encryptPAT(pat, publicKey);
      } else {
        // Encrypt SSH key (+ optional passphrase) into one blob
        encryptedSshKeyData = await encryptSSHKey(sshKey, sshPassphrase, publicKey);
      }

      // Configure server (auto-detect auth type from URL too)
      await session.api.configureGit(repoUrl, encryptedPatData, authType, encryptedSshKeyData);

      setStatus({
        configured: true,
        repo_url: repoUrl,
        auth_type: authType,
        has_encrypted_pat: authType === 'https',
        has_encrypted_ssh_key: authType === 'ssh',
        success_count: 0,
        failed_count: 0,
      });
      if (encryptedPatData) setEncryptedPat(encryptedPatData);
      if (encryptedSshKeyData) setEncryptedSshKey(encryptedSshKeyData);

      setSuccess('Git sync configured successfully');
      setTimeout(() => setSuccess(''), 3000);
      setPat('');
      setSshKey('');
      setSshPassphrase('');
      forceUpdate(n => n + 1);
    } catch (e: any) {
      console.error('[GitSync] configureGit error:', e);
      setError(e.message || 'Configuration failed');
    }
    setConfiguring(false);
    setShowPassphrasePrompt(false);
  };

  const handlePush = async () => {
    setLoading(true);
    setError('');

    try {
      if (!session.api) throw new Error('Not logged in');
      if (!status?.configured) throw new Error('Git sync not configured');

      const passphrase = await promptForPassphrase('push');
      if (!passphrase) {
        setError('Passphrase required to decrypt private key');
        setLoading(false);
        return;
      }

      const armoredPrivateKey = await getDecryptedPrivateKey(fp, passphrase);
      if (!armoredPrivateKey) {
        setError('Failed to get private key. Check passphrase.');
        setLoading(false);
        return;
      }
      const privateKey = await decryptPrivateKey(armoredPrivateKey, passphrase);

      let token = '';

      if (authType === 'ssh') {
        if (!encryptedSshKey) {
          setError('SSH key not configured. Please reconfigure Git sync.');
          setLoading(false);
          return;
        }
        // Decrypt SSH key + passphrase
        const sshData = await decryptSSHKey(encryptedSshKey, privateKey);
        if (!sshData.key) {
          setError('Failed to decrypt SSH key. Check passphrase.');
          setLoading(false);
          return;
        }
        token = sshData.key; // PEM key content
        // Note: sshData.passphrase is the SSH key's own passphrase (if any)
        // go-git can handle passphrase-protected keys via the NewPublicKeys function
      } else {
        if (!encryptedPat) {
          setError('PAT not configured. Please reconfigure Git sync.');
          setLoading(false);
          return;
        }
        token = await decryptPAT(encryptedPat, privateKey);
        if (!token) {
          setError('Failed to decrypt PAT. Check passphrase.');
          setLoading(false);
          return;
        }
      }

      // Set session token
      await session.api.setGitSession(token);
      pendingTokenRef.current = token;

      // Push
      const result = await session.api.gitPush(token);

      // Handle host key TOFU
      if (result.status === 'host_key_unknown') {
        setHostKeyInfo({
          host: result.host!,
          fingerprint: result.fingerprint!,
          isChanged: false,
        });
        setShowHostKeyPrompt(true);
        setLoading(false);
        return;
      }
      if (result.status === 'host_key_changed') {
        setHostKeyInfo({
          host: result.host!,
          fingerprint: result.new_fingerprint!,
          old_fingerprint: result.old_fingerprint!,
          isChanged: true,
        });
        setShowHostKeyPrompt(true);
        setLoading(false);
        return;
      }

      setSuccess(result.message || 'Pushed to remote');
      setTimeout(() => setSuccess(''), 3000);
      loadStatus();
      onSuccess?.();
    } catch (e: any) {
      setError(e.message || 'Push failed');
    }
    setLoading(false);
    setShowPassphrasePrompt(false);
  };

  const handlePull = async () => {
    setLoading(true);
    setError('');

    try {
      if (!session.api) throw new Error('Not logged in');
      if (!status?.configured) throw new Error('Git sync not configured');

      const passphrase = await promptForPassphrase('pull');
      if (!passphrase) {
        setError('Passphrase required to decrypt private key');
        setLoading(false);
        return;
      }

      const armoredPrivateKey = await getDecryptedPrivateKey(fp, passphrase);
      if (!armoredPrivateKey) {
        setError('Failed to get private key. Check passphrase.');
        setLoading(false);
        return;
      }
      const privateKey = await decryptPrivateKey(armoredPrivateKey, passphrase);

      let token = '';

      if (authType === 'ssh') {
        if (!encryptedSshKey) {
          setError('SSH key not configured. Please reconfigure Git sync.');
          setLoading(false);
          return;
        }
        const sshData = await decryptSSHKey(encryptedSshKey, privateKey);
        if (!sshData.key) {
          setError('Failed to decrypt SSH key. Check passphrase.');
          setLoading(false);
          return;
        }
        token = sshData.key;
      } else {
        if (!encryptedPat) {
          setError('PAT not configured. Please reconfigure Git sync.');
          setLoading(false);
          return;
        }
        token = await decryptPAT(encryptedPat, privateKey);
        if (!token) {
          setError('Failed to decrypt PAT. Check passphrase.');
          setLoading(false);
          return;
        }
      }

      await session.api.setGitSession(token);
      pendingTokenRef.current = token;

      const result = await session.api.gitPull(token);

      // Handle host key TOFU
      if (result.status === 'host_key_unknown') {
        setHostKeyInfo({
          host: result.host!,
          fingerprint: result.fingerprint!,
          isChanged: false,
        });
        setShowHostKeyPrompt(true);
        setLoading(false);
        return;
      }
      if (result.status === 'host_key_changed') {
        setHostKeyInfo({
          host: result.host!,
          fingerprint: result.new_fingerprint!,
          old_fingerprint: result.old_fingerprint!,
          isChanged: true,
        });
        setShowHostKeyPrompt(true);
        setLoading(false);
        return;
      }

      setSuccess(result.message || 'Pulled from remote');
      setTimeout(() => setSuccess(''), 3000);
      loadStatus();
      onSuccess?.();
    } catch (e: any) {
      setError(e.message || 'Pull failed');
    }
    setLoading(false);
    setShowPassphrasePrompt(false);
  };

  const handleTrustHost = async () => {
    if (!hostKeyInfo || !session.api) return;
    try {
      await session.api.trustHostKey(hostKeyInfo.host, hostKeyInfo.fingerprint);
      // Auto-retry the pending operation
      const action = pendingAction || 'push';
      const token = pendingTokenRef.current;
      if (token) {
        await retryAfterTrust(action as 'push' | 'pull', token);
      }
    } catch (e: any) {
      setError(e.message || 'Failed to trust host key');
    }
    setShowHostKeyPrompt(false);
    setHostKeyInfo(null);
    pendingTokenRef.current = '';
  };

  const handleViewLogs = async () => {
    setShowLogs(true);
    await loadLogs();
  };

  const handleViewTrustedHosts = async () => {
    setShowTrustedHosts(true);
    await loadTrustedHosts();
  };

  const handleDeleteTrustedHost = async (host: string) => {
    if (!session.api) return;
    try {
      await session.api.deleteTrustedHost(host);
      setTrustedHosts(prev => prev.filter(h => h.hostname !== host));
    } catch (e: any) {
      setError(e.message || 'Failed to delete trusted host');
    }
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
              </p>

              <div class="input-group" style="flex-direction: column; gap: 12px;">
                {/* Auth type tabs */}
                <div style="display: flex; gap: 0; margin-bottom: 8px; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border);">
                  <button
                    class={authType === 'https' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                    onClick={() => setAuthType('https')}
                    style={{ borderRadius: 0, flex: 1 }}
                    data-testid="git-auth-https-tab"
                  >
                    🔐 HTTPS
                  </button>
                  <button
                    class={authType === 'ssh' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                    onClick={() => setAuthType('ssh')}
                    style={{ borderRadius: 0, flex: 1 }}
                    data-testid="git-auth-ssh-tab"
                  >
                    🔑 SSH
                  </button>
                </div>

                <div>
                  <label class="label-text">Repository URL</label>
                  <input
                    class="input"
                    type="url"
                    placeholder={authType === 'https' ? 'https://github.com/user/private-repo.git' : 'git@github.com:user/private-repo.git'}
                    value={repoUrl}
                    onInput={(e) => handleUrlChange((e.target as HTMLInputElement).value)}
                    style="width: 100%; margin-top: 4px;"
                    data-testid="git-repo-url"
                  />
                </div>

                {authType === 'https' ? (
                  <div>
                    <label class="label-text">Personal Access Token (PAT)</label>
                    <input
                      class="input"
                      type="password"
                      placeholder="ghp_..."
                      value={pat}
                      onInput={(e) => setPat((e.target as HTMLInputElement).value)}
                      style="width: 100%; margin-top: 4px;"
                      autocomplete="one-time-code"
                      name="git-pat-token"
                      data-lpignore="true"
                      data-bwignore="true"
                      data-1p-ignore="true"
                      data-testid="git-pat"
                    />
                    <p class="help-text" style="font-size: 11px; margin-top: 4px;">
                      PAT is encrypted with your PGP public key.
                      Server stores the encrypted blob but cannot decrypt it.
                    </p>
                  </div>
                ) : (
                  <>
                    <div>
                      <label class="label-text">SSH Private Key</label>
                      <textarea
                        class="input"
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                        value={sshKey}
                        onInput={(e) => setSshKey((e.target as HTMLTextAreaElement).value)}
                        style="width: 100%; margin-top: 4px; font-family: monospace; font-size: 11px; min-height: 80px;"
                        rows={4}
                        data-testid="git-ssh-key"
                      />
                    </div>
                    <div>
                      <label class="label-text">Key Passphrase (optional)</label>
                      <input
                        class="input"
                        type="password"
                        placeholder="Leave blank if key has no passphrase"
                        value={sshPassphrase}
                        onInput={(e) => setSshPassphrase((e.target as HTMLInputElement).value)}
                        style="width: 100%; margin-top: 4px;"
                        autocomplete="one-time-code"
                        name="git-ssh-passphrase"
                        data-lpignore="true"
                        data-bwignore="true"
                        data-1p-ignore="true"
                      />
                      <p class="help-text" style="font-size: 11px; margin-top: 4px;">
                        The key and passphrase are encrypted together with your PGP key.
                        Server never sees the plaintext.
                      </p>
                    </div>
                  </>
                )}
              </div>

              <div class="settings-buttons" style="margin-top: 16px;">
                <button
                  class="btn btn-primary"
                  onClick={handleConfigure}
                  disabled={configuring || !repoUrl || (authType === 'https' && !pat) || (authType === 'ssh' && !sshKey)}
                  data-testid="git-configure-btn"
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
                  <span class="label-text">Auth</span>
                  <span class="value-text">
                    {authType === 'ssh' ? '🔑 SSH Key' : '🔐 PAT (HTTPS)'}
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
                  Manual push/pull only. You will be prompted for your PGP passphrase.
                </p>
                <div class="settings-buttons">
                  <button
                    class="btn btn-sm"
                    onClick={handlePush}
                    disabled={loading || configuring}
                    data-testid="git-push-btn"
                  >
                    {loading ? <><span class="spinner" /> Pushing...</> : '⬆️ Push Now'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handlePull}
                    disabled={loading || configuring}
                    data-testid="git-pull-btn"
                  >
                    {loading ? <><span class="spinner" /> Pulling...</> : '⬇️ Pull Now'}
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handleViewLogs}
                    data-testid="git-logs-btn"
                  >
                    📋 View Logs
                  </button>
                  <button
                    class="btn btn-sm"
                    onClick={handleViewTrustedHosts}
                    data-testid="git-trusted-hosts-btn"
                  >
                    🔑 Trusted Hosts
                  </button>
                </div>
              </div>

              <div class="settings-section">
                <h3>Update Configuration</h3>
                <div class="input-group" style="flex-direction: column; gap: 12px;">
                  {/* Auth type tabs */}
                  <div style="display: flex; gap: 0; margin-bottom: 8px; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border);">
                    <button
                      class={authType === 'https' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                      onClick={() => setAuthType('https')}
                      style={{ borderRadius: 0, flex: 1 }}
                      data-testid="git-auth-https-tab-update"
                    >
                      🔐 HTTPS
                    </button>
                    <button
                      class={authType === 'ssh' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost'}
                      onClick={() => setAuthType('ssh')}
                      style={{ borderRadius: 0, flex: 1 }}
                      data-testid="git-auth-ssh-tab-update"
                    >
                      🔑 SSH
                    </button>
                  </div>
                  <div>
                    <label class="label-text">Repository URL</label>
                    <input
                      class="input"
                      type="url"
                      value={repoUrl}
                      onInput={(e) => handleUrlChange((e.target as HTMLInputElement).value)}
                      style="width: 100%; margin-top: 4px;"
                    />
                  </div>
                  {authType === 'https' ? (
                    <div>
                      <label class="label-text">New PAT (leave blank to keep current)</label>
                      <input
                        class="input"
                        type="password"
                        placeholder="ghp_..."
                        value={pat}
                        onInput={(e) => setPat((e.target as HTMLInputElement).value)}
                        style="width: 100%; margin-top: 4px;"
                        autocomplete="one-time-code"
                        name="git-pat-update"
                        data-lpignore="true"
                        data-bwignore="true"
                        data-1p-ignore="true"
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        <label class="label-text">New SSH Key (leave blank to keep current)</label>
                        <textarea
                          class="input"
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          value={sshKey}
                          onInput={(e) => setSshKey((e.target as HTMLTextAreaElement).value)}
                          style="width: 100%; margin-top: 4px; font-family: monospace; font-size: 11px; min-height: 60px;"
                          rows={3}
                        />
                      </div>
                      <div>
                        <label class="label-text">Key Passphrase (if new key has one)</label>
                        <input
                          class="input"
                          type="password"
                          placeholder="Leave blank if no passphrase"
                          value={sshPassphrase}
                          onInput={(e) => setSshPassphrase((e.target as HTMLInputElement).value)}
                          style="width: 100%; margin-top: 4px;"
                        />
                      </div>
                    </>
                  )}
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

          {/* PGP Passphrase Prompt */}
          {showPassphrasePrompt && (
            <div class="modal-overlay">
              <div class="modal" style="max-width: 400px;">
                <div class="modal-header">
                  <h2>🔐 Enter PGP Passphrase</h2>
                </div>
                <div class="modal-body">
                  <p class="help-text" style="margin-bottom: 16px;">
                    Enter your PGP passphrase to {pendingAction === 'configure' ? 'encrypt' : 'decrypt'} the
                    {authType === 'ssh' ? ' SSH key' : ' PAT'}.
                  </p>
                  <input
                    class="input"
                    type="password"
                    placeholder="PGP passphrase"
                    value={passphraseForPat}
                    onInput={(e) => {
                      const val = (e.target as HTMLInputElement).value;
                      setPassphraseForPat(val);
                      passphraseRef.current = val;
                    }}
                    style="width: 100%; margin-bottom: 16px;"
                    autoFocus
                    autocomplete="one-time-code"
                    name="pgp-passphrase-git-pat"
                    data-lpignore="true"
                    data-bwignore="true"
                    data-1p-ignore="true"
                    data-testid="git-passphrase-prompt"
                  />
                  <div class="settings-buttons">
                    <button
                      class="btn btn-ghost"
                      onClick={() => {
                        setShowPassphrasePrompt(false);
                        setPassphraseForPat('');
                        setPendingAction(null);
                        resolverRef.current?.(null);
                        resolverRef.current = null;
                      }}
                      data-testid="git-passphrase-cancel"
                    >
                      Cancel
                    </button>
                    <button
                      class="btn btn-primary"
                      onClick={() => {
                        const pwd = passphraseRef.current;
                        setShowPassphrasePrompt(false);
                        setPassphraseForPat('');
                        setPendingAction(null);
                        if (resolverRef.current) {
                          resolverRef.current(pwd);
                          resolverRef.current = null;
                        }
                      }}
                      disabled={!passphraseForPat}
                      data-testid="git-passphrase-ok"
                    >
                      OK
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* SSH Host Key TOFU Prompt */}
          {showHostKeyPrompt && hostKeyInfo && (
            <div class="modal-overlay">
              <div class="modal" style="max-width: 450px;">
                <div class="modal-header">
                  <h2>{hostKeyInfo.isChanged ? '⚠️ Host Key Changed' : '🔐 First Time Connecting'}</h2>
                </div>
                <div class="modal-body">
                  {hostKeyInfo.isChanged ? (
                    <>
                      <p class="help-text" style="margin-bottom: 12px; color: #e74c3c; font-weight: bold;">
                        ⚠️ The host key for <strong>{hostKeyInfo.host}</strong> has changed!
                      </p>
                      <p class="help-text" style="margin-bottom: 12px;">
                        This could mean a <strong>man-in-the-middle attack</strong>.
                        Only trust if you know the host key was legitimately rotated.
                      </p>
                      <div style="background: #f8f9fa; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-family: monospace; font-size: 12px;">
                        <div><strong>Host:</strong> {hostKeyInfo.host}</div>
                        <div><strong>Old fingerprint:</strong> {hostKeyInfo.old_fingerprint}</div>
                        <div><strong>New fingerprint:</strong> {hostKeyInfo.fingerprint}</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p class="help-text" style="margin-bottom: 12px;">
                        First time connecting to <strong>{hostKeyInfo.host}</strong>.
                      </p>
                      <div style="background: #f8f9fa; padding: 10px; border-radius: 6px; margin-bottom: 12px; font-family: monospace; font-size: 12px;">
                        <div><strong>Host:</strong> {hostKeyInfo.host}</div>
                        <div><strong>Fingerprint:</strong> {hostKeyInfo.fingerprint}</div>
                      </div>
                      <p class="help-text" style="margin-bottom: 12px;">
                        Verify this fingerprint with your git provider's documentation.
                      </p>
                    </>
                  )}
                  <div class="settings-buttons">
                    <button
                      class="btn btn-ghost"
                      onClick={() => {
                        setShowHostKeyPrompt(false);
                        setHostKeyInfo(null);
                        pendingTokenRef.current = '';
                      }}
                      data-testid="git-hostkey-cancel"
                    >
                      Cancel
                    </button>
                    <button
                      class="btn btn-primary"
                      onClick={handleTrustHost}
                      data-testid="git-hostkey-trust"
                    >
                      {hostKeyInfo.isChanged ? 'Trust New Key' : '🔒 Trust This Host'}
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

          {/* Trusted Hosts Modal */}
          {showTrustedHosts && (
            <div class="modal-overlay" onClick={() => setShowTrustedHosts(false)}>
              <div class="modal" style="max-width: 500px;" onClick={(e) => e.stopPropagation()}>
                <div class="modal-header">
                  <h2>🔑 Trusted SSH Hosts</h2>
                  <button class="btn btn-ghost btn-icon" onClick={() => setShowTrustedHosts(false)}>✕</button>
                </div>
                <div class="modal-body" style="max-height: 400px; overflow-y: auto;">
                  {loadingHosts ? (
                    <p class="help-text">Loading...</p>
                  ) : trustedHosts.length === 0 ? (
                    <p class="help-text">No trusted hosts yet. They will appear after the first SSH push/pull.</p>
                  ) : (
                    <div class="log-list">
                      {trustedHosts.map((h) => (
                        <div key={h.hostname} class="log-entry log-success">
                          <div class="log-header">
                            <span class="log-operation">{h.hostname}</span>
                            <span class="log-time">{new Date(h.created_at).toLocaleString()}</span>
                          </div>
                          <div class="log-message" style="font-family: monospace; font-size: 11px;">
                            {h.host_key_fingerprint}
                          </div>
                          <div style="margin-top: 4px;">
                            <button
                              class="btn btn-sm btn-ghost"
                              onClick={() => handleDeleteTrustedHost(h.hostname)}
                              style="color: #e74c3c; font-size: 11px; padding: 2px 8px;"
                            >
                              🗑️ Remove
                            </button>
                          </div>
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
