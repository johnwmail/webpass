export interface EntryMeta {
  path: string;
  created?: string;
  updated?: string;
}

export interface EntryContent {
  password: string;
  notes: string;
}

export interface SessionInfo {
  serverUrl: string;
  fingerprint: string;
  token: string;
}

// Messages from popup/content to background
export interface BgRequest {
  type: "LOGIN" | "LOGOUT" | "GET_STATUS" | "LIST_ENTRIES" | "GET_ENTRY"
       | "FILL_ON_TAB" | "CHECK_FILL" | "COPY_CLIPBOARD";
  serverUrl?: string;
  fingerprint?: string;
  password?: string;
  path?: string;
  passphrase?: string;
  hostname?: string;
  tabId?: number;
  text?: string;
}

export interface BgResponse {
  success?: boolean;
  error?: string;
  loggedIn?: boolean;
  entries?: EntryMeta[];
  encryptedBlob?: string; // base64
  plaintext?: string;
}

// State stored in chrome.storage.local
export interface StoredState {
  serverUrl?: string;
  fingerprint?: string;
  token?: string;
  privateKeyArmored?: string; // PGP-encrypted private key
}
