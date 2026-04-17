import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey, decryptBinary, WrongKeyError } from '../lib/crypto';
import { PassphrasePrompt } from './PassphrasePrompt';
import { ReencryptDialog } from './ReencryptDialog';
import { OTPDisplay } from './OTPDisplay';
import type { EntryContent } from '../types';
import { Lock, Eye, EyeOff, Copy, Check, Edit2, Trash2 } from 'lucide-preact';

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
  const [showNotes, setShowNotes] = useState(false);
  const [showPassphrasePrompt, setShowPassphrasePrompt] = useState(false);
  const [showReencryptDialog, setShowReencryptDialog] = useState(false);
  const [decrypting, setDecrypting] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [autoHidden, setAutoHidden] = useState(false);
  const [passwordTimeRemaining, setPasswordTimeRemaining] = useState<number>(0);
  const [notesTimeRemaining, setNotesTimeRemaining] = useState<number>(0);

  const passwordHideTimerRef = useRef<number | null>(null);
  const passwordCountdownRef = useRef<number | null>(null);
  const notesHideTimerRef = useRef<number | null>(null);
  const notesCountdownRef = useRef<number | null>(null);

  const AUTO_HIDE_SECONDS = 15;

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
      if (e instanceof WrongKeyError) {
        // Entry was encrypted with different key - show re-encrypt dialog
        setShowReencryptDialog(true);
      } else {
        setError(e.message || 'Decryption failed');
      }
    }
    setDecrypting(false);
  };

  const copyPassword = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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

  const handlePasswordToggle = useCallback(() => {
    setShowPassword(prev => {
      const newValue = !prev;
      // Clear any existing timers when manually toggling
      if (passwordHideTimerRef.current) {
        window.clearTimeout(passwordHideTimerRef.current);
        passwordHideTimerRef.current = null;
      }
      if (passwordCountdownRef.current) {
        window.clearInterval(passwordCountdownRef.current);
        passwordCountdownRef.current = null;
      }
      // Start new timer if showing
      if (newValue) {
        setPasswordTimeRemaining(AUTO_HIDE_SECONDS);
        passwordCountdownRef.current = window.setInterval(() => {
          setPasswordTimeRemaining(prevTime => {
            if (prevTime <= 1) {
              return 0;
            }
            return prevTime - 1;
          });
        }, 1000);
        passwordHideTimerRef.current = window.setTimeout(() => {
          setShowPassword(false);
          setPasswordTimeRemaining(0);
          setAutoHidden(true);
          setTimeout(() => setAutoHidden(false), 3000);
        }, AUTO_HIDE_SECONDS * 1000);
      } else {
        setPasswordTimeRemaining(0);
      }
      return newValue;
    });
  }, []);

  const handleNotesToggle = useCallback(() => {
    setShowNotes(prev => {
      const newValue = !prev;
      // Clear any existing timers when manually toggling
      if (notesHideTimerRef.current) {
        window.clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
      if (notesCountdownRef.current) {
        window.clearInterval(notesCountdownRef.current);
        notesCountdownRef.current = null;
      }
      // Start new timer if showing
      if (newValue) {
        setNotesTimeRemaining(AUTO_HIDE_SECONDS);
        notesCountdownRef.current = window.setInterval(() => {
          setNotesTimeRemaining(prevTime => {
            if (prevTime <= 1) {
              return 0;
            }
            return prevTime - 1;
          });
        }, 1000);
        notesHideTimerRef.current = window.setTimeout(() => {
          setShowNotes(false);
          setNotesTimeRemaining(0);
          setAutoHidden(true);
          setTimeout(() => setAutoHidden(false), 3000);
        }, AUTO_HIDE_SECONDS * 1000);
      } else {
        setNotesTimeRemaining(0);
      }
      return newValue;
    });
  }, []);

  // Password timer effect - simplified to just handle auto-hide trigger
  useEffect(() => {
    if (!content) return;

    // Timer is now managed by handlePasswordToggle
    // This effect just cleans up on unmount
    return () => {
      if (passwordHideTimerRef.current) {
        window.clearTimeout(passwordHideTimerRef.current);
        passwordHideTimerRef.current = null;
      }
      if (passwordCountdownRef.current) {
        window.clearInterval(passwordCountdownRef.current);
        passwordCountdownRef.current = null;
      }
    };
  }, [content]);

  // Notes timer effect - simplified to just handle auto-hide trigger
  useEffect(() => {
    if (!content) return;

    // Timer is now managed by handleNotesToggle
    // This effect just cleans up on unmount
    return () => {
      if (notesHideTimerRef.current) {
        window.clearTimeout(notesHideTimerRef.current);
        notesHideTimerRef.current = null;
      }
      if (notesCountdownRef.current) {
        window.clearInterval(notesCountdownRef.current);
        notesCountdownRef.current = null;
      }
    };
  }, [content]);

  return (
    <div class="entry-detail">
      {showPassphrasePrompt && (
        <PassphrasePrompt
          message="Decrypt this entry to view its contents."
          onSubmit={handleDecrypt}
          onCancel={() => setShowPassphrasePrompt(false)}
        />
      )}

      {showReencryptDialog && (
        <ReencryptDialog
          entryPath={path}
          onReencryptComplete={() => {
            setShowReencryptDialog(false);
            // Clear state and trigger re-decrypt with current key
            setContent(null);
            setRawContent('');
            setError('');
            // Show passphrase prompt to decrypt with current key
            setShowPassphrasePrompt(true);
          }}
          onCancel={() => {
            setShowReencryptDialog(false);
            setError('Entry encrypted with different key. Cannot decrypt.');
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

      {!content && !decrypting ? (
        <div class="decrypt-prompt">
          <div style={{ marginBottom: '16px', opacity: 0.5 }}>
            <Lock size={56} />
          </div>
          <p style={{ fontSize: '14px', marginBottom: '16px' }}>This entry is encrypted.</p>
          <button
            class="btn btn-primary"
            onClick={() => setShowPassphrasePrompt(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><rect x="3" y="11" width="18" height="11" rx="2" /><circle cx="12" cy="16" r="1" /><path d="M7 11V7a5 5 0 0110 0v4" /></svg>
            Decrypt
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
                  onClick={handlePasswordToggle}
                  title={showPassword ? 'Hide' : 'Show'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  style={{ minWidth: 'auto', padding: '4px 8px' }}
                  data-testid="password-toggle-btn"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  {showPassword && <span style={{ fontSize: '11px', marginLeft: '4px' }}>{passwordTimeRemaining}s</span>}
                </button>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={copyPassword}
                  title="Copy password"
                  data-testid="password-copy-btn"
                >
                  {copied ? <Check size={16} style={{ color: 'var(--success)' }} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
          </div>

          {content.notes && (
            <div class="entry-field">
              <div class="entry-field-label">Notes</div>
              <div class="password-display">
                <span class="value" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {showNotes ? content.notes : '•'.repeat(Math.min(content.notes.length, 48))}
                </span>
                <div class="actions">
                  <button
                    class="btn btn-ghost btn-icon btn-sm"
                    onClick={handleNotesToggle}
                    title={showNotes ? 'Hide' : 'Show'}
                    aria-label={showNotes ? 'Hide notes' : 'Show notes'}
                    style={{ minWidth: 'auto', padding: '4px 8px' }}
                    data-testid="notes-toggle-btn"
                  >
                    {showNotes ? <EyeOff size={16} /> : <Eye size={16} />}
                    {showNotes && <span style={{ fontSize: '11px', marginLeft: '4px' }}>{notesTimeRemaining}s</span>}
                  </button>
                </div>
              </div>
            </div>
          )}

          <OTPDisplay content={rawContent} />

          <div class="entry-actions">
            <button class="btn btn-sm" onClick={onEdit}>
              <Edit2 size={14} style={{ marginRight: '6px' }} /> Edit
            </button>
            <button
              class={`btn btn-sm ${confirmDelete ? 'btn-danger' : ''}`}
              onClick={handleDelete}
            >
              {confirmDelete ? 'Confirm Delete' : (
                <><Trash2 size={14} style={{ marginRight: '6px' }} /> Delete</>
              )}
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
      {autoHidden && <div class="toast">Content hidden for security</div>}
    </div>
  );
}
