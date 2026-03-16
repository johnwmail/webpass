import { useState, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey, decryptBinary, encryptBinary } from '../lib/crypto';
import { PassphrasePrompt } from './PassphrasePrompt';
import { GeneratorModal } from './GeneratorModal';
import { Lock, Sparkles, Save, X } from 'lucide-preact';

interface Props {
  editPath: string | null;
  folderPrefix: string;
  onSave: () => void;
  onCancel: () => void;
}

export function EntryForm({ editPath, folderPrefix, onSave, onCancel }: Props) {
  const [folder, setFolder] = useState(folderPrefix);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [showGenerator, setShowGenerator] = useState(false);
  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsDecryptForEdit, setNeedsDecryptForEdit] = useState(!!editPath);

  useEffect(() => {
    if (editPath) {
      const parts = editPath.split('/');
      setName(parts[parts.length - 1]);
      setFolder(parts.slice(0, -1).join('/'));
      setNeedsDecryptForEdit(true);
    }
  }, [editPath]);

  const handleDecryptForEdit = async (passphrase: string) => {
    setShowPassphrasePrompt(false);
    setLoading(true);
    setError('');
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      const privateKey = await decryptPrivateKey(account.privateKey, passphrase);
      const encrypted = await session.api.getEntry(editPath!);
      const decrypted = await decryptBinary(encrypted, privateKey);
      const lines = decrypted.split('\n');
      setPassword(lines[0] || '');
      setNotes(lines.slice(1).join('\n').trim());
      setNeedsDecryptForEdit(false);
    } catch (e: any) {
      setError(e.message || 'Decryption failed');
    }
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      let content = password;
      if (notes.trim()) {
        content += '\n' + notes.trim();
      }
      content += '\n';

      const encrypted = await encryptBinary(content, account.publicKey);
      const fullPath = folder ? `${folder.replace(/\/+$/, '')}/${name}` : name;

      if (editPath && editPath !== fullPath) {
        await session.api.moveEntry(editPath, fullPath);
      }

      await session.api.putEntry(fullPath, encrypted);
      onSave();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    }
    setSaving(false);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Entry name is required');
      return;
    }
    if (needsDecryptForEdit) {
      setShowPassphrasePrompt(true);
    } else {
      handleSave();
    }
  };

  const isEditing = !!editPath;

  return (
    <div class="entry-form">
      {showPassphrasePrompt && (
        <PassphrasePrompt
          message="Enter passphrase to decrypt entry for editing."
          onSubmit={handleDecryptForEdit}
          onCancel={() => setShowPassphrasePrompt(false)}
        />
      )}

      {showGenerator && (
        <GeneratorModal
          onUse={(pw) => {
            setPassword(pw);
            setShowGenerator(false);
          }}
          onClose={() => setShowGenerator(false)}
        />
      )}

      <h2>{isEditing ? 'Edit Entry' : 'New Entry'}</h2>

      {isEditing && needsDecryptForEdit ? (
        <div class="decrypt-prompt">
          <div style={{ marginBottom: '16px', opacity: 0.5 }}>
            <Lock size={48} />
          </div>
          <p style={{ fontSize: '14px', marginBottom: '20px' }}>Decrypt entry to edit its contents.</p>
          <button
            class="btn btn-primary"
            onClick={() => setShowPassphrasePrompt(true)}
            disabled={loading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><rect x="3" y="11" width="18" height="11" rx="2" /><circle cx="12" cy="16" r="1" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
            {loading ? <>Decrypting...</> : 'Decrypt to Edit'}
          </button>
          {error && <p class="error-msg">{error}</p>}
          <button class="btn btn-ghost" style="margin-top: 16px;" onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <div class="field">
            <label class="label">Folder</label>
            <input
              class="input input-mono"
              type="text"
              value={folder}
              onInput={(e) => setFolder((e.target as HTMLInputElement).value)}
              placeholder="e.g. Email (optional)"
            />
          </div>

          <div class="field">
            <label class="label">Name</label>
            <input
              class="input"
              type="text"
              value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              placeholder="Entry name"
              required
            />
          </div>

          <div class="field">
            <label class="label">Password</label>
            <div class="input-group">
              <input
                class="input input-mono"
                type="text"
                value={password}
                onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
                placeholder="Password"
              />
              <button
                type="button"
                class="btn btn-sm"
                onClick={() => setShowGenerator(true)}
                title="Generate password"
              >
                <Sparkles size={16} />
              </button>
            </div>
          </div>

          <div class="field">
            <label class="label">Notes (optional)</label>
            <textarea
              class="textarea"
              rows={4}
              value={notes}
              onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
              placeholder="Additional notes, username, URLs..."
            />
          </div>

          {error && <p class="error-msg">{error}</p>}

          <div class="entry-form-actions">
            <button type="button" class="btn" onClick={onCancel}>
              <X size={16} style={{ marginRight: '6px' }} /> Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              disabled={!name.trim() || saving}
            >
              {saving ? (
                <><span class="spinner" /> Saving...</>
              ) : (
                <><Save size={16} style={{ marginRight: '6px' }} /> Save</>
              )}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
