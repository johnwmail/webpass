import { useState, useCallback, useEffect } from 'preact/hooks';
import { session } from '../lib/session';
import { getAccount } from '../lib/storage';
import { decryptPrivateKey, decryptBinary, encryptBinary, WrongKeyError } from '../lib/crypto';

export interface EntryFormState {
  folder: string;
  name: string;
  password: string;
  notes: string;
  saving: boolean;
  loading: boolean;
  error: string;
  needsDecrypt: boolean;
}

export function useEntryForm(
  editPath: string | null,
  folderPrefix: string,
  onSave: () => void,
  onCancel: () => void
) {
  const [state, setState] = useState<EntryFormState>({
    folder: folderPrefix,
    name: '',
    password: '',
    notes: '',
    saving: false,
    loading: false,
    error: '',
    needsDecrypt: !!editPath,
  });

  useEffect(() => {
    if (editPath) {
      const parts = editPath.split('/');
      setState(s => ({
        ...s,
        name: parts[parts.length - 1],
        folder: parts.slice(0, -1).join('/'),
      }));
    }
  }, [editPath]);

  const handleDecryptForEdit = useCallback(async (passphrase: string) => {
    if (!editPath) return;

    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      const privateKey = await decryptPrivateKey(account.privateKey, passphrase);
      const encrypted = await session.api.getEntry(editPath);
      const decrypted = await decryptBinary(encrypted, privateKey);
      const lines = decrypted.split('\n');

      setState(s => ({
        ...s,
        password: lines[0] || '',
        notes: lines.slice(1).join('\n').trim(),
        needsDecrypt: false,
      }));
    } catch (e: any) {
      if (e instanceof WrongKeyError) {
        setState(s => ({ ...s, needsReencrypt: true }));
      } else {
        setState(s => ({ ...s, error: e.message || 'Decryption failed' }));
      }
    }
    setState(s => ({ ...s, loading: false }));
  }, [editPath]);

  const handleSave = useCallback(async () => {
    setState(s => ({ ...s, saving: true, error: '' }));
    try {
      const fp = session.fingerprint;
      if (!fp || !session.api) throw new Error('Not logged in');
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');

      let content = state.password;
      if (state.notes.trim()) {
        content += '\n' + state.notes.trim();
      }
      content += '\n';

      const encrypted = await encryptBinary(content, account.publicKey);
      const fullPath = state.folder
        ? `${state.folder.replace(/\/+$/, '')}/${state.name}`
        : state.name;

      if (editPath && editPath !== fullPath) {
        await session.api.moveEntry(editPath, fullPath);
      }

      await session.api.putEntry(fullPath, encrypted);
      onSave();
    } catch (e: any) {
      setState(s => ({ ...s, error: e.message || 'Save failed' }));
    }
    setState(s => ({ ...s, saving: false }));
  }, [state.folder, state.name, state.password, state.notes, editPath, onSave]);

  const handleSubmit = useCallback((e: Event) => {
    e.preventDefault();
    if (!state.name.trim()) {
      setState(s => ({ ...s, error: 'Entry name is required' }));
      return;
    }
    if (state.needsDecrypt) {
      // Show passphrase prompt
    } else {
      handleSave();
    }
  }, [state.name, state.needsDecrypt, handleSave]);

  const setFolder = useCallback((folder: string) => {
    setState(s => ({ ...s, folder }));
  }, []);

  const setName = useCallback((name: string) => {
    setState(s => ({ ...s, name }));
  }, []);

  const setPassword = useCallback((password: string) => {
    setState(s => ({ ...s, password }));
  }, []);

  const setNotes = useCallback((notes: string) => {
    setState(s => ({ ...s, notes }));
  }, []);

  return {
    state,
    handleDecryptForEdit,
    handleSave,
    handleSubmit,
    setFolder,
    setName,
    setPassword,
    setNotes,
  };
}
