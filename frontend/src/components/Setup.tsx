import { useState, useRef, useEffect } from 'preact/hooks';
import { generateKeyPair, getFingerprint, decryptPrivateKey } from '../lib/crypto';
import { aesEncrypt, saveAccount } from '../lib/storage';
import { ApiClient } from '../lib/api';
import QRCode from 'qrcode';

interface Props {
  onComplete: () => void;
  onCancel: () => void;
}

export function Setup({ onComplete, onCancel }: Props) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Step 1: API server URL
  const [apiUrl, setApiUrl] = useState('');
  const [urlTested, setUrlTested] = useState(false);
  const [urlTesting, setUrlTesting] = useState(false);

  // Step 2: Login password
  const [loginPassword, setLoginPassword] = useState('');
  const [loginPasswordConfirm, setLoginPasswordConfirm] = useState('');

  // Step 3: PGP key
  const [keyMode, setKeyMode] = useState<'generate' | 'import'>('generate');
  const [pgpPassphrase, setPgpPassphrase] = useState('');
  const [pgpPassphraseConfirm, setPgpPassphraseConfirm] = useState('');
  const [importKey, setImportKey] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');

  // Generated/imported key data
  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [keyReady, setKeyReady] = useState(false);

  // Step 4: Summary + 2FA
  const [totpSecret, setTotpSecret] = useState('');
  const [totpUrl, setTotpUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpConfirmed, setTotpConfirmed] = useState(false);
  const [totpSkipped, setTotpSkipped] = useState(false);
  const [totpLoading, setTotpLoading] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  // Token for authed TOTP calls
  const [setupApi, setSetupApi] = useState<ApiClient | null>(null);

  const formatFp = (fp: string) => fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

  // Test API connection
  const testConnection = async () => {
    setUrlTesting(true);
    setError('');
    try {
      const url = apiUrl.replace(/\/+$/, '');
      const res = await fetch(`${url}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // We expect a 400 (missing fields) which proves the API is alive
      if (res.status === 400 || res.status === 200 || res.status === 201 || res.status === 409) {
        setUrlTested(true);
      } else {
        throw new Error(`Unexpected status: ${res.status}`);
      }
    } catch (e: any) {
      setError(`Cannot reach server: ${e.message}`);
    }
    setUrlTesting(false);
  };

  // Generate PGP key
  const handleGenerateKey = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await generateKeyPair(pgpPassphrase);
      setPublicKey(result.publicKey);
      setPrivateKey(result.privateKey);
      setFingerprint(result.fingerprint);
      setKeyReady(true);
    } catch (e: any) {
      setError(e.message || 'Key generation failed');
    }
    setLoading(false);
  };

  // Import PGP key
  const handleImportKey = async () => {
    setLoading(true);
    setError('');
    try {
      // Validate the key can be decrypted with the provided passphrase
      await decryptPrivateKey(importKey, importPassphrase);
      // Read public key from private key
      const openpgp = await import('openpgp');
      const privKeyObj = await openpgp.readPrivateKey({ armoredKey: importKey });
      const pubKey = privKeyObj.toPublic().armor();
      const fp = await getFingerprint(pubKey);
      setPublicKey(pubKey);
      // Store the private key as-is (still encrypted with its original passphrase)
      setPrivateKey(importKey);
      setFingerprint(fp);
      setKeyReady(true);
    } catch (e: any) {
      setError(e.message || 'Invalid key or passphrase');
    }
    setLoading(false);
  };

  // Setup TOTP QR code rendering
  useEffect(() => {
    if (totpUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, totpUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(() => {});
    }
  }, [totpUrl]);

  // Complete setup
  const handleComplete = async () => {
    setLoading(true);
    setError('');
    try {
      const url = apiUrl.replace(/\/+$/, '');
      const api = new ApiClient(url);

      // Register user on server
      await api.setup(loginPassword, publicKey, fingerprint);

      // AES encrypt the API URL with login password
      const encrypted = await aesEncrypt(url, loginPassword);

      // Save to IndexedDB
      await saveAccount({
        fingerprint,
        privateKey,
        publicKey,
        apiUrlEncrypted: encrypted.encrypted,
        apiUrlSalt: encrypted.salt,
        apiUrlIv: encrypted.iv,
      });

      // If we want to set up 2FA, we need to login first to get a JWT
      api.fingerprint = fingerprint;
      const loginResult = await api.login(loginPassword);
      if (loginResult.token) {
        api.token = loginResult.token;
        setSetupApi(api);
      }

      // Move to step 4 to offer 2FA setup
      setStep(4);
    } catch (e: any) {
      setError(e.message || 'Setup failed');
    }
    setLoading(false);
  };

  // Initialize TOTP
  const initTOTP = async () => {
    if (!setupApi) return;
    setTotpLoading(true);
    setError('');
    try {
      const result = await setupApi.setupTOTP();
      setTotpSecret(result.secret);
      setTotpUrl(result.url);
    } catch (e: any) {
      setError(e.message || 'TOTP setup failed');
    }
    setTotpLoading(false);
  };

  // Confirm TOTP
  const confirmTOTP = async () => {
    if (!setupApi || !totpSecret || !totpCode) return;
    setTotpLoading(true);
    setError('');
    try {
      await setupApi.confirmTOTP(totpSecret, totpCode);
      setTotpConfirmed(true);
    } catch (e: any) {
      setError(e.message || 'Invalid code');
    }
    setTotpLoading(false);
  };

  // Auto-init TOTP when reaching step 4
  useEffect(() => {
    if (step === 4 && setupApi && !totpSecret && !totpSkipped) {
      initTOTP();
    }
  }, [step, setupApi]);

  const canProceedStep1 = apiUrl.trim().length > 0 && urlTested;
  const canProceedStep2 = loginPassword.length >= 1 && loginPassword === loginPasswordConfirm;
  const canProceedStep3 = keyReady;

  return (
    <div class="setup-page">
      <div class="setup-container">
        <div class="setup-header">
          <div class="icon">🔐</div>
          <h1>WebPass — Setup</h1>
        </div>

        <div class="setup-steps">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              class={`setup-step ${s === step ? 'active' : ''} ${s < step ? 'done' : ''}`}
            />
          ))}
        </div>

        <div class="card">
          {/* Step 1: API Server */}
          {step === 1 && (
            <>
              <div class="setup-step-title">Step 1 of 4: API Server</div>
              <div class="field">
                <label class="label">Server URL</label>
                <div class="input-group">
                  <input
                    class="input input-mono"
                    type="url"
                    value={apiUrl}
                    onInput={(e) => {
                      setApiUrl((e.target as HTMLInputElement).value);
                      setUrlTested(false);
                      setError('');
                    }}
                    placeholder="https://webpass.example.com:8000"
                  />
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={testConnection}
                    disabled={!apiUrl.trim() || urlTesting}
                  >
                    {urlTesting ? <span class="spinner" /> : urlTested ? '✓ OK' : 'Test'}
                  </button>
                </div>
              </div>
              {urlTested && (
                <p class="success-msg">✓ Server is reachable</p>
              )}
              {error && <p class="error-msg">{error}</p>}
              <div class="setup-actions">
                <button class="btn" onClick={onCancel}>Cancel</button>
                <button
                  class="btn btn-primary"
                  onClick={() => { setStep(2); setError(''); }}
                  disabled={!canProceedStep1}
                >
                  Next →
                </button>
              </div>
            </>
          )}

          {/* Step 2: Password */}
          {step === 2 && (
            <>
              <div class="setup-step-title">Step 2 of 4: Choose Password</div>
              <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">
                This password is used for server authentication and to encrypt
                your API URL locally. It is separate from your PGP passphrase.
              </p>
              <div class="field">
                <label class="label">Login Password</label>
                <input
                  class="input"
                  type="password"
                  value={loginPassword}
                  onInput={(e) => setLoginPassword((e.target as HTMLInputElement).value)}
                  placeholder="Choose a strong password"
                  autocomplete="new-password"
                />
              </div>
              <div class="field">
                <label class="label">Confirm Password</label>
                <input
                  class="input"
                  type="password"
                  value={loginPasswordConfirm}
                  onInput={(e) => setLoginPasswordConfirm((e.target as HTMLInputElement).value)}
                  placeholder="Confirm your password"
                  autocomplete="new-password"
                />
                {loginPasswordConfirm && loginPassword !== loginPasswordConfirm && (
                  <p class="error-msg">Passwords do not match</p>
                )}
              </div>
              <div class="setup-actions">
                <button class="btn" onClick={() => setStep(1)}>← Back</button>
                <button
                  class="btn btn-primary"
                  onClick={() => { setStep(3); setError(''); }}
                  disabled={!canProceedStep2}
                >
                  Next →
                </button>
              </div>
            </>
          )}

          {/* Step 3: PGP Key */}
          {step === 3 && (
            <>
              <div class="setup-step-title">Step 3 of 4: PGP Key</div>

              {!keyReady ? (
                <>
                  <div class="field">
                    <div class="radio-group">
                      <label class="radio-label">
                        <input
                          type="radio"
                          checked={keyMode === 'generate'}
                          onChange={() => { setKeyMode('generate'); setError(''); }}
                        />
                        Generate new keypair
                      </label>
                      <label class="radio-label">
                        <input
                          type="radio"
                          checked={keyMode === 'import'}
                          onChange={() => { setKeyMode('import'); setError(''); }}
                        />
                        Import existing private key
                      </label>
                    </div>
                  </div>

                  {keyMode === 'generate' ? (
                    <>
                      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 12px;">
                        This passphrase protects your PGP private key. You will
                        be prompted for it each time you decrypt an entry.
                      </p>
                      <div class="field">
                        <label class="label">PGP Passphrase</label>
                        <input
                          class="input"
                          type="password"
                          value={pgpPassphrase}
                          onInput={(e) => setPgpPassphrase((e.target as HTMLInputElement).value)}
                          placeholder="Choose a PGP passphrase"
                          autocomplete="off"
                        />
                      </div>
                      <div class="field">
                        <label class="label">Confirm PGP Passphrase</label>
                        <input
                          class="input"
                          type="password"
                          value={pgpPassphraseConfirm}
                          onInput={(e) => setPgpPassphraseConfirm((e.target as HTMLInputElement).value)}
                          placeholder="Confirm your PGP passphrase"
                          autocomplete="off"
                        />
                        {pgpPassphraseConfirm && pgpPassphrase !== pgpPassphraseConfirm && (
                          <p class="error-msg">Passphrases do not match</p>
                        )}
                      </div>
                      <button
                        class="btn btn-primary"
                        style="width: 100%;"
                        onClick={handleGenerateKey}
                        disabled={!pgpPassphrase || pgpPassphrase !== pgpPassphraseConfirm || loading}
                      >
                        {loading ? <><span class="spinner" /> Generating...</> : '🔑 Generate Keypair'}
                      </button>
                    </>
                  ) : (
                    <>
                      <div class="field">
                        <label class="label">Private Key (armored)</label>
                        <textarea
                          class="textarea input-mono"
                          rows={5}
                          value={importKey}
                          onInput={(e) => setImportKey((e.target as HTMLTextAreaElement).value)}
                          placeholder="Paste your armored PGP private key..."
                        />
                      </div>
                      <div class="field">
                        <label class="label">Key Passphrase</label>
                        <input
                          class="input"
                          type="password"
                          value={importPassphrase}
                          onInput={(e) => setImportPassphrase((e.target as HTMLInputElement).value)}
                          placeholder="Passphrase for this key"
                          autocomplete="off"
                        />
                      </div>
                      <button
                        class="btn btn-primary"
                        style="width: 100%;"
                        onClick={handleImportKey}
                        disabled={!importKey || !importPassphrase || loading}
                      >
                        {loading ? <><span class="spinner" /> Importing...</> : '📥 Import Key'}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <div class="notice notice-success">
                  <span>✓</span>
                  <div>
                    <strong>Key ready!</strong><br />
                    <span style="font-family: var(--font-mono); font-size: 12px;">
                      {formatFp(fingerprint)}
                    </span>
                  </div>
                </div>
              )}

              {error && <p class="error-msg">{error}</p>}

              <div class="setup-actions">
                <button class="btn" onClick={() => { setStep(2); setKeyReady(false); setError(''); }}>
                  ← Back
                </button>
                <button
                  class="btn btn-primary"
                  onClick={handleComplete}
                  disabled={!canProceedStep3 || loading}
                >
                  {loading ? <><span class="spinner" /> Creating account...</> : 'Next →'}
                </button>
              </div>
            </>
          )}

          {/* Step 4: Summary + 2FA */}
          {step === 4 && (
            <>
              <div class="setup-step-title">Step 4 of 4: Confirm & 2FA</div>

              <div style="margin-bottom: 16px;">
                <div class="settings-row">
                  <span class="label-text">API Server</span>
                  <span class="value-text">{apiUrl}</span>
                </div>
                <div class="settings-row">
                  <span class="label-text">Fingerprint</span>
                  <span class="value-text">{formatFp(fingerprint)}</span>
                </div>
                <div class="settings-row">
                  <span class="label-text">Key Type</span>
                  <span class="value-text">ECC Curve25519</span>
                </div>
              </div>

              <div class="notice notice-warning">
                <span>⚠️</span>
                <span>Save your password and PGP passphrase! They cannot be recovered if lost.</span>
              </div>

              <div class="separator" />

              {!totpConfirmed && !totpSkipped ? (
                <>
                  <h3 style="font-size: 14px; margin-bottom: 12px;">Enable 2FA (recommended)</h3>

                  {totpUrl ? (
                    <>
                      <div class="qr-container">
                        <canvas ref={qrRef} />
                      </div>
                      <div class="totp-secret">{totpSecret}</div>
                      <p style="color: var(--text-muted); font-size: 12px; text-align: center; margin-bottom: 12px;">
                        Scan the QR code with your authenticator app, or enter the secret manually.
                      </p>
                      <div class="field">
                        <label class="label">Verification Code</label>
                        <div class="input-group">
                          <input
                            class="input input-mono"
                            type="text"
                            value={totpCode}
                            onInput={(e) => {
                              setTotpCode((e.target as HTMLInputElement).value);
                              setError('');
                            }}
                            placeholder="6-digit code"
                            maxLength={6}
                            inputMode="numeric"
                            pattern="[0-9]*"
                          />
                          <button
                            class="btn btn-primary btn-sm"
                            onClick={confirmTOTP}
                            disabled={totpCode.length < 6 || totpLoading}
                          >
                            {totpLoading ? <span class="spinner" /> : 'Verify'}
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div class="loading">
                      {totpLoading ? (
                        <><span class="spinner" /> Setting up 2FA...</>
                      ) : (
                        <button class="btn" onClick={initTOTP}>Setup 2FA</button>
                      )}
                    </div>
                  )}

                  {error && <p class="error-msg">{error}</p>}

                  <button
                    class="btn btn-ghost"
                    style="width: 100%; margin-top: 8px;"
                    onClick={() => setTotpSkipped(true)}
                  >
                    Skip for now
                  </button>
                </>
              ) : (
                <div class={`notice ${totpConfirmed ? 'notice-success' : 'notice-info'}`}>
                  <span>{totpConfirmed ? '✓' : 'ℹ️'}</span>
                  <span>
                    {totpConfirmed
                      ? '2FA is enabled. Your account is secured with two-factor authentication.'
                      : '2FA skipped. You can enable it later in Settings.'}
                  </span>
                </div>
              )}

              <div class="setup-actions">
                <div />
                <button class="btn btn-primary" onClick={onComplete}>
                  Complete ✓
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
