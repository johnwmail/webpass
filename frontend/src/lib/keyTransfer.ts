import { getPrivateKeyInfo } from './crypto';

/**
 * Client-encrypted PGP key transfer envelope.
 *
 * The private key is already protected by the PGP passphrase; this module adds
 * an outer layer keyed by a pairing code that the user types on both devices.
 * Neither the pairing code nor the PGP passphrase is ever sent to the server.
 */
export interface KeyTransferEnvelope {
  version: 1;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
  fingerprint: string;
}

export const KEY_TRANSFER_VERSION = 1;
export const KEY_TRANSFER_KDF = 'pbkdf2-sha256';
export const KEY_TRANSFER_ITERATIONS = 600000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function additionalData(fingerprint: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`webpass-key-transfer-v1:${fingerprint}`);
}

async function deriveKey(
  pairingCode: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pairingCode),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt the armored, passphrase-protected private key with the pairing code. */
export async function encryptKeyTransfer(
  privateKeyArmored: string,
  pairingCode: string,
  fingerprint: string
): Promise<KeyTransferEnvelope> {
  if (!pairingCode) throw new Error('Pairing code is required');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveKey(pairingCode, salt, KEY_TRANSFER_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: additionalData(fingerprint) },
    key,
    new TextEncoder().encode(privateKeyArmored)
  );
  return {
    version: KEY_TRANSFER_VERSION,
    kdf: KEY_TRANSFER_KDF,
    iterations: KEY_TRANSFER_ITERATIONS,
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    fingerprint,
  };
}

/** Decrypt the envelope and verify that the key belongs to the expected account. */
export async function decryptKeyTransfer(
  envelope: KeyTransferEnvelope,
  pairingCode: string,
  fingerprint: string
): Promise<string> {
  if (envelope.version !== KEY_TRANSFER_VERSION) {
    throw new Error('Unsupported transfer envelope version');
  }
  if (envelope.kdf !== KEY_TRANSFER_KDF) {
    throw new Error('Unsupported transfer encryption');
  }
  if (envelope.iterations < KEY_TRANSFER_ITERATIONS) {
    throw new Error('Transfer encryption parameters are too weak');
  }
  if (envelope.fingerprint !== fingerprint) {
    throw new Error('Transfer does not belong to this account');
  }

  const salt = fromBase64(envelope.salt);
  const nonce = fromBase64(envelope.nonce);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES || ciphertext.length === 0) {
    throw new Error('Invalid transfer envelope');
  }

  const key = await deriveKey(pairingCode, salt, envelope.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: additionalData(fingerprint) },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  const armoredPrivateKey = new TextDecoder().decode(plaintext);

  const info = await getPrivateKeyInfo(armoredPrivateKey);
  if (info.fingerprint !== fingerprint) {
    throw new Error('Restored key does not match this account');
  }
  return armoredPrivateKey;
}

/** Public key + fingerprint for an imported private key (no decryption). */
export async function inspectPrivateKey(
  armoredPrivateKey: string
): Promise<{ fingerprint: string; publicKey: string }> {
  return getPrivateKeyInfo(armoredPrivateKey);
}
