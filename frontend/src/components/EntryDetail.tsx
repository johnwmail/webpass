import { useState, useCallback } from 'preact/hooks';
import { useEntry } from '../hooks/useEntry';
import { PassphrasePrompt } from './PassphrasePrompt';
import { ReencryptDialog } from './ReencryptDialog';
import { OTPDisplay } from './OTPDisplay';
import { session } from '../lib/session';
import { Lock, Eye, EyeOff, Copy, Check, Edit2, Trash2 } from 'lucide-preact';
import { useAutoHide } from '../hooks/useAutoHide';

interface Props {
  path: string;
  onEdit: () => void;
  onDelete: () => void;
}

export function EntryDetail({ path, onEdit, onDelete }: Props) {
  const {
    state,
    handleDecrypt,
    handleReencryptComplete,
    copyPassword,
    handleDelete,
    cancelDelete,
  } = useEntry(path, onEdit, onDelete);

  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  
  const passwordVisibility = useAutoHide(15);
  const notesVisibility = useAutoHide(15);

  const handleDecryptClick = useCallback(() => {
    if (session.getCachedPrivateKey()) {
      handleDecrypt('');
    } else {
      setShowPassphrasePrompt(true);
    }
  }, [handleDecrypt]);

  const handlePassphraseSubmit = useCallback(async (passphrase: string) => {
    setShowPassphrasePrompt(false);
    await handleDecrypt(passphrase);
  }, [handleDecrypt]);

  const pathParts = path.split('/');
  const name = pathParts[pathParts.length - 1];
  const prefix = pathParts.slice(0, -1).join('/');

  return (
    <div class="entry-detail">
      {showPassphrasePrompt && (
        <PassphrasePrompt
          message="Decrypt this entry to view its contents."
          onSubmit={handlePassphraseSubmit}
          onCancel={() => setShowPassphrasePrompt(false)}
        />
      )}

      {state.needsReencrypt && (
        <ReencryptDialog
          entryPath={path}
          onReencryptComplete={handleReencryptComplete}
          onCancel={() => {
            setShowPassphrasePrompt(false);
          }}
        />
      )}

      <div class="entry-detail-header">
        <h2>
          {prefix && <span class="path-prefix">{prefix} / </span>}
          {name}
        </h2>
        <button class="btn btn-sm" onClick={onEdit}>
          <Edit2 size={14} style={{ marginRight: '6px' }} /> Edit
        </button>
      </div>

      {!state.content && !state.decrypting ? (
        <div class="decrypt-prompt">
          <div style={{ marginBottom: '16px', opacity: 0.5 }}>
            <Lock size={56} />
          </div>
          <p style={{ fontSize: '14px', marginBottom: '16px' }}>This entry is encrypted.</p>
          <button
            class="btn btn-primary"
            onClick={handleDecryptClick}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <circle cx="12" cy="16" r="1" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            Decrypt
          </button>
          {state.error && <p class="error-msg">{state.error}</p>}
        </div>
      ) : state.decrypting ? (
        <div class="loading">
          <span class="spinner" /> Decrypting...
        </div>
      ) : state.content ? (
        <>
          <div class="entry-field">
            <div class="entry-field-label">Password</div>
            <div class="password-display">
              <span class="value" style={{ fontFamily: 'var(--font-mono)' }}>
                {passwordVisibility.isVisible
                  ? state.content.password
                  : '•'.repeat(Math.min(state.content.password.length, 24))}
              </span>
              <div class="actions">
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={passwordVisibility.toggle}
                  title={passwordVisibility.isVisible ? 'Hide' : 'Show'}
                  aria-label={passwordVisibility.isVisible ? 'Hide password' : 'Show password'}
                  style={{ minWidth: 'auto', padding: '4px 8px' }}
                  data-testid="password-toggle-btn"
                >
                  {passwordVisibility.isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                  {passwordVisibility.isVisible && (
                    <span style={{ fontSize: '11px', marginLeft: '4px' }}>
                      {passwordVisibility.timeRemaining}s
                    </span>
                  )}
                </button>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={copyPassword}
                  title="Copy password"
                  data-testid="password-copy-btn"
                >
                  {state.copied ? <Check size={16} style={{ color: 'var(--success)' }} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          </div>

          {state.content.notes && (
            <div class="entry-field">
              <div class="entry-field-label">Notes</div>
              <div class="password-display">
                <span class="value" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {notesVisibility.isVisible
                    ? state.content.notes
                    : '•'.repeat(Math.min(state.content.notes.length, 48))}
                </span>
                <div class="actions">
                  <button
                    class="btn btn-ghost btn-icon btn-sm"
                    onClick={notesVisibility.toggle}
                    title={notesVisibility.isVisible ? 'Hide' : 'Show'}
                    aria-label={notesVisibility.isVisible ? 'Hide notes' : 'Show notes'}
                    style={{ minWidth: 'auto', padding: '4px 8px' }}
                    data-testid="notes-toggle-btn"
                  >
                    {notesVisibility.isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                    {notesVisibility.isVisible && (
                      <span style={{ fontSize: '11px', marginLeft: '4px' }}>
                        {notesVisibility.timeRemaining}s
                      </span>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          <OTPDisplay content={state.rawContent} />

          <div class="entry-actions">
            <button class="btn btn-sm" onClick={onEdit}>
              <Edit2 size={14} style={{ marginRight: '6px' }} /> Edit
            </button>
            <button
              class={`btn btn-sm ${state.confirmDelete ? 'btn-danger' : ''}`}
              onClick={handleDelete}
              disabled={state.deleteLoading}
            >
              {state.deleteLoading ? (
                <>
                  <span class="spinner" /> Deleting...
                </>
              ) : state.confirmDelete ? (
                'Confirm Delete'
              ) : (
                <>
                  <Trash2 size={14} style={{ marginRight: '6px' }} /> Delete
                </>
              )}
            </button>
            {state.confirmDelete && (
              <button class="btn btn-sm btn-ghost" onClick={cancelDelete} disabled={state.deleteLoading}>
                Cancel
              </button>
            )}
          </div>
          {state.error && <p class="error-msg">{state.error}</p>}
        </>
      ) : null}

      {state.copied && <div class="toast">Password copied — auto-clears in 45s</div>}
      {(passwordVisibility.autoHidden || notesVisibility.autoHidden) && (
        <div class="toast">Content hidden for security</div>
      )}
    </div>
  );
}
