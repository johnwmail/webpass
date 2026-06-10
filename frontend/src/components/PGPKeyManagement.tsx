import { getAccount } from '../lib/storage';
import { session } from '../lib/session';

interface Props {
  fp: string;
}

export function PGPKeyManagement({ fp }: Props) {
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPublicKey = async () => {
    const account = await getAccount(fp);
    if (!account) return;
    const blob = new Blob([account.publicKey], { type: 'text/plain' });
    downloadBlob(blob, `webpass-public-${fp.slice(0, 8)}.asc`);
  };

  const exportPrivateKey = async () => {
    const account = await getAccount(fp);
    if (!account) return;
    const blob = new Blob([account.privateKey], { type: 'text/plain' });
    downloadBlob(blob, `webpass-private-${fp.slice(0, 8)}.asc`);
  };

  return (
    <div class="settings-section">
      <h3>PGP Key Management</h3>
      <div class="settings-buttons">
        <button class="btn btn-sm" onClick={exportPublicKey}> Export Public Key</button>
        <button class="btn btn-sm" onClick={exportPrivateKey}> Export Private Key (encrypted)</button>
      </div>
    </div>
  );
}
