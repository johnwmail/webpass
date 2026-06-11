import { useState } from 'preact/hooks';
import { session } from '../lib/session';

interface Props {
  onImportClick: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}

export function DataManagement({ onImportClick, onSuccess, onError }: Props) {
  const [exporting, setExporting] = useState(false);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAll = async () => {
    setExporting(true);
    onError('');
    try {
      if (!session.api) throw new Error('Not logged in');
      const blob = await session.api.exportAll();
      downloadBlob(blob, 'password-store.tar.gz');
      onSuccess('Export complete');
    } catch (e: any) {
      onError(e.message || 'Export failed');
    }
    setExporting(false);
  };

  return (
    <div class="settings-section">
      <h3>Data</h3>
      <div class="settings-buttons">
        <button class="btn btn-sm" onClick={exportAll} disabled={exporting}>
          {exporting ? <>📦 Exporting...</> : '📦 Export All (.tar.gz)'}
        </button>
        <button class="btn btn-sm" onClick={onImportClick} disabled={!session.api} title={!session.api ? 'Please log in first' : ''}>
          📥 Import .password-store
        </button>
      </div>
    </div>
  );
}
