/** @jsx h */
/** @jsxFrag Fragment */
import { h, render, Fragment } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import type { BgRequest, BgResponse, EntryMeta } from '../shared/types.ts';

const we = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;
async function bg(req: BgRequest): Promise<BgResponse> {
  return we.runtime.sendMessage(req);
}

// ── OpenPGP (bundled by esbuild) ──────────────────────────────────────
let openpgpMod: typeof import('openpgp') | null = null;
async function getOpenPGP() {
  if (!openpgpMod) {
    openpgpMod = await import('openpgp');
  }
  return openpgpMod;
}

// ── Login View ────────────────────────────────────────────────────────
function LoginView({ onLogin }: { onLogin: () => void }) {
  const [serverUrl, setServerUrl] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    we.storage.local.get(['serverUrl', 'fingerprint']).then((state: any) => {
      if (state.serverUrl) setServerUrl(state.serverUrl);
      if (state.fingerprint) setFingerprint(state.fingerprint);
    });
  }, []);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!serverUrl || !fingerprint || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await bg({ type: 'LOGIN', serverUrl, fingerprint: fingerprint.trim(), password });
      if (res.success) onLogin();
      else setError(res.error || 'Login failed');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
    setLoading(false);
  };

  return (
    <div class="view">
      <div class="header">
        <span class="logo">🔒 WebPass</span>
        <div>
          <button class="btn-icon" onClick={openSettings} title="Settings" style="font-size:14px;">⚙️</button>
        </div>
      </div>
      <form onSubmit={handleSubmit} class="form">
        <div class="field">
          <label>Server URL</label>
          <input type="url" value={serverUrl} onInput={(e: any) => setServerUrl(e.target.value)}
            placeholder="https://webpass.example.com" autocomplete="url" />
        </div>
        <div class="field">
          <label>Fingerprint</label>
          <input type="text" value={fingerprint} onInput={(e: any) => setFingerprint(e.target.value.toUpperCase())}
            placeholder="ABCD1234..." autocomplete="username" />
        </div>
        <div class="field">
          <label>Login Password</label>
          <input type="password" value={password} onInput={(e: any) => setPassword(e.target.value)}
            placeholder="Enter password" autocomplete="current-password" />
        </div>
        {error && <p class="error">{error}</p>}
        <button type="submit" class="btn-primary" disabled={loading}>
          {loading ? 'Connecting...' : 'Login'}
        </button>
        <button type="button" class="btn-text" onClick={openSettings} style="margin-top:4px;">
          ⚙️ Configure PGP Key
        </button>
      </form>
    </div>
  );
}

function openSettings() {
  we.runtime.openOptionsPage().catch(() => {
    // Fallback - not supported
  });
}

// ── Vault View ────────────────────────────────────────────────────────
function VaultView({ onLogout }: { onLogout: () => void }) {
  const [entries, setEntries] = useState<EntryMeta[]>([]);
  const [filtered, setFiltered] = useState<EntryMeta[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<EntryMeta | null>(null);
  const [pgpPass, setPgpPass] = useState('');
  const [decrypted, setDecrypted] = useState<{ password: string; notes: string } | null>(null);
  const [decrypting, setDecrypting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showPgpInput, setShowPgpInput] = useState(false);
  const [hasKey, setHasKey] = useState(false);

  useEffect(() => {
    we.storage.local.get(['privateKeyArmored']).then((s: any) => {
      setHasKey(!!s.privateKeyArmored);
    });
    loadEntries();
  }, []);

  useEffect(() => {
    if (!search.trim()) { setFiltered(entries); return; }
    const q = search.toLowerCase();
    setFiltered(entries.filter(e => e.path.toLowerCase().includes(q)));
  }, [search, entries]);

  const loadEntries = async () => {
    setLoading(true); setError('');
    try {
      const res = await bg({ type: 'LIST_ENTRIES' });
      if (res.success && res.entries) setEntries(res.entries);
      else setError(res.error || 'Failed to load');
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleSelect = (e: EntryMeta) => {
    setSelected(e); setDecrypted(null); setPgpPass(''); setShowPgpInput(false);
  };

  const handleDecrypt = async () => {
    if (!selected || !pgpPass) return;
    setDecrypting(true); setError('');
    try {
      const blobRes = await bg({ type: 'GET_ENTRY', path: selected.path });
      if (!blobRes.success || !blobRes.encryptedBlob) throw new Error(blobRes.error || 'Fetch failed');

      const openpgp = await getOpenPGP();
      const raw = Uint8Array.from(atob(blobRes.encryptedBlob), c => c.charCodeAt(0));
      const state: any = await we.storage.local.get(['privateKeyArmored']);
      if (!state.privateKeyArmored) throw new Error('No PGP private key configured');

      const pk = await openpgp.readPrivateKey({ armoredKey: state.privateKeyArmored });
      const dpk = await openpgp.decryptKey({ privateKey: pk, passphrase: pgpPass });

      let msg;
      try { msg = await openpgp.readMessage({ binaryMessage: raw }); }
      catch { msg = await openpgp.readMessage({ armoredMessage: blobRes.encryptedBlob }); }

      const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: dpk });
      const content = JSON.parse(data as string);
      setDecrypted({ password: content.password || '', notes: content.notes || '' });
      setShowPgpInput(false);
    } catch (e: any) { setError(e.message || 'Decryption failed'); }
    setDecrypting(false);
  };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* fallback */ }
  };

  if (selected) {
    return (
      <div class="view">
        <div class="header">
          <button class="btn-icon" onClick={() => { setSelected(null); setDecrypted(null); }}>←</button>
          <span class="logo" style="font-size:13px;">🔒 WebPass</span>
          <button class="btn-icon" onClick={onLogout} title="Logout">⏻</button>
        </div>
        <div class="entry-detail">
          <div class="entry-path">{selected.path}</div>
          {!showPgpInput && !decrypted ? (
            <div style="padding:12px;text-align:center;">
              {!hasKey && <p class="error">No PGP key configured. Reinstall and add key first.</p>}
              <button class="btn-primary" onClick={() => setShowPgpInput(true)} disabled={!hasKey}>🔓 Decrypt</button>
            </div>
          ) : null}
          {showPgpInput && (
            <div class="passphrase-input">
              <input type="password" value={pgpPass} onInput={(e: any) => setPgpPass(e.target.value)}
                placeholder="PGP passphrase" onKeyDown={(e: any) => e.key === 'Enter' && handleDecrypt()} autofocus />
              <button class="btn-primary" onClick={handleDecrypt} disabled={decrypting || !pgpPass}>
                {decrypting ? '...' : '🔓'}
              </button>
            </div>
          )}
          {decrypting && <p style="text-align:center;color:var(--muted);padding:8px;">Decrypting...</p>}
          {decrypted && (
            <div class="entry-fields">
              <div class="field-row">
                <label>Password</label>
                <div class="value-row">
                  <span class="mono">{decrypted.password}</span>
                  <button class="btn-sm" onClick={() => copyText(decrypted.password)}>{copied ? '✓' : '📋'}</button>
                </div>
              </div>
              {decrypted.notes && (
                <div class="field-row">
                  <label>Notes</label>
                  <div class="value-row">
                    <span style="white-space:pre-wrap;word-break:break-word;font-size:12px;">{decrypted.notes}</span>
                    <button class="btn-sm" onClick={() => copyText(decrypted.notes)}>📋</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <p class="error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div class="view">
      <div class="header">
        <span class="logo">🔒 WebPass</span>
        <div style="display:flex;gap:2px;">
          <button class="btn-icon" onClick={openSettings} title="Settings" style="font-size:14px;">⚙️</button>
          <button class="btn-icon" onClick={onLogout} title="Logout">⏻</button>
        </div>
      </div>
      <div class="search-bar">
        <input type="text" value={search} onInput={(e: any) => setSearch(e.target.value)} placeholder="Search entries..." autofocus />
      </div>
      <div class="entry-list">
        {loading ? <p class="status-msg">Loading...</p>
        : error ? <div style="padding:12px;"><p class="error">{error}</p><button class="btn-sm" onClick={loadEntries}>Retry</button></div>
        : filtered.length === 0 ? <p class="status-msg">{search ? 'No matches' : 'No entries'}</p>
        : filtered.map(e => (
            <div class="entry-item" onClick={() => handleSelect(e)} key={e.path}>
              <span class="entry-name">🔑 {e.path}</span>
              {e.updated && <span class="entry-date">{e.updated.split('T')[0]}</span>}
            </div>
          ))}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────
function App() {
  const [view, setView] = useState<'login' | 'vault'>('login');

  useEffect(() => {
    bg({ type: 'GET_STATUS' }).then(r => { if (r.loggedIn) setView('vault'); });
  }, []);

  return view === 'login'
    ? <LoginView onLogin={() => setView('vault')} />
    : <VaultView onLogout={async () => { await bg({ type: 'LOGOUT' }); setView('login'); }} />;
}

const root = document.getElementById('root');
if (root) render(<App />, root);
