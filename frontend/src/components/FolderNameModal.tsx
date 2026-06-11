import { useState, useEffect, useRef } from 'preact/hooks';
import { FolderPlus, X } from 'lucide-preact';

interface Props {
  onCancel: () => void;
  onConfirm: (name: string) => void;
  defaultName?: string;
}

export function FolderNameModal({ onCancel, onConfirm, defaultName = '' }: Props) {
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Folder name cannot be empty');
      return;
    }
    if (trimmed.includes('/')) {
      setError('Folder name cannot contain "/"');
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div class="modal-overlay" onClick={onCancel}>
      <div class="modal" style="max-width: 420px;" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2><FolderPlus size={18} style="margin-right: 8px; vertical-align: -2px;" /> New Folder</h2>
          <button class="btn btn-ghost btn-icon" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label class="label">Folder Name</label>
            <input
              ref={inputRef}
              class="input"
              type="text"
              value={name}
              onInput={(e) => { setName((e.target as HTMLInputElement).value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="e.g. Work, Personal, Finance"
              autofocus
            />
          </div>
          {error && <p class="error-msg">{error}</p>}
        </div>
        <div class="modal-footer" style="display: flex; justify-content: flex-end; gap: 12px;">
          <button class="btn" onClick={onCancel}>Cancel</button>
          <button class="btn btn-primary" onClick={handleSubmit} disabled={!name.trim()}>
            Create Folder
          </button>
        </div>
      </div>
    </div>
  );
}
