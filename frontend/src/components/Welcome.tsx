import { useState, useEffect } from 'preact/hooks';
import type { Account } from '../types';
import { listAccounts, getAccount, aesDecrypt } from '../lib/storage';
import { ApiClient } from '../lib/api';
import { session } from '../lib/session';
import { Footer } from './Footer';
import { Lock, Key, Shield } from 'lucide-preact';

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
      .catch(() => { })
      .finally(() => setLoadingAccounts(false));
  }, []);

  const formatFp = (fp: string) => {
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

      const api = new ApiClient(apiUrl);
      api.fingerprint = selectedFp;

      if (needs2fa) {
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
          <div class="icon">
            <svg width="80" height="80" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="lockGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="50%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
              <rect x="3" y="11" width="18" height="11" rx="2" stroke="url(#lockGradient)" strokeWidth="2" fill="rgba(99,102,241,0.1)" />
              <path d="M7 11V7a5 5 0 0110 0v4" stroke="url(#lockGradient)" strokeWidth="2" strokeLinecap="round" />
              <circle cx="12" cy="16" r="1" fill="url(#lockGradient)" />
            </svg>
          </div>
          <h1>WebPass</h1>
          <p>Zero-knowledge password manager</p>
        </div>

        <div class="card">
          <form onSubmit={handleLogin}>
            {accounts.length > 0 && (
              <div class="field">
                <label class="label">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <Key size={14} /> Select Account
                  </span>
                </label>
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
                    <Shield size={18} style={{ color: 'var(--accent)' }} />
                    <span class="fp">
                      {acc.label || formatFp(acc.fingerprint)}
                    </span>
                    {selectedFp === acc.fingerprint && (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--success)' }}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
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
              <div style="text-align: center; padding: 24px 0; color: var(--text-muted);">
                <div style={{ marginBottom: '16px', opacity: 0.5 }}>
                  <Lock size={48} style={{ margin: '0 auto' }} />
                </div>
                <p style="margin-bottom: 20px; font-size: 14px;">No accounts found. Create one to get started.</p>
                <button type="button" class="btn btn-primary btn-block" onClick={onSetup}>
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

                <div style="display: flex; gap: 10px; margin-top: 12px;">
                  <button
                    type="submit"
                    class="btn btn-primary"
                    style="flex: 1;"
                    disabled={!selectedFp || !password || loading}
                  >
                    {loading ? (
                      <><span class="spinner" /> Logging in...</>
                    ) : needs2fa ? 'Verify' : (
                      <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg> Login</>
                    )}
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
      <Footer />
    </div>
  );
}
