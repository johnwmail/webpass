import { useState } from 'preact/hooks';
import { encryptText, decryptMessage, decryptPrivateKey } from '../lib/crypto';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { Lock, Unlock, Copy, Check, Shield, User } from 'lucide-preact';

interface Props {
  onClose: () => void;
}

export function EncryptModal({ onClose }: Props) {
  const [tab, setTab] = useState<'encrypt' | 'decrypt'>('encrypt');

  const [plaintext, setPlaintext] = useState('');
  const [useRecipientKey, setUseRecipientKey] = useState(false);
  const [recipientKey, setRecipientKey] = useState('');
  const [encryptedOutput, setEncryptedOutput] = useState('');
  const [encryptError, setEncryptError] = useState('');
  const [encrypting, setEncrypting] = useState(false);

  const [ciphertext, setCiphertext] = useState('');
  const [decryptedOutput, setDecryptedOutput] = useState('');
  const [decryptError, setDecryptError] = useState('');
  const [decrypting, setDecrypting] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [needsPassphrase, setNeedsPassphrase] = useState(false);

  const [copied, setCopied] = useState(false);

  const handleEncrypt = async () => {
    setEncryptError('');
    setEncryptedOutput('');
    setEncrypting(true);
    try {
      const pubKey = useRecipientKey ? recipientKey : session.publicKey;
      if (!pubKey) throw new Error('No public key available');
      const result = await encryptText(plaintext, pubKey);
      setEncryptedOutput(result);
    } catch (e: any) {
      setEncryptError(e.message || 'Encryption failed');
    }
    setEncrypting(false);
  };

  const handleDecrypt = async () => {
    if (!needsPassphrase) {
      setNeedsPassphrase(true);
      return;
    }
    setDecryptError('');
    setDecryptedOutput('');
    setDecrypting(true);
    try {
      const fp = session.fingerprint;
      if (!fp) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');
      const privateKey = await decryptPrivateKey(account.privateKey, passphrase);
      const result = await decryptMessage(ciphertext, privateKey);
      setDecryptedOutput(result);
      setNeedsPassphrase(false);
      setPassphrase('');
    } catch (e: any) {
      setDecryptError(e.message || 'Decryption failed');
    }
    setDecrypting(false);
  };

  const copyOutput = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 600px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>
            {tab === 'encrypt' ? (
              <><Lock size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} /> Encrypt</>
            ) : (
              <><Unlock size={18} style={{ marginRight: '8px', verticalAlign: 'middle' }} /> Decrypt</>
            )}
          </h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="tabs" style={{ marginBottom: '20px' }}>
            <button
              class={`tab ${tab === 'encrypt' ? 'active' : ''}`}
              onClick={() => setTab('encrypt')}
            >
              <Lock size={14} style={{ marginRight: '6px' }} /> Encrypt
            </button>
            <button
              class={`tab ${tab === 'decrypt' ? 'active' : ''}`}
              onClick={() => setTab('decrypt')}
            >
              <Unlock size={14} style={{ marginRight: '6px' }} /> Decrypt
            </button>
          </div>

          {tab === 'encrypt' ? (
            <>
              <div class="field">
                <label class="label">Plaintext</label>
                <textarea
                  class="textarea"
                  rows={4}
                  value={plaintext}
                  onInput={(e) => setPlaintext((e.target as HTMLTextAreaElement).value)}
                  placeholder="Type or paste content to encrypt..."
                />
              </div>

              <div class="field">
                <label class="label">Encrypt with</label>
                <div class="radio-group">
                  <label class="radio-label">
                    <input
                      type="radio"
                      checked={!useRecipientKey}
                      onChange={() => setUseRecipientKey(false)}
                    />
                    <Shield size={14} style={{ marginRight: '8px' }} /> My public key
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      checked={useRecipientKey}
                      onChange={() => setUseRecipientKey(true)}
                    />
                    <User size={14} style={{ marginRight: '8px' }} /> Recipient's public key
                  </label>
                </div>
              </div>

              {useRecipientKey && (
                <div class="field">
                  <textarea
                    class="textarea input-mono"
                    rows={3}
                    value={recipientKey}
                    onInput={(e) => setRecipientKey((e.target as HTMLTextAreaElement).value)}
                    placeholder="-----BEGIN PGP PUBLIC KEY BLOCK-----"
                  />
                </div>
              )}

              <button
                class="btn btn-primary btn-block"
                onClick={handleEncrypt}
                disabled={!plaintext || encrypting}
              >
                {encrypting ? <><span class="spinner" /> Encrypting...</> : <>Encrypt <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '8px' }}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg></>}
              </button>

              {encryptError && <p class="error-msg">{encryptError}</p>}

              {encryptedOutput && (
                <div class="field" style={{ marginTop: '20px' }}>
                  <label class="label">Encrypted output</label>
                  <textarea
                    class="textarea input-mono"
                    rows={5}
                    value={encryptedOutput}
                    readOnly
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                    <button class="btn btn-sm" onClick={() => copyOutput(encryptedOutput)}>
                      {copied ? <><Check size={14} style={{ marginRight: '6px', color: 'var(--success)' }} /> Copied</> : <><Copy size={14} style={{ marginRight: '6px' }} /> Copy</>}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div class="field">
                <label class="label">Encrypted PGP Message</label>
                <textarea
                  class="textarea input-mono"
                  rows={5}
                  value={ciphertext}
                  onInput={(e) => {
                    setCiphertext((e.target as HTMLTextAreaElement).value);
                    setNeedsPassphrase(false);
                    setDecryptedOutput('');
                    setDecryptError('');
                  }}
                  placeholder="-----BEGIN PGP MESSAGE-----"
                />
              </div>

              {needsPassphrase && (
                <div class="field">
                  <label class="label">PGP Passphrase</label>
                  <input
                    class="input"
                    type="password"
                    value={passphrase}
                    onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
                    placeholder="Enter your PGP passphrase"
                    autocomplete="off"
                    name="pgp-passphrase-decrypt"
                  />
                </div>
              )}

              <button
                class="btn btn-primary btn-block"
                onClick={handleDecrypt}
                disabled={!ciphertext || decrypting}
              >
                {decrypting ? <><span class="spinner" /> Decrypting...</> : <>Decrypt <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: '8px' }}><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg></>}
              </button>

              {decryptError && <p class="error-msg">{decryptError}</p>}

              {decryptedOutput && (
                <div class="field" style={{ marginTop: '20px' }}>
                  <label class="label">Decrypted output</label>
                  <textarea
                    class="textarea input-mono"
                    rows={5}
                    value={decryptedOutput}
                    readOnly
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' }}>
                    <button class="btn btn-sm" onClick={() => copyOutput(decryptedOutput)}>
                      {copied ? <><Check size={14} style={{ marginRight: '6px', color: 'var(--success)' }} /> Copied</> : <><Copy size={14} style={{ marginRight: '6px' }} /> Copy</>}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
