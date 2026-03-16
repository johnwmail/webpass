import { useState } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey, decryptBinary } from '../lib/crypto';
import { PassphrasePrompt } from './PassphrasePrompt';
import { OTPDisplay } from './OTPDisplay';
import type { EntryContent } from '../types';

interface Props {
  path: string;
  onEdit: () => void;
  onDelete: () => void;
}

function parseEntryContent(text: string): EntryContent {
  const lines = text.split('\n');
  const password = lines[0] || '';
  const notes = lines.slice(1).join('\n').trim();
  return { password, notes };
}

export function EntryDetail({ path, onEdit, onDelete }: Props) {
  const [content, setContent] = useState<EntryContent | null>(null);
  const [rawContent, setRawContent] = useState<string>('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const pathParts = path.split('/');
  const name = pathParts[pathParts.length - 1];
  const prefix = pathParts.slice(0, -1).join('/');

  const handleDecrypt = async (passphrase: string) => {
    setShowPassphrasePrompt(false);
    setDecrypting(true);
    setError('');
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      const privateKey = await decryptPrivateKey(account.privateKey, passphrase);
      const encrypted = await session.api.getEntry(path);
      const decrypted = await decryptBinary(encrypted, privateKey);
      setRawContent(decrypted);
      setContent(parseEntryContent(decrypted));
    } catch (e: any) {
      setError(e.message || 'Decryption failed');
    }
    setDecrypting(false);
  };

  const copyPassword = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      // Auto-clear after 45s
      setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, 45000);
    } catch {
      // ignore
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await session.api?.deleteEntry(path);
      onDelete();
    } catch (e: any) {
      setError(e.message || 'Delete failed');
    }
  };

  return (
    <div class="entry-detail">
      {showPassphrasePrompt && (
        <PassphrasePrompt
          message="Decrypt this entry to view its contents."
          onSubmit={handleDecrypt}
          onCancel={() => setShowPassphrasePrompt(false)}
        />
      )}

      <div class="entry-detail-header">
        <h2>
          {prefix && <span class="path-prefix">{prefix} / </span>}
          {name}
        </h2>
        <button class="btn btn-sm" onClick={onEdit}>✏️ Edit</button>
      </div>

      {!content && !decrypting ? (
        <div class="decrypt-prompt">
          <span class="icon">🔒</span>
          <p>This entry is encrypted.</p>
          <button
            class="btn btn-primary"
            onClick={() => setShowPassphrasePrompt(true)}
          >
            🔓 Decrypt
          </button>
          {error && <p class="error-msg">{error}</p>}
        </div>
      ) : decrypting ? (
        <div class="loading">
          <span class="spinner" /> Decrypting...
        </div>
      ) : content ? (
        <>
          <div class="entry-field">
            <div class="entry-field-label">Password</div>
            <div class="password-display">
              <span class="value" style={{ fontFamily: 'var(--font-mono)' }}>
                {showPassword ? content.password : '•'.repeat(Math.min(content.password.length, 24))}
              </span>
              <div class="actions">
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? 'Hide' : 'Show'}
                >
                  {showPassword ? '🙈' : '👁️'}
                </button>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={copyPassword}
                  title="Copy password"
                >
                  {copied ? '✓' : '📋'}
                </button>
              </div>
            </div>
          </div>

          {content.notes && (
            <div class="entry-field">
              <div class="entry-field-label">Notes</div>
              <div class="notes-display">{content.notes}</div>
            </div>
          )}

          <OTPDisplay content={rawContent} />

          <div class="entry-actions">
            <button class="btn btn-sm" onClick={onEdit}>✏️ Edit</button>
            <button
              class={`btn btn-sm ${confirmDelete ? 'btn-danger' : ''}`}
              onClick={handleDelete}
            >
              {confirmDelete ? 'Confirm Delete' : '🗑️ Delete'}
            </button>
            {confirmDelete && (
              <button class="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            )}
          </div>
          {error && <p class="error-msg">{error}</p>}
        </>
      ) : null}

      {copied && <div class="toast">Password copied — auto-clears in 45s</div>}
    </div>
  );
}
