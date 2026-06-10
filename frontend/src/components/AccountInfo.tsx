import { useState, useEffect } from 'preact/hooks';
import { getAccount, saveAccount } from '../lib/storage';
import { session } from '../lib/session';

interface Props {
  fp: string;
  apiUrl: string;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}

export function AccountInfo({ fp, apiUrl, onError, onSuccess }: Props) {
  const [accountLabel, setAccountLabel] = useState('');
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelLoading, setLabelLoading] = useState(false);
  const [labelError, setLabelError] = useState('');

  const formatFp = (f: string) => f.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

  useEffect(() => {
    const loadAccountLabel = async () => {
      const account = await getAccount(fp);
      if (account) {
        setAccountLabel(account.label || '');
      }
    };
    loadAccountLabel();
  }, [fp]);

  const handleSaveLabel = async () => {
    setLabelLoading(true);
    setLabelError('');
    try {
      const account = await getAccount(fp);
      if (!account) throw new Error('Account not found');
      await saveAccount({
        ...account,
        label: accountLabel.trim() || undefined,
      });
      onSuccess('Account name updated');
      setIsEditingLabel(false);
    } catch (e: any) {
      setLabelError(e.message || 'Failed to update account name');
    }
    setLabelLoading(false);
  };

  return (
    <div class="settings-section">
      <h3>Account</h3>
      <div class="settings-row">
        <span class="label-text">Account Name</span>
        {isEditingLabel ? (
          <div style="display: flex; gap: 8px; align-items: center;">
            <input
              class="input"
              type="text"
              value={accountLabel}
              onInput={(e) => setAccountLabel((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && accountLabel) handleSaveLabel();
                else if (e.key === 'Escape') {
                  setIsEditingLabel(false);
                  getAccount(fp).then(acc => setAccountLabel(acc?.label || ''));
                  setLabelError('');
                }
              }}
              placeholder="Enter account name"
              disabled={labelLoading}
              autofocus
              style="width: 200px;"
            />
            <button class="btn btn-primary btn-sm" onClick={handleSaveLabel} disabled={labelLoading || !accountLabel.trim()}>
              {labelLoading ? <span class="spinner" /> : '✓'}
            </button>
            <button class="btn btn-ghost btn-sm" onClick={() => { setIsEditingLabel(false); getAccount(fp).then(acc => setAccountLabel(acc?.label || '')); setLabelError(''); }} disabled={labelLoading}>✕</button>
          </div>
        ) : (
          <>
            <span class="value-text" title={accountLabel || 'Not set'} style="max-width: 200px;">{accountLabel || 'Not set'}</span>
            <button class="btn btn-ghost btn-sm" onClick={() => setIsEditingLabel(true)} disabled={labelLoading} title="Edit account name" aria-label="Edit account name">✎</button>
          </>
        )}
      </div>
      {labelError && <p class="error-msg" style="margin-top: 8px;">{labelError}</p>}
      <div class="settings-row">
        <span class="label-text">Fingerprint</span>
        <span class="value-text" title={fp}>{formatFp(fp)}</span>
      </div>
      <div class="settings-row">
        <span class="label-text">Key Type</span>
        <span class="value-text">ECC Curve25519</span>
      </div>
      <div class="settings-row">
        <span class="label-text">API Server</span>
        <span class="value-text" title={apiUrl}>{apiUrl}</span>
      </div>
    </div>
  );
}
