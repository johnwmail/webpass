import { useState } from 'preact/hooks';
import { encryptText, decryptMessage, decryptPrivateKey } from '../lib/crypto';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';

interface Props {
  onClose: () => void;
}

export function EncryptModal({ onClose }: Props) {
  const [tab, setTab] = useState<'encrypt' | 'decrypt'>('encrypt');

  // Encrypt state
  const [plaintext, setPlaintext] = useState('');
  const [useRecipientKey, setUseRecipientKey] = useState(false);
  const [recipientKey, setRecipientKey] = useState('');
  const [encryptedOutput, setEncryptedOutput] = useState('');
  const [encryptError, setEncryptError] = useState('');
  const [encrypting, setEncrypting] = useState(false);

  // Decrypt state
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
      <div class="modal" style="max-width: 560px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div class="tabs" style="border-bottom: none;">
            <button
              class={`tab ${tab === 'encrypt' ? 'active' : ''}`}
              onClick={() => setTab('encrypt')}
            >Encrypt</button>
            <button
              class={`tab ${tab === 'decrypt' ? 'active' : ''}`}
              onClick={() => setTab('decrypt')}
            >Decrypt</button>
          </div>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>
        <div class="modal-body">
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
                    My public key
                  </label>
                  <label class="radio-label">
                    <input
                      type="radio"
                      checked={useRecipientKey}
                      onChange={() => setUseRecipientKey(true)}
                    />
                    Recipient's public key
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
                    placeholder="Paste recipient's armored public key..."
                  />
                </div>
              )}

              <button
                class="btn btn-primary"
                style="width: 100%;"
                onClick={handleEncrypt}
                disabled={!plaintext || encrypting}
              >
                {encrypting ? <><span class="spinner" /> Encrypting...</> : 'Encrypt →'}
              </button>

              {encryptError && <p class="error-msg">{encryptError}</p>}

              {encryptedOutput && (
                <div class="field" style="margin-top: 16px;">
                  <label class="label">Encrypted output</label>
                  <textarea
                    class="textarea input-mono"
                    rows={5}
                    value={encryptedOutput}
                    readOnly
                  />
                  <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                    <button class="btn btn-sm" onClick={() => copyOutput(encryptedOutput)}>
                      {copied ? '✓ Copied' : '📋 Copy'}
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
                  placeholder="Paste PGP message..."
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
                  />
                </div>
              )}

              <button
                class="btn btn-primary"
                style="width: 100%;"
                onClick={handleDecrypt}
                disabled={!ciphertext || decrypting}
              >
                {decrypting ? <><span class="spinner" /> Decrypting...</> : 'Decrypt →'}
              </button>

              {decryptError && <p class="error-msg">{decryptError}</p>}

              {decryptedOutput && (
                <div class="field" style="margin-top: 16px;">
                  <label class="label">Decrypted output</label>
                  <textarea
                    class="textarea input-mono"
                    rows={5}
                    value={decryptedOutput}
                    readOnly
                  />
                  <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
                    <button class="btn btn-sm" onClick={() => copyOutput(decryptedOutput)}>
                      {copied ? '✓ Copied' : '📋 Copy'}
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
