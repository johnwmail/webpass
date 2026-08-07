import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey, decryptBinary, encryptBinary, WrongKeyError } from '../lib/crypto';
import { useClipboard } from './useClipboard';

export interface EntryState {
  content: { password: string; notes: string } | null;
  rawContent: string;
  decrypting: boolean;
  error: string;
  needsReencrypt: boolean;
  copied: boolean;
  confirmDelete: boolean;
  deleteLoading: boolean;
  autoHidden: boolean;
}

export function useEntry(path: string, onEdit: () => void, onDelete: () => void) {
  const [state, setState] = useState<EntryState>({
    content: null,
    rawContent: '',
    decrypting: false,
    error: '',
    needsReencrypt: false,
    copied: false,
    confirmDelete: false,
    deleteLoading: false,
    autoHidden: false,
  });

  const copyTimerRef = useRef<number | null>(null);

  const parseEntryContent = (text: string) => {
    const lines = text.split('\n');
    return {
      password: lines[0] || '',
      notes: lines.slice(1).join('\n').trim(),
    };
  };

  const handleDecrypt = useCallback(async (passphrase: string) => {
    setState(s => ({ ...s, decrypting: true, error: '', needsReencrypt: false }));
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');

      let privateKey = session.getCachedPrivateKey();
      if (!privateKey) {
        const account = await getAccount(fp);
        if (!account) throw new Error('Account not found');
        privateKey = await decryptPrivateKey(account.privateKey, passphrase);
        session.setCachedPrivateKey(privateKey);
      }

      const encrypted = await session.api.getEntry(path);
      const decrypted = await decryptBinary(encrypted, privateKey);
      
      setState(s => ({
        ...s,
        content: parseEntryContent(decrypted),
        rawContent: decrypted,
      }));
    } catch (e: any) {
      if (e instanceof WrongKeyError) {
        setState(s => ({ ...s, needsReencrypt: true }));
      } else {
        setState(s => ({ ...s, error: e.message || 'Decryption failed' }));
      }
    }
    setState(s => ({ ...s, decrypting: false }));
  }, [path]);

  const handleReencryptComplete = useCallback(() => {
    setState(s => ({
      ...s,
      needsReencrypt: false,
      content: null,
      rawContent: '',
      error: '',
    }));
  }, []);

  const { copied: clipboardCopied, copyToClipboard } = useClipboard({ clearAfterMs: 45000 });

  // Reset decrypted state when path changes or unmounts to clear memory
  useEffect(() => {
    setState({
      content: null,
      rawContent: '',
      decrypting: false,
      error: '',
      needsReencrypt: false,
      copied: false,
      confirmDelete: false,
      deleteLoading: false,
      autoHidden: false,
    });
  }, [path]);

  const copyPassword = useCallback(async () => {
    if (!state.content?.password) return;
    await copyToClipboard(state.content.password);
    setState(s => ({ ...s, copied: true }));
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      setState(s => ({ ...s, copied: false }));
    }, 2000);
  }, [state.content?.password, copyToClipboard]);

  const handleDelete = useCallback(async () => {
    if (!state.confirmDelete) {
      setState(s => ({ ...s, confirmDelete: true }));
      return;
    }

    setState(s => ({ ...s, deleteLoading: true, error: '' }));
    try {
      await session.api?.deleteEntry(path);
      onDelete();
    } catch (e: any) {
      setState(s => ({ ...s, error: e.message || 'Delete failed' }));
    }
    setState(s => ({ ...s, deleteLoading: false }));
  }, [path, state.confirmDelete, onDelete]);

  const cancelDelete = useCallback(() => {
    setState(s => ({ ...s, confirmDelete: false }));
  }, []);

  const showError = useCallback(() => {
    return state.error;
  }, [state.error]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  return {
    state,
    handleDecrypt,
    handleReencryptComplete,
    copyPassword,
    handleDelete,
    cancelDelete,
    showError,
  };
}
