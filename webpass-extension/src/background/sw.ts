// WebPass Background Service Worker
// Handles session management, API proxying, and content script coordination

import type { BgRequest, BgResponse, EntryMeta, StoredState } from '../shared/types.ts';

// ── In-memory session state ──────────────────────────────────────────────
let serverUrl = '';
let fingerprint = '';
let token = '';
let privateKeyArmored = '';
let entriesCache: EntryMeta[] = [];
let loggedIn = false;

// ── Webextension polyfill ────────────────────────────────────────────────
const we = (typeof browser !== 'undefined' ? browser : chrome) as typeof chrome;

// ── API helpers ──────────────────────────────────────────────────────────

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = serverUrl.replace(/\/+$/, '') + path;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  // Don't set content-type for GET/HEAD, but do for others
  if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers, credentials: 'include' });
}

async function apiLogin(pwd: string): Promise<string> {
  const res = await apiFetch(`/api/${fingerprint}/login`, {
    method: 'POST',
    body: JSON.stringify({ password: pwd }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => 'Login failed');
    throw new Error(text || `Login failed (${res.status})`);
  }
  const data = await res.json();
  if (data.requires_2fa) {
    throw new Error('2FA is not supported in the extension yet');
  }
  return data.token;
}

async function apiGetEntries(): Promise<EntryMeta[]> {
  const res = await apiFetch(`/api/${fingerprint}/entries`);
  if (!res.ok) throw new Error(`List entries failed (${res.status})`);
  const data = await res.json();
  return data.entries || [];
}

async function apiGetEntry(path: string): Promise<Uint8Array> {
  const res = await apiFetch(`/api/${fingerprint}/entries/${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Get entry failed (${res.status})`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

// ── Message handler ──────────────────────────────────────────────────────

async function handleMessage(req: BgRequest): Promise<BgResponse> {
  switch (req.type) {
    case 'LOGIN': {
      try {
        if (!req.serverUrl || !req.fingerprint || !req.password) {
          return { success: false, error: 'Missing serverUrl, fingerprint, or password' };
        }
        serverUrl = req.serverUrl.replace(/\/+$/, '');
        fingerprint = req.fingerprint.toUpperCase();
        token = '';

        const jwt = await apiLogin(req.password);
        token = jwt;
        loggedIn = true;

        // Fetch entry list in background
        apiGetEntries().then(entries => { entriesCache = entries; }).catch(() => {});

        // Persist session metadata
        const state: StoredState = { serverUrl, fingerprint, token };
        await we.storage.local.set(state);

        return { success: true, loggedIn: true };
      } catch (e: any) {
        loggedIn = false;
        token = '';
        return { success: false, error: e.message };
      }
    }

    case 'LOGOUT': {
      try { await apiFetch('/api/logout', { method: 'POST' }); } catch {}
      loggedIn = false;
      token = '';
      serverUrl = '';
      fingerprint = '';
      entriesCache = [];
      privateKeyArmored = '';
      await we.storage.local.remove(['serverUrl', 'fingerprint', 'token']);
      return { success: true };
    }

    case 'GET_STATUS': {
      return {
        success: true,
        loggedIn,
        entries: entriesCache,
      };
    }

    case 'LIST_ENTRIES': {
      try {
        entriesCache = await apiGetEntries();
        return { success: true, entries: entriesCache };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    case 'GET_ENTRY': {
      try {
        if (!req.path) return { success: false, error: 'Missing path' };
        const blob = await apiGetEntry(req.path);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(blob)));
        return { success: true, encryptedBlob: base64 };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    case 'CHECK_FILL': {
      // Check if any cached entries match the hostname
      if (!loggedIn || entriesCache.length === 0) {
        return { success: true, entries: [] };
      }
      const host = req.hostname || '';
      const matching = entriesCache.filter(e => {
        const p = e.path.toLowerCase();
        return p.includes(host) || host.includes(p.split('/').pop() || '');
      });
      return { success: true, entries: matching };
    }

    case 'FILL_ON_TAB': {
      try {
        if (!req.path || !req.tabId) return { success: false, error: 'Missing path or tabId' };
        const blob = await apiGetEntry(req.path);
        const base64 = btoa(String.fromCharCode(...new Uint8Array(blob)));
        // Send to content script on the specified tab
        await we.tabs.sendMessage(req.tabId, {
          type: 'FILL_ENTRY',
          encryptedBlob: base64,
        });
        return { success: true };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    case 'COPY_CLIPBOARD': {
      try {
        if (!req.text) return { success: false, error: 'Missing text' };
        // Use the Clipboard API from an offscreen document or just return for popup to handle
        return { success: true, plaintext: req.text };
      } catch (e: any) {
        return { success: false, error: e.message };
      }
    }

    default:
      return { success: false, error: `Unknown message type: ${(req as any).type}` };
  }
}

// ── Message listener ─────────────────────────────────────────────────────

we.runtime.onMessage.addListener((req: BgRequest, _sender, sendResponse) => {
  handleMessage(req).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
  return true; // Keep channel open for async response
});

// ── Restore session on startup ───────────────────────────────────────────

async function restoreSession() {
  try {
    const state = await we.storage.local.get(['serverUrl', 'fingerprint', 'token']) as StoredState;
    if (state.serverUrl && state.fingerprint && state.token) {
      serverUrl = state.serverUrl;
      fingerprint = state.fingerprint;
      token = state.token;
      loggedIn = true;
      // Verify token is still valid by trying to list entries
      try {
        entriesCache = await apiGetEntries();
      } catch {
        // Token expired, require re-login
        loggedIn = false;
        token = '';
        await we.storage.local.remove(['token']);
      }
    }
  } catch {}
}

restoreSession();

// Connect to popup port for alive tracking (helps Chrome keep SW alive)
we.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    port.onDisconnect.addListener(() => {});
  }
});
