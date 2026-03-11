import { useState, useEffect } from 'preact/hooks';
import type { Account } from '../types';
import { listAccounts, getAccount, aesDecrypt } from '../lib/storage';
import { ApiClient } from '../lib/api';
import { session } from '../lib/session';

interface Props {
  onSetup: () => void;
  onLogin: () => void;
}

export function Welcome({ onSetup, onLogin }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedFp, setSelectedFp] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(true);

  useEffect(() => {
    listAccounts()
      .then((accs) => {
        setAccounts(accs);
        if (accs.length === 1) setSelectedFp(accs[0].fingerprint);
      })
      .catch(() => {})
      .finally(() => setLoadingAccounts(false));
  }, []);

  const formatFp = (fp: string) => {
    // Show as groups of 4
    const upper = fp.toUpperCase();
    return upper.replace(/(.{4})/g, '$1 ').trim();
  };

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    if (!selectedFp || !password) return;

    setError('');
    setLoading(true);

    try {
      const account = await getAccount(selectedFp);
      if (!account) throw new Error('Account not found');

      // Step 1: AES decrypt the API URL using login password
      let apiUrl: string;
      try {
        apiUrl = await aesDecrypt(
          account.apiUrlEncrypted,
          password,
          account.apiUrlSalt,
          account.apiUrlIv
        );
      } catch {
        throw new Error('Wrong password');
      }

      // Step 2: POST login to server
      const api = new ApiClient(apiUrl);
      api.fingerprint = selectedFp;

      if (needs2fa) {
        // Complete 2FA
        if (!totpCode) {
          setError('Enter your 2FA code');
          setLoading(false);
          return;
        }
        const result = await api.login2fa(password, totpCode);
        session.activate({
          fingerprint: selectedFp,
          token: result.token,
          apiUrl,
          publicKey: account.publicKey,
        });
        onLogin();
      } else {
        const result = await api.login(password);
        if (result.requires_2fa) {
          setNeeds2fa(true);
          setLoading(false);
          return;
        }
        if (!result.token) throw new Error('No token received');
        session.activate({
          fingerprint: selectedFp,
          token: result.token,
          apiUrl,
          publicKey: account.publicKey,
        });
        onLogin();
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
    setLoading(false);
  };

  return (
    <div class="welcome-page">
      <div class="welcome-container">
        <div class="welcome-logo">
          <div class="icon">🔐</div>
          <h1>WebPass</h1>
          <p>Web-based password manager</p>
        </div>

        <div class="card">
          <form onSubmit={handleLogin}>
            {accounts.length > 0 && (
              <div class="field">
                <label class="label">Account</label>
                {accounts.map((acc) => (
                  <div
                    key={acc.fingerprint}
                    class={`account-item ${selectedFp === acc.fingerprint ? 'selected' : ''}`}
                    onClick={() => {
                      setSelectedFp(acc.fingerprint);
                      setNeeds2fa(false);
                      setTotpCode('');
                      setError('');
                    }}
                  >
                    <span style="font-size: 18px;">🔑</span>
                    <span class="fp">
                      {acc.label || formatFp(acc.fingerprint)}
                    </span>
                    {selectedFp === acc.fingerprint && <span class="check">✓</span>}
                  </div>
                ))}
              </div>
            )}

            {loadingAccounts ? (
              <div class="loading">
                <span class="spinner" />
                Loading accounts...
              </div>
            ) : accounts.length === 0 ? (
              <div style="text-align: center; padding: 20px 0; color: var(--text-muted);">
                <p style="margin-bottom: 16px;">No accounts found. Create one to get started.</p>
                <button type="button" class="btn btn-primary" onClick={onSetup} style="width: 100%;">
                  Get Started →
                </button>
              </div>
            ) : (
              <>
                <div class="field">
                  <label class="label">Password</label>
                  <input
                    class="input"
                    type="password"
                    value={password}
                    onInput={(e) => {
                      setPassword((e.target as HTMLInputElement).value);
                      setError('');
                    }}
                    placeholder="Enter your login password"
                    autocomplete="current-password"
                    disabled={!selectedFp}
                  />
                </div>

                {needs2fa && (
                  <div class="field">
                    <label class="label">2FA Code</label>
                    <input
                      class="input input-mono"
                      type="text"
                      value={totpCode}
                      onInput={(e) => {
                        setTotpCode((e.target as HTMLInputElement).value);
                        setError('');
                      }}
                      placeholder="6-digit code"
                      autocomplete="one-time-code"
                      maxLength={6}
                      inputMode="numeric"
                      pattern="[0-9]*"
                    />
                  </div>
                )}

                {error && <p class="error-msg">{error}</p>}

                <div style="display: flex; gap: 8px; margin-top: 8px;">
                  <button
                    type="submit"
                    class="btn btn-primary"
                    style="flex: 1;"
                    disabled={!selectedFp || !password || loading}
                  >
                    {loading ? (
                      <><span class="spinner" /> Logging in...</>
                    ) : needs2fa ? 'Verify' : 'Login'}
                  </button>
                  <button type="button" class="btn" onClick={onSetup}>
                    Setup →
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
