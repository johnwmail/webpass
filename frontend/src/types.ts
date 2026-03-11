// Stored in IndexedDB per fingerprint
export interface Account {
  fingerprint: string;
  privateKey: string;       // PGP armored (encrypted with PGP passphrase natively)
  publicKey: string;        // PGP armored public key
  apiUrlEncrypted: string;  // AES-GCM encrypted
  apiUrlSalt: string;       // base64
  apiUrlIv: string;         // base64
  label?: string;           // optional friendly name
}

// Entry metadata from API
export interface EntryMeta {
  path: string;
  created?: string;
  updated?: string;
}

// Tree node for folder view
export interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
}

// Decrypted entry content
export interface EntryContent {
  password: string;
  notes: string;
}

// Session state
export interface SessionState {
  fingerprint: string | null;
  token: string | null;
  expiresAt: number | null;
  apiUrl: string | null;
  publicKey: string | null;
}
