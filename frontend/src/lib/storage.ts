import type { Account } from '../types';

const DB_NAME = 'webpass';
const DB_VERSION = 1;
const STORE_NAME = 'accounts';
const GIT_STORE_NAME = 'git_tokens';
const KEYS_STORE_NAME = 'keys';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION + 1);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
      }
      if (!db.objectStoreNames.contains(GIT_STORE_NAME)) {
        db.createObjectStore(GIT_STORE_NAME, { keyPath: 'fingerprint' });
      }
      if (!db.objectStoreNames.contains(KEYS_STORE_NAME)) {
        db.createObjectStore(KEYS_STORE_NAME, { keyPath: 'fingerprint' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAccount(account: Account): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(account);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAccount(fingerprint: string): Promise<Account | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(fingerprint);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listAccounts(): Promise<Account[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAccount(fingerprint: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(fingerprint);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Git token storage (encrypted with login password)
// GIT_STORE_NAME is already defined at the top of the file

export async function saveGitToken(
  fingerprint: string,
  encryptedToken: string,
  salt: string,
  iv: string
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GIT_STORE_NAME, 'readwrite');
    tx.objectStore(GIT_STORE_NAME).put({ fingerprint, encryptedToken, salt, iv });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getGitToken(fingerprint: string): Promise<{
  encryptedToken: string;
  salt: string;
  iv: string;
} | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GIT_STORE_NAME, 'readonly');
    const req = tx.objectStore(GIT_STORE_NAME).get(fingerprint);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteGitToken(fingerprint: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(GIT_STORE_NAME, 'readwrite');
    tx.objectStore(GIT_STORE_NAME).delete(fingerprint);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- AES-GCM encryption with PBKDF2 ---

const PBKDF2_ITERATIONS = 100000;

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function deriveAESKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function aesEncrypt(
  data: string,
  password: string
): Promise<{ encrypted: string; salt: string; iv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAESKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(data)
  );
  return {
    encrypted: bufToBase64(encrypted),
    salt: bufToBase64(salt.buffer as ArrayBuffer),
    iv: bufToBase64(iv.buffer as ArrayBuffer),
  };
}

export async function aesDecrypt(
  encrypted: string,
  password: string,
  salt: string,
  iv: string
): Promise<string> {
  const saltBuf = base64ToBuf(salt);
  const ivBuf = base64ToBuf(iv);
  const key = await deriveAESKey(password, new Uint8Array(saltBuf));
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    base64ToBuf(encrypted)
  );
  return new TextDecoder().decode(decrypted);
}

// --- PGP Key storage ---

export async function savePublicKey(fingerprint: string, publicKey: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYS_STORE_NAME, 'readwrite');
    tx.objectStore(KEYS_STORE_NAME).put({ fingerprint, publicKey });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPublicKey(fingerprint: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // Try KEYS_STORE first
    const tx1 = db.transaction(KEYS_STORE_NAME, 'readonly');
    const req1 = tx1.objectStore(KEYS_STORE_NAME).get(fingerprint);
    req1.onsuccess = () => {
      if (req1.result?.publicKey) {
        resolve(req1.result.publicKey);
        return;
      }
      
      // Fall back to ACCOUNTS_STORE
      const tx2 = db.transaction(STORE_NAME, 'readonly');
      const req2 = tx2.objectStore(STORE_NAME).get(fingerprint);
      req2.onsuccess = () => resolve(req2.result?.publicKey || null);
      req2.onerror = () => reject(req2.error);
    };
    req1.onerror = () => {
      // If KEYS_STORE doesn't exist or error, try ACCOUNTS_STORE
      const tx2 = db.transaction(STORE_NAME, 'readonly');
      const req2 = tx2.objectStore(STORE_NAME).get(fingerprint);
      req2.onsuccess = () => resolve(req2.result?.publicKey || null);
      req2.onerror = () => reject(req2.error);
    };
  });
}

export async function savePrivateKey(fingerprint: string, privateKey: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYS_STORE_NAME, 'readwrite');
    tx.objectStore(KEYS_STORE_NAME).put({ fingerprint, privateKey });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDecryptedPrivateKey(fingerprint: string, passphrase: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYS_STORE_NAME, 'readonly');
    const req = tx.objectStore(KEYS_STORE_NAME).get(fingerprint);
    req.onsuccess = () => resolve(req.result?.privateKey || null);
    req.onerror = () => reject(req.error);
  });
}
