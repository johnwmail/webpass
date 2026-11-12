import { useState } from 'preact/hooks';
import { ApiClient } from '../lib/api';
import { session } from '../lib/session';
import { saveAccount, aesEncrypt } from '../lib/storage';
import { decryptKeyTransfer, inspectPrivateKey, type KeyTransferEnvelope } from '../lib/keyTransfer';
import { Footer } from './Footer';
import { Key, Shield, Lock } from 'lucide-preact';

interface Props {
  apiUrl: string;
  fingerprint: string;
  token: string;
  onComplete: () => void;
  onCancel: () => void;
}

type LoginResult = { token?: string; expires_at?: number };

export function TransferRestore({ apiUrl, fingerprint, token, onComplete, onCancel }: Props) {
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [totpAvailable, setTotpAvailable] = useState(true);
  const [client, setClient] = useState<ApiClient | null>(null);
  const [loginResult, setLoginResult] = useState<LoginResult | null>(null);
  const [step, setStep] = useState<'login' | 'pairing'>('login');
  const [pairingCode, setPairingCode] = useState('');
  const [envelope, setEnvelope] = useState<KeyTransferEnvelope | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const finishLogin = (api: ApiClient, result: LoginResult) => {
    api.token = result.token || null;
    setClient(api);
    setLoginResult(result);
    setNeeds2fa(false);
    setStep('pairing');
    setError('');
  };

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const api = new ApiClient(apiUrl);
      api.fingerprint = fingerprint;
      const result = await api.login(password);
      if (result.requires_2fa) {
        if (result.totp === false && result.webauthn === true) {
          setError('This account requires a passkey. Use the WebPass web UI on the new device instead.');
        } else {
          setTotpAvailable(result.totp !== false);
          setClient(api);
          setNeeds2fa(true);
        }
      } else {
        finishLogin(api, result);
      }
    } catch (e: any) {
      setError(e.message || 'Login failed');
    }
    setLoading(false);
  };

  const handle2FA = async (e: Event) => {
    e.preventDefault();
    if (!client) return;
    setError('');
    setLoading(true);
    try {
      const result = useRecovery
        ? await client.loginRecovery(password, recoveryCode)
        : await client.login2fa(password, totpCode);
      finishLogin(client, result);
    } catch (e: any) {
      setError(e.message || '2FA failed');
    }
    setLoading(false);
  };

  const handleRestore = async (e: Event) => {
    e.preventDefault();
    if (!client) return;
    setError('');
    setLoading(true);
    try {
      // Make sure the CSRF cookie exists before a state-changing request.
      await fetch(`${apiUrl.replace(/\/+$/, '')}/api/health`, { credentials: 'include' }).catch(() => {});

      let env = envelope;
      if (!env) {
        const result = await client.redeemKeyTransfer(token);
        env = result.envelope;
        // Keep the envelope so a wrong pairing code can be retried locally.
        setEnvelope(env);
      }

      const armoredPrivateKey = await decryptKeyTransfer(env, pairingCode, fingerprint);
      const info = await inspectPrivateKey(armoredPrivateKey);
      const encryptedUrl = await aesEncrypt(apiUrl, password);

      await saveAccount({
        fingerprint,
        privateKey: armoredPrivateKey,
        publicKey: info.publicKey,
        apiUrlEncrypted: encryptedUrl.encrypted,
        apiUrlSalt: encryptedUrl.salt,
        apiUrlIv: encryptedUrl.iv,
      });

      session.activate({
        fingerprint,
        token: loginResult?.token || '',
        apiUrl,
        publicKey: info.publicKey,
        expiresAt: loginResult?.expires_at ?? null,
      });

      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      onComplete();
    } catch (e: any) {
      const msg = e?.message || 'Restore failed';
      setError(
        /not found or expired/i.test(msg)
          ? 'This link has expired or was already used. Create a new link on the other device.'
          : /wrong|decrypt|operation/i.test(msg)
            ? 'Wrong pairing code or corrupted transfer. Check the code and try again.'
            : msg
      );
    }
    setLoading(false);
  };

  const cancel = async () => {
    try {
      await client?.logout();
    } catch {
      // Best effort.
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    onCancel();
  };

  return (
    <div class="welcome-page">
      <div class="welcome-container">
        <div class="welcome-logo">
          <div class="icon">
            <Shield size={64} style={{ color: 'var(--accent)' }} />
          </div>
          <h1>Restore Account</h1>
          <p>Import your encrypted PGP key from another device</p>
        </div>

        <div class="card">
          <div class="field">
            <label class="label"><Key size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Account</label>
            <div class="account-item selected" style="cursor: default;">
              <Shield size={18} style={{ color: 'var(--accent)' }} />
              <span class="fp" style="word-break: break-all;">{fingerprint}</span>
            </div>
            <p class="help-text" style="margin-top: 8px;">Server: {apiUrl}</p>
          </div>

          {step === 'login' ? (
            <form onSubmit={needs2fa ? handle2FA : handleLogin}>
              <div class="field">
                <label class="label">Login password</label>
                <input
                  class="input"
                  type="password"
                  value={password}
                  onInput={(e) => { setPassword((e.target as HTMLInputElement).value); setError(''); }}
                  placeholder="Enter your login password"
                  autocomplete="current-password"
                  disabled={loading}
                />
              </div>

              {needs2fa && (
                <div class="field">
                  <label class="label">{useRecovery ? 'Recovery code' : '2FA code'}</label>
                  {useRecovery ? (
                    <input
                      class="input input-mono"
                      type="text"
                      value={recoveryCode}
                      onInput={(e) => { setRecoveryCode((e.target as HTMLInputElement).value); setError(''); }}
                      placeholder="XXXX-XXXX-XXXX-XXXX"
                      autocomplete="one-time-code"
                      disabled={loading}
                    />
                  ) : (
                    <input
                      class="input input-mono"
                      type="text"
                      value={totpCode}
                      onInput={(e) => { setTotpCode((e.target as HTMLInputElement).value); setError(''); }}
                      placeholder="6-digit code"
                      autocomplete="one-time-code"
                      maxLength={6}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      disabled={loading}
                    />
                  )}
                  {totpAvailable && (
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      style="margin-top: 8px;"
                      onClick={() => { setUseRecovery(!useRecovery); setError(''); }}
                    >
                      {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
                    </button>
                  )}
                </div>
              )}

              {error && <p class="error-msg">{error}</p>}

              <div style="display: flex; gap: 10px; margin-top: 12px;">
                <button
                  type="submit"
                  class="btn btn-primary"
                  style="flex: 1;"
                  disabled={loading || !password || (needs2fa && (useRecovery ? !recoveryCode : !totpCode))}
                >
                  {loading ? <><span class="spinner" /> Please wait...</> : needs2fa ? 'Verify' : 'Continue'}
                </button>
                <button type="button" class="btn" onClick={cancel} disabled={loading}>Cancel</button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRestore}>
              <p class="help-text" style="margin-bottom: 12px;">
                Enter the pairing code shown on the other device. It is never sent to the server.
              </p>
              <div class="field">
                <label class="label"><Lock size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Pairing code</label>
                <input
                  class="input"
                  type="password"
                  value={pairingCode}
                  onInput={(e) => { setPairingCode((e.target as HTMLInputElement).value); setError(''); }}
                  placeholder="Enter the pairing code"
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

              <div style="display: flex; gap: 10px; margin-top: 12px;">
                <button type="submit" class="btn btn-primary" style="flex: 1;" disabled={loading || !pairingCode}>
                  {loading ? <><span class="spinner" /> Restoring...</> : 'Restore key'}
                </button>
                <button type="button" class="btn" onClick={cancel} disabled={loading}>Cancel</button>
              </div>
              <p class="help-text" style="margin-top: 12px; font-size: 12px;">
                You will be asked for your PGP passphrase when viewing entries.
              </p>
            </form>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}
