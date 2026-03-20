import { useState } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { importPrivateKey, decryptBinary, encryptBinary, clearSensitiveData } from '../lib/crypto';
import { Lock, Key, Save } from 'lucide-preact';

interface Props {
  entryPath: string;
  onReencryptComplete: () => void;
  onCancel: () => void;
}

export function ReencryptDialog({ entryPath, onReencryptComplete, onCancel }: Props) {
  const [privateKeyFile, setPrivateKeyFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const handleReencrypt = async () => {
    if (!privateKeyFile) {
      setError('Please select the private key file');
      return;
    }

    setProcessing(true);
    setError('');

    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');

      // Step 1: Read private key file
      const privateKeyArmored = await readFileAsText(privateKeyFile);

      // Step 2: Decrypt with imported private key
      const importedPrivateKey = await importPrivateKey(privateKeyArmored, passphrase);

      // Step 3: Fetch encrypted entry from server
      const encryptedBlob = await session.api.getEntry(entryPath);

      // Step 4: Decrypt with imported key
      const plaintext = await decryptBinary(encryptedBlob, importedPrivateKey);

      // Step 5: Re-encrypt with current account's public key
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      const reencrypted = await encryptBinary(plaintext, account.publicKey);

      // Step 6: Save re-encrypted entry
      await session.api.putEntry(entryPath, reencrypted);

      // Step 7: Clear sensitive data from memory
      clearSensitiveData(importedPrivateKey, passphrase, plaintext);

      onReencryptComplete();
    } catch (e: any) {
      setError(e.message || 'Re-encryption failed');
    }

    setProcessing(false);
  };

  const handleCancel = () => {
    // Clear any sensitive data
    clearSensitiveData(passphrase);
    setPassphrase('');
    onCancel();
  };

  return (
    <div class="modal-overlay">
      <div class="modal reencrypt-dialog">
        <div class="modal-header">
          <Lock size={24} />
          <h3>Entry Encrypted with Different Key</h3>
        </div>

        <div class="modal-content">
          <p class="info-text">
            This entry was encrypted with a different PGP key than your current account.
            To decrypt it, provide the original private key that was used to encrypt this entry.
          </p>

          <div class="info-box">
            <strong>What will happen:</strong>
            <ol>
              <li>Entry will be decrypted with the original private key</li>
              <li>Re-encrypted with your current account's public key</li>
              <li>Saved back to the server</li>
              <li>Original private key will be cleared from memory</li>
            </ol>
          </div>

          <div class="field">
            <label class="label">
              <Key size={14} style={{ marginRight: '6px' }} />
              Original Private Key File
            </label>
            <input
              type="file"
              accept=".asc,.gpg,.pgp"
              onChange={(e) => setPrivateKeyFile((e.target as HTMLInputElement).files?.[0] || null)}
            />
            <small class="help-text">
              Select the private key file (.asc, .gpg, or .pgp format)
            </small>
          </div>

          <div class="field">
            <label class="label">Passphrase for Original Key</label>
            <input
              type="password"
              value={passphrase}
              onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              placeholder="Enter passphrase for the original key"
              autoComplete="one-time-code"
              name="pgp-passphrase-original"
              data-lpignore="true"
              data-bwignore="true"
              data-1p-ignore="true"
            />
          </div>

          {error && <p class="error-msg">{error}</p>}

          <div class="modal-actions">
            <button class="btn btn-ghost" onClick={handleCancel}>
              Skip
            </button>
            <button
              class="btn btn-primary"
              onClick={handleReencrypt}
              disabled={!privateKeyFile || !passphrase || processing}
            >
              {processing ? (
                <><span class="spinner" /> Decrypting & Re-encrypting...</>
              ) : (
                <><Save size={16} style={{ marginRight: '8px' }} /> Decrypt & Re-encrypt</>
              )}
            </button>
          </div>

          <p class="info-text" style={{ fontSize: '12px', marginTop: '12px' }}>
            Don't have the original key? Click <strong>Skip</strong>. The entry will remain 
            encrypted and can be re-encrypted later when you have the key.
          </p>
        </div>
      </div>
    </div>
  );
}

// Helper function to read file as text
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
