import { useState, useRef, useEffect } from 'preact/hooks';
import { generateKeyPair, getFingerprint, decryptPrivateKey } from '../lib/crypto';
import { aesEncrypt, saveAccount } from '../lib/storage';
import { ApiClient } from '../lib/api';
import { session } from '../lib/session';
import QRCode from 'qrcode';
import { Footer } from './Footer';
import { Shield, Key, Lock, Check, AlertTriangle, ArrowRight, ArrowLeft } from 'lucide-preact';

interface Props {
  onComplete: () => void;
  onCancel: () => void;
  onAuthenticated: () => void;
}

export function Setup({ onComplete, onCancel, onAuthenticated }: Props) {
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [apiUrl, setApiUrl] = useState('');
  const [urlTesting, setUrlTesting] = useState(false);

  const [accountName, setAccountName] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginPasswordConfirm, setLoginPasswordConfirm] = useState('');
  const [registrationCode, setRegistrationCode] = useState('');

  const [keyMode, setKeyMode] = useState<'generate' | 'import'>('generate');
  const [pgpPassphrase, setPgpPassphrase] = useState('');
  const [pgpPassphraseConfirm, setPgpPassphraseConfirm] = useState('');
  const [importKeyData, setImportKeyData] = useState<string | Uint8Array | null>(null);
  const [importKeyFormat, setImportKeyFormat] = useState<'armored' | 'binary'>('armored');
  const [importPassphrase, setImportPassphrase] = useState('');

  const [publicKey, setPublicKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [keyReady, setKeyReady] = useState(false);

  const [totpSecret, setTotpSecret] = useState('');
  const [totpUrl, setTotpUrl] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpConfirmed, setTotpConfirmed] = useState(false);
  const [totpSkipped, setTotpSkipped] = useState(false);
  const [totpLoading, setTotpLoading] = useState(false);
  const qrRef = useRef<HTMLCanvasElement>(null);

  const [setupApi, setSetupApi] = useState<ApiClient | null>(null);
  const [registrationMode, setRegistrationMode] = useState<'disabled' | 'open' | 'protected' | 'unknown'>('unknown');

  useEffect(() => {
    const defaultUrl = window.location.origin;
    setApiUrl(defaultUrl);
  }, []);

  const formatFp = (fp: string) => fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

  const testConnection = async (): Promise<boolean> => {
    setUrlTesting(true);
    setError('');
    try {
      let url = apiUrl.replace(/\/+$/, '');
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error('URL must start with http:// or https://');
      }
      new URL(url);
      // Use health check endpoint instead of POST /api to avoid 403 in disabled mode
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        return true;
      } else {
        throw new Error(`Unexpected status: ${res.status}`);
      }
    } catch (e: any) {
      if (e.message.includes('http') || e.message.includes('network') || e.message.includes('fetch')) {
        setError(`Cannot reach server: ${e.message}`);
      } else {
        setError(e.message);
      }
      return false;
    } finally {
      setUrlTesting(false);
    }
  };

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

  const handleImportKey = async () => {
    setLoading(true);
    setError('');
    try {
      if (!importKeyData) {
        throw new Error('No key data provided');
      }
      await decryptPrivateKey(importKeyData, importPassphrase);
      const openpgp = await import('openpgp');
      let pubKey: string;
      let privKeyArmored: string;
      
      if (importKeyFormat === 'armored' && typeof importKeyData === 'string') {
        const privKeyObj = await openpgp.readPrivateKey({ armoredKey: importKeyData });
        pubKey = privKeyObj.toPublic().armor();
        privKeyArmored = importKeyData;
      } else if (importKeyFormat === 'binary' && importKeyData instanceof Uint8Array) {
        const privKeyObj = await openpgp.readPrivateKey({ binaryKey: importKeyData });
        pubKey = privKeyObj.toPublic().armor();
        privKeyArmored = privKeyObj.armor();
      } else {
        throw new Error('Invalid key format');
      }
      
      const fp = await getFingerprint(pubKey);
      setPublicKey(pubKey);
      setPrivateKey(privKeyArmored);
      setFingerprint(fp);
      setKeyReady(true);
    } catch (e: any) {
      setError(e.message || 'Invalid key or passphrase');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (totpUrl && qrRef.current) {
      QRCode.toCanvas(qrRef.current, totpUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(() => { });
    }
  }, [totpUrl]);

  const handleComplete = async () => {
    setLoading(true);
    setError('');
    try {
      const url = apiUrl.replace(/\/+$/, '');
      const api = new ApiClient(url);
      api.fingerprint = fingerprint;

      let loginResult: { token?: string; requires_2fa?: boolean } | null = null;
      let existingUser = false;
      let isNewUser = false;

      // Step 1: Try to create user on backend FIRST (before saving to IndexedDB)
      try {
        await api.setup(loginPassword, publicKey, fingerprint, registrationCode || undefined);
        loginResult = await api.login(loginPassword);
        isNewUser = true;
      } catch (e: any) {
        const msg = e?.message || '';
        // Check if error is about registration code
        if (/registration code required/i.test(msg) || /invalid or expired registration code/i.test(msg)) {
          setError('Invalid or expired registration code. Please check with your administrator.');
          setLoading(false);
          return;
        }
        if (!/user already exists/i.test(msg)) {
          throw e;
        }
        existingUser = true;
        loginResult = await api.login(loginPassword);
      }

      if (loginResult?.requires_2fa) {
        // 2FA required - save account to IndexedDB first (backend user already exists)
        // User will complete login on the login page with 2FA code
        if (isNewUser) {
          const encrypted = await aesEncrypt(url, loginPassword);
          await saveAccount({
            fingerprint,
            privateKey,
            publicKey,
            apiUrlEncrypted: encrypted.encrypted,
            apiUrlSalt: encrypted.salt,
            apiUrlIv: encrypted.iv,
            label: accountName.trim() || undefined,
          });
        }
        session.clear();
        onComplete();
        return;
      }

      if (loginResult?.token) {
        api.token = loginResult.token;

        // Step 2: ONLY save to IndexedDB AFTER backend confirms user exists
        if (isNewUser) {
          const encrypted = await aesEncrypt(url, loginPassword);
          await saveAccount({
            fingerprint,
            privateKey,
            publicKey,
            apiUrlEncrypted: encrypted.encrypted,
            apiUrlSalt: encrypted.salt,
            apiUrlIv: encrypted.iv,
            label: accountName.trim() || undefined,
          });
        }

        if (existingUser) {
          session.activate({
            fingerprint,
            token: loginResult.token,
            apiUrl: url,
            publicKey,
          });
          onAuthenticated();
          return;
        }

        setSetupApi(api);
      }

      setStep(4);
    } catch (e: any) {
      setError(e.message || 'Setup failed');
    }
    setLoading(false);
  };

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

  useEffect(() => {
    if (step === 4 && setupApi && !totpSecret && !totpSkipped) {
      initTOTP();
    }
  }, [step, setupApi]);

  const canProceedStep1 = apiUrl.trim().length > 0;
  const canProceedStep2 = loginPassword.length >= 1 && loginPassword === loginPasswordConfirm && 
    (registrationMode !== 'disabled' || (importKeyData && importPassphrase));
  const canProceedStep3 = keyReady;

  const handleStep1Next = async () => {
    const success = await testConnection();
    if (success) {
      // Fetch registration mode when entering step 2
      try {
        const url = apiUrl.replace(/\/+$/, '');
        const api = new ApiClient(url);
        const modeResult = await api.getRegistrationMode();
        setRegistrationMode(modeResult.mode);
      } catch (e: any) {
        // If we can't fetch mode, assume unknown and let backend enforce
        setRegistrationMode('unknown');
      }
      setStep(2);
      setError('');
    }
  };

  return (
    <div class="setup-page">
      <div class="setup-container">
        <div class="setup-header">
          <div class="icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="shieldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#6366f1" />
                  <stop offset="50%" stopColor="#8b5cf6" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
              </defs>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="url(#shieldGradient)" strokeWidth="2" fill="rgba(99,102,241,0.1)" />
              <path d="M9 12l2 2 4-4" stroke="url(#shieldGradient)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
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
          {step === 1 && (
            <>
              <div class="setup-step-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <Shield size={18} /> Step 1 of 4: API Server
                </span>
              </div>
              <div class="field">
                <label class="label">Server URL</label>
                <input
                  class="input input-mono"
                  type="url"
                  value={apiUrl}
                  onInput={(e) => {
                    setApiUrl((e.target as HTMLInputElement).value);
                    setError('');
                  }}
                  placeholder="https://webpass.example.com:8080"
                />
              </div>
              {error && <p class="error-msg">{error}</p>}
              <div class="setup-actions">
                <button class="btn" onClick={onCancel}>Cancel</button>
                <button
                  class="btn btn-primary"
                  onClick={handleStep1Next}
                  disabled={!canProceedStep1 || urlTesting}
                >
                  {urlTesting ? <><span class="spinner" /> Testing...</> : <>Next <ArrowRight size={16} style={{ marginLeft: '6px' }} /></>}
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div class="setup-step-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <Lock size={18} /> Step 2 of 4: Choose Password
                </span>
              </div>
              <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px; line-height: 1.6;">
                This password is used for server authentication and to encrypt your API URL locally.
                It is separate from your PGP passphrase.
              </p>
              <div class="field">
                <label class="label">Account Name (optional)</label>
                <input
                  class="input"
                  type="text"
                  value={accountName}
                  onInput={(e) => setAccountName((e.target as HTMLInputElement).value)}
                  placeholder="e.g., Personal, Work, etc."
                  autocomplete="off"
                />
                <p class="help-text" style="margin-top: 6px; font-size: 12px; color: var(--text-muted);">
                  A friendly name to help you identify this account. You can leave it blank to use the fingerprint.
                </p>
              </div>
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
              
              {/* Registration code field - only show in Protected or Open mode */}
              {registrationMode !== 'disabled' && (
                <div class="field">
                  <label class="label">
                    Registration Code
                    {registrationMode === 'protected' && <span style="color: var(--error); margin-left: 6px;">*</span>}
                    {registrationMode === 'open' && <span style="color: var(--text-muted); font-weight: normal; margin-left: 6px;">(optional)</span>}
                  </label>
                  <input
                    class="input input-mono"
                    type="text"
                    value={registrationCode}
                    onInput={(e) => {
                      setRegistrationCode((e.target as HTMLInputElement).value);
                      setError('');
                    }}
                    placeholder={registrationMode === 'protected' ? '6-digit code from admin (required)' : '6-digit code from admin'}
                    maxLength={6}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autocomplete="one-time-code"
                  />
                  <p class="help-text" style="margin-top: 6px; font-size: 12px; color: var(--text-muted);">
                    {registrationMode === 'protected'
                      ? 'Enter the 6-digit registration code from your administrator'
                      : 'Enter the 6-digit registration code if your administrator requires one'}
                  </p>
                </div>
              )}

              {/* Disabled mode - import existing account */}
              {registrationMode === 'disabled' && (
                <>
                  <div class="field">
                    <label class="label">Import Existing Account</label>
                    <p class="help-text" style="margin-bottom: 12px; font-size: 12px; color: var(--text-muted);">
                      Registration is disabled. Import your existing PGP private key to add this account.
                    </p>
                    <input
                      type="file"
                      accept=".asc,.pgp,.key,.gpg"
                      onChange={(e) => {
                        const input = e.target as HTMLInputElement;
                        const file = input.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = () => {
                            const data = reader.result as ArrayBuffer;
                            const bytes = new Uint8Array(data);
                            const decoder = new TextDecoder('utf-8', { fatal: false });
                            const textPreview = decoder.decode(bytes.slice(0, 50));
                            if (textPreview.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) {
                              setImportKeyData(decoder.decode(bytes));
                              setImportKeyFormat('armored');
                            } else {
                              setImportKeyData(bytes);
                              setImportKeyFormat('binary');
                            }
                            setError('');
                          };
                          reader.readAsArrayBuffer(file);
                        }
                      }}
                      disabled={loading}
                      style="width: 100%;"
                    />
                    {importKeyData && (
                      <p style={`font-size: 12px; margin-top: 8px; ${importKeyFormat === 'binary' ? 'color: var(--success);' : 'color: var(--text-muted);'}`}>
                        {importKeyFormat === 'binary' ? '✓ Binary key file detected' : '✓ Armored key file detected'}
                      </p>
                    )}
                  </div>
                  <div class="field">
                    <label class="label">Key Passphrase</label>
                    <input
                      class="input"
                      type="password"
                      value={importPassphrase}
                      onInput={(e) => setImportPassphrase((e.target as HTMLInputElement).value)}
                      placeholder="Passphrase for this key"
                      autocomplete="one-time-code"
                      name="pgp-import-passphrase"
                      data-lpignore="true"
                      data-bwignore="true"
                      data-1p-ignore="true"
                      disabled={loading || !importKeyData}
                    />
                  </div>
                </>
              )}

              {error && <p class="error-msg">{error}</p>}
              <div class="setup-actions">
                <button class="btn" onClick={() => setStep(1)}>
                  <ArrowLeft size={16} style={{ marginRight: '6px' }} /> Back
                </button>
                <button
                  class="btn btn-primary"
                  onClick={async () => {
                    setError('');
                    setLoading(true);
                    try {
                      // Check registration mode and validate code if required
                      const url = apiUrl.replace(/\/+$/, '');
                      const api = new ApiClient(url);

                      // In Disabled mode, import existing account
                      if (registrationMode === 'disabled') {
                        if (!importKeyData || !importPassphrase) {
                          setError('Please import your PGP private key and enter its passphrase');
                          setLoading(false);
                          return;
                        }
                        // Validate the key and extract fingerprint
                        const openpgp = await import('openpgp');
                        let privKeyObj: any;
                        if (importKeyFormat === 'armored' && typeof importKeyData === 'string') {
                          privKeyObj = await openpgp.readPrivateKey({ armoredKey: importKeyData });
                        } else if (importKeyFormat === 'binary' && importKeyData instanceof Uint8Array) {
                          privKeyObj = await openpgp.readPrivateKey({ binaryKey: importKeyData });
                        } else {
                          throw new Error('Invalid key format');
                        }
                        // Decrypt the key to verify passphrase
                        try {
                          await openpgp.decryptKey({
                            privateKey: privKeyObj,
                            passphrase: importPassphrase,
                          });
                        } catch (decryptErr: any) {
                          setError('Wrong passphrase for this key');
                          setLoading(false);
                          return;
                        }
                        const pubKey = privKeyObj.toPublic().armor();
                        const privKeyArmored = privKeyObj.armor();
                        const fp = await getFingerprint(pubKey);
                        
                        // Check if user exists on backend and verify password
                        let userExistsResult: any;
                        try {
                          userExistsResult = await api.checkUserExists(fp);
                        } catch (checkErr: any) {
                          if (checkErr.message.includes('404')) {
                            setError('Account not found on server. Please contact your administrator.');
                          } else {
                            throw checkErr;
                          }
                          setLoading(false);
                          return;
                        }
                        
                        // Verify password by attempting login
                        try {
                          const loginResult = await api.login(loginPassword);
                          if (loginResult.requires_2fa) {
                            // User has 2FA enabled, need to handle that
                            // For now, save account and let them complete 2FA on login
                          }
                        } catch (loginErr: any) {
                          // Check for authentication errors
                          const msg = loginErr.message || '';
                          if (msg.includes('invalid credentials') || msg.includes('401') || msg.includes('invalid password')) {
                            setError('Wrong password. Please enter the password for this account.');
                            setLoading(false);
                            return;
                          }
                          // For other errors, show the error message
                          setError(loginErr.message || 'Login verification failed');
                          setLoading(false);
                          return;
                        }
                        
                        // Save account to IndexedDB
                        const encrypted = await aesEncrypt(url, loginPassword);
                        await saveAccount({
                          fingerprint: fp,
                          privateKey: privKeyArmored,
                          publicKey: pubKey,
                          apiUrlEncrypted: encrypted.encrypted,
                          apiUrlSalt: encrypted.salt,
                          apiUrlIv: encrypted.iv,
                          label: accountName.trim() || undefined,
                        });
                        
                        // Proceed to login
                        setLoading(false);
                        onComplete();
                        return;
                      }

                      // In Protected mode, require registration code
                      if (registrationMode === 'protected' && !registrationCode.trim()) {
                        setError('Registration code is required. Please check with your administrator.');
                        setLoading(false);
                        return;
                      }

                      // Validate code if provided
                      if (registrationCode.trim()) {
                        await api.validateRegistrationCode(registrationCode.trim());
                      }

                      // Code is valid (or not required), proceed to step 3
                      setStep(3);
                    } catch (e: any) {
                      const msg = e?.message || '';
                      if (/registration code required/i.test(msg) || /invalid or expired registration code/i.test(msg)) {
                        setError('Invalid or expired registration code. Please check with your administrator.');
                      } else {
                        setError(e.message || 'Registration validation failed');
                      }
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={!canProceedStep2 || loading || (registrationMode === 'disabled' && (!importKeyData || !importPassphrase))}
                >
                  {loading ? <><span class="spinner" /> Validating...</> : <>Next <ArrowRight size={16} style={{ marginLeft: '6px' }} /></>}
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div class="setup-step-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <Key size={18} /> Step 3 of 4: PGP Key
                </span>
              </div>

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
                      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px; line-height: 1.6;">
                        This passphrase protects your PGP private key. You will be prompted for it each time you decrypt an entry.
                      </p>
                      <div class="field">
                        <label class="label">PGP Passphrase</label>
                        <input
                          class="input"
                          type="password"
                          value={pgpPassphrase}
                          onInput={(e) => setPgpPassphrase((e.target as HTMLInputElement).value)}
                          placeholder="Choose a PGP passphrase"
                          autocomplete="one-time-code"
                          name="pgp-passphrase-new"
                          data-lpignore="true"
                          data-bwignore="true"
                          data-1p-ignore="true"
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
                          autocomplete="one-time-code"
                          name="pgp-passphrase-confirm"
                          data-lpignore="true"
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                        {pgpPassphraseConfirm && pgpPassphrase !== pgpPassphraseConfirm && (
                          <p class="error-msg">Passphrases do not match</p>
                        )}
                      </div>
                      <button
                        class="btn btn-primary btn-block"
                        onClick={handleGenerateKey}
                        disabled={!pgpPassphrase || pgpPassphrase !== pgpPassphraseConfirm || loading}
                      >
                        {loading ? <><span class="spinner" /> Generating...</> : <><Key size={16} style={{ marginRight: '8px' }} /> Generate Keypair</>}
                      </button>
                    </>
                  ) : (
                    <>
                      <div class="field">
                        <label class="label">Import Private Key</label>
                        <p class="help-text" style="margin-bottom: 12px; font-size: 12px; color: var(--text-muted);">
                          Upload your PGP private key file (.asc, .key, .gpg, or .pgp)
                        </p>
                        <input
                          type="file"
                          accept=".asc,.pgp,.key,.gpg"
                          onChange={(e) => {
                            const input = e.target as HTMLInputElement;
                            const file = input.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              // Always read as ArrayBuffer first, then detect format from content
                              reader.onload = () => {
                                const data = reader.result as ArrayBuffer;
                                const bytes = new Uint8Array(data);

                                // Detect format by checking for PGP armor headers
                                // Armored text starts with "-----BEGIN PGP PRIVATE KEY BLOCK-----"
                                const decoder = new TextDecoder('utf-8', { fatal: false });
                                const textPreview = decoder.decode(bytes.slice(0, 50));

                                if (textPreview.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) {
                                  // Armored text format - decode as string
                                  const fullText = decoder.decode(bytes);
                                  setImportKeyData(fullText);
                                  setImportKeyFormat('armored');
                                } else {
                                  // Binary format (OpenPGP packets)
                                  setImportKeyData(bytes);
                                  setImportKeyFormat('binary');
                                }
                                setError('');
                              };
                              reader.readAsArrayBuffer(file);
                            }
                          }}
                          disabled={loading}
                          style="width: 100%;"
                        />
                        {importKeyData && (
                          <p style={`font-size: 12px; margin-top: 8px; ${importKeyFormat === 'binary' ? 'color: var(--success);' : 'color: var(--text-muted);'}`}>
                            {importKeyFormat === 'binary' ? '✓ Binary key file detected' : '✓ Armored key file detected'}
                          </p>
                        )}
                      </div>
                      <div class="field">
                        <label class="label">Key Passphrase</label>
                        <input
                          class="input"
                          type="password"
                          value={importPassphrase}
                          onInput={(e) => setImportPassphrase((e.target as HTMLInputElement).value)}
                          placeholder="Passphrase for this key"
                          autocomplete="one-time-code"
                          name="pgp-import-passphrase"
                          data-lpignore="true"
                          data-bwignore="true"
                          data-1p-ignore="true"
                          disabled={loading}
                        />
                      </div>
                      <button
                        class="btn btn-primary btn-block"
                        onClick={handleImportKey}
                        disabled={!importKeyData || !importPassphrase || loading}
                      >
                        {loading ? <><span class="spinner" /> Importing...</> : <><Key size={16} style={{ marginRight: '8px' }} /> Import Key</>}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <div class="notice notice-success">
                  <Check size={18} style={{ flexShrink: 0 }} />
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
                <button class="btn" onClick={() => { setStep(2); setKeyReady(false); setRegistrationCode(''); setError(''); }}>
                  <ArrowLeft size={16} style={{ marginRight: '6px' }} /> Back
                </button>
                <button
                  class="btn btn-primary"
                  onClick={handleComplete}
                  disabled={!canProceedStep3 || loading}
                >
                  {loading ? <><span class="spinner" /> Creating account...</> : <>Next <ArrowRight size={16} style={{ marginLeft: '6px' }} /></>}
                </button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div class="setup-step-title">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <Check size={18} /> Step 4 of 4: Confirm & 2FA
                </span>
              </div>

              <div style="margin-bottom: 20px;">
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
                <AlertTriangle size={18} style={{ flexShrink: 0 }} />
                <span>Save your password and PGP passphrase! They cannot be recovered if lost.</span>
              </div>

              <div class="separator" />

              {!totpConfirmed && !totpSkipped ? (
                <>
                  <h3 style="font-size: 14px; margin-bottom: 16px; display: flex; align-items: center; gap: '8px';">
                    <Shield size={16} /> Enable 2FA (recommended)
                  </h3>

                  {totpUrl ? (
                    <>
                      <div class="qr-container">
                        <canvas ref={qrRef} />
                      </div>
                      <div class="totp-secret">{totpSecret}</div>
                      <p style="color: var(--text-muted); font-size: 12px; text-align: center; margin-bottom: 16px; line-height: 1.6;">
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
                    class="btn btn-ghost btn-block"
                    style="margin-top: 12px;"
                    onClick={() => setTotpSkipped(true)}
                  >
                    Skip for now
                  </button>
                </>
              ) : (
                <div class={`notice ${totpConfirmed ? 'notice-success' : 'notice-info'}`}>
                  <Check size={18} style={{ flexShrink: 0 }} />
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
                  <Check size={16} style={{ marginRight: '8px' }} /> Complete Setup
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}
