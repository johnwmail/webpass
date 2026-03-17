import { useState, useRef } from 'preact/hooks';
import { session } from '../lib/session';
import { importPrivateKey, clearSensitiveData } from '../lib/crypto';
import { importArchive, type ImportProgress } from '../lib/import';
import type * as openpgp from 'openpgp';

interface Props {
  onClose: () => void;
  onSuccess?: (imported: number) => void;
}

export function ImportDialog({ onClose, onSuccess }: Props) {
  const [archiveFile, setArchiveFile] = useState<File | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [keyData, setKeyData] = useState<string | Uint8Array | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  const archiveInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);

  const handleArchiveChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      setArchiveFile(file);
      setError('');
    }
  };

  const handleKeyChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      setKeyFile(file);
      setError('');
      // Read as ArrayBuffer and detect format from content (not extension)
      const reader = new FileReader();
      reader.onload = () => {
        const data = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(data);
        
        // Detect format by checking for PGP armor headers
        // Armored text starts with "-----BEGIN PGP PRIVATE KEY BLOCK-----"
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const textPreview = decoder.decode(bytes.slice(0, 50));
        
        if (textPreview.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) {
          // Armored text format - decode as string
          setKeyData(decoder.decode(bytes));
        } else {
          // Binary format (OpenPGP packets)
          setKeyData(bytes);
        }
      };
      reader.readAsArrayBuffer(file);
    }
  };

  const handleImport = async () => {
    if (!archiveFile || !keyData || !passphrase || !session.api) {
      setError('Please fill in all fields');
      return;
    }

    setImporting(true);
    setError('');

    let privateKey: openpgp.PrivateKey | null = null;

    try {
      // Step 1: Import and decrypt private key (supports both armored and binary)
      privateKey = await importPrivateKey(keyData, passphrase);

      // Clear passphrase from memory immediately
      setPassphrase('');
      clearSensitiveData(passphrase);

      // Step 2: Get account public key
      const account = session.getState();
      if (!account.publicKey) {
        throw new Error('Account public key not found');
      }

      // Step 3: Process and import archive
      const result = await importArchive(
        archiveFile,
        privateKey,
        account.publicKey,
        session.api,
        session.fingerprint || '',
        setProgress
      );

      // Step 4: Clear private key from memory
      clearSensitiveData(privateKey);
      privateKey = null;

      // Step 5: Notify success
      onSuccess?.(result.imported);
      onClose();

    } catch (err: any) {
      console.error('Import failed:', err);

      // Clear private key on error
      if (privateKey) {
        clearSensitiveData(privateKey);
        privateKey = null;
      }

      // Handle specific error types
      if (err.message?.includes('passphrase')) {
        setError('Invalid passphrase for private key. Please try again.');
        setPassphrase('');
      } else if (err.message?.includes('No .gpg files')) {
        setError('No .gpg files found in archive. Please check the file format.');
      } else {
        setError(err.message || 'Import failed. Please try again.');
      }
    } finally {
      setImporting(false);
    }
  };

  const isFormValid = archiveFile && keyData && passphrase && !importing;

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal" style="max-width: 520px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>📥 Import Password Store</h2>
          <button class="btn btn-ghost btn-icon" onClick={onClose}>✕</button>
        </div>

        <div class="modal-body">
          {error && (
            <p class="error-msg" style="margin-bottom: 16px; color: var(--danger);">
              {error}
            </p>
          )}

          {/* Progress indicator */}
          {progress && (
            <div style="margin-bottom: 16px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span style="font-size: 14px; color: var(--text-muted);">
                  {progress.message}
                </span>
                <span style="font-size: 14px; color: var(--text-muted);">
                  {progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%
                </span>
              </div>
              <div style="background: var(--bg-tertiary); border-radius: 4px; height: 8px; overflow: hidden;">
                <div
                  style={`
                    background: var(--primary);
                    height: 100%;
                    width: ${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%;
                    transition: width 0.3s ease;
                  `}
                />
              </div>
            </div>
          )}

          {/* Step 1: Select Archive */}
          <div style="margin-bottom: 20px;">
            <label class="label" style="margin-bottom: 8px; display: block;">
              Step 1: Select Archive
            </label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input
                ref={archiveInputRef}
                type="file"
                accept=".tar.gz,.tgz,.tar"
                onChange={handleArchiveChange}
                disabled={importing}
                style="flex: 1;"
              />
              {archiveFile && (
                <span style="font-size: 12px; color: var(--success);">
                  ✓ {archiveFile.name}
                </span>
              )}
            </div>
            <p class="help-text" style="margin-top: 4px; font-size: 12px;">
              Select a .tar.gz or .tar file containing your password store
            </p>
          </div>

          {/* Step 2: Import Private Key */}
          <div style="margin-bottom: 20px;">
            <label class="label" style="margin-bottom: 8px; display: block;">
              Step 2: Import Private Key
            </label>
            <p class="help-text" style="margin-bottom: 8px; font-size: 12px; color: var(--text-muted);">
              Supports both armored (.asc, .key) and binary (.gpg, .pgp) formats
            </p>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input
                ref={keyInputRef}
                type="file"
                accept=".asc,.pgp,.key,.gpg"
                onChange={handleKeyChange}
                disabled={importing}
                style="flex: 1;"
              />
              {keyFile && (
                <span style="font-size: 12px; color: var(--success);">
                  ✓ {keyFile.name}
                </span>
              )}
            </div>
          </div>

          {/* Step 3: Enter Passphrase */}
          <div style="margin-bottom: 24px;">
            <label class="label" style="margin-bottom: 8px; display: block;">
              Step 3: Enter Passphrase
            </label>
            <p class="help-text" style="margin-bottom: 8px; font-size: 12px; color: var(--text-muted);">
              For the private key above
            </p>
            <input
              type="password"
              value={passphrase}
              onInput={(e) => setPassphrase((e.target as HTMLInputElement).value)}
              placeholder="Enter private key passphrase"
              disabled={importing}
              class="input"
              style="width: 100%;"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isFormValid) {
                  handleImport();
                }
              }}
            />
          </div>

          {/* Actions */}
          <div style="display: flex; justify-content: flex-end; gap: 12px; border-top: 1px solid var(--border); padding-top: 16px;">
            <button
              class="btn btn-ghost"
              onClick={onClose}
              disabled={importing}
            >
              Cancel
            </button>
            <button
              class="btn btn-primary"
              onClick={handleImport}
              disabled={!isFormValid}
            >
              {importing ? (
                <>
                  <span class="spinner" style="margin-right: 8px;" />
                  Importing...
                </>
              ) : (
                <>
                  📥 Import
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
