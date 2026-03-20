import { useState, useEffect, useRef } from 'preact/hooks';
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

  // Reset password auto-hide timer and countdown
  const resetPasswordTimer = () => {
    if (passwordHideTimerRef.current) {
      window.clearTimeout(passwordHideTimerRef.current);
    }
    if (passwordCountdownRef.current) {
      window.clearInterval(passwordCountdownRef.current);
    }
    
    setPasswordTimeRemaining(AUTO_HIDE_SECONDS);
    
    // Countdown timer - decrements every second
    passwordCountdownRef.current = window.setInterval(() => {
      setPasswordTimeRemaining(prev => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    // Auto-hide after 15 seconds
    passwordHideTimerRef.current = window.setTimeout(() => {
      setShowPassword(false);
      setPasswordTimeRemaining(0);
      setAutoHidden(true);
      setTimeout(() => setAutoHidden(false), 3000);
    }, AUTO_HIDE_SECONDS * 1000);
  };

  // Reset notes auto-hide timer and countdown
  const resetNotesTimer = () => {
    if (notesHideTimerRef.current) {
      window.clearTimeout(notesHideTimerRef.current);
    }
    if (notesCountdownRef.current) {
      window.clearInterval(notesCountdownRef.current);
    }
    
    setNotesTimeRemaining(AUTO_HIDE_SECONDS);
    
    // Countdown timer - decrements every second
    notesCountdownRef.current = window.setInterval(() => {
      setNotesTimeRemaining(prev => {
        if (prev <= 1) {
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    
    // Auto-hide after 15 seconds
    notesHideTimerRef.current = window.setTimeout(() => {
      setShowNotes(false);
      setNotesTimeRemaining(0);
      setAutoHidden(true);
      setTimeout(() => setAutoHidden(false), 3000);
    }, AUTO_HIDE_SECONDS * 1000);
  };

  // Password timer effect
  useEffect(() => {
    if (!content) return;
    
    if (passwordHideTimerRef.current) {
      window.clearTimeout(passwordHideTimerRef.current);
    }
    if (passwordCountdownRef.current) {
      window.clearInterval(passwordCountdownRef.current);
    }
    
    if (showPassword) {
      resetPasswordTimer();
    } else {
      setPasswordTimeRemaining(0);
    }

    return () => {
      if (passwordHideTimerRef.current) {
        window.clearTimeout(passwordHideTimerRef.current);
      }
      if (passwordCountdownRef.current) {
        window.clearInterval(passwordCountdownRef.current);
      }
    };
  }, [content, showPassword]);

  // Notes timer effect
  useEffect(() => {
    if (!content) return;
    
    if (notesHideTimerRef.current) {
      window.clearTimeout(notesHideTimerRef.current);
    }
    if (notesCountdownRef.current) {
      window.clearInterval(notesCountdownRef.current);
    }
    
    if (showNotes) {
      resetNotesTimer();
    } else {
      setNotesTimeRemaining(0);
    }

    return () => {
      if (notesHideTimerRef.current) {
        window.clearTimeout(notesHideTimerRef.current);
      }
      if (notesCountdownRef.current) {
        window.clearInterval(notesCountdownRef.current);
      }
    };
  }, [content, showNotes]);

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
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? 'Hide' : 'Show'}
                  style={{ minWidth: 'auto', padding: '4px 8px' }}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  {showPassword && <span style={{ fontSize: '11px', marginLeft: '4px' }}>{passwordTimeRemaining}s</span>}
                </button>
                <button
                  class="btn btn-ghost btn-icon btn-sm"
                  onClick={copyPassword}
                  title="Copy password"
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
                    onClick={() => setShowNotes(!showNotes)}
                    title={showNotes ? 'Hide' : 'Show'}
                    style={{ minWidth: 'auto', padding: '4px 8px' }}
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
