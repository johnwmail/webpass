import * as openpgp from 'openpgp';

/** Generate new ECC Curve25519 keypair with passphrase */
export async function generateKeyPair(passphrase: string): Promise<{
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}> {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',  // openpgp v6 renamed curve25519 to curve25519Legacy
    userIDs: [{ name: 'WebPass User' }],
    passphrase,
    format: 'armored',
  });

  const pubKeyObj = await openpgp.readKey({ armoredKey: publicKey });
  const fingerprint = pubKeyObj.getFingerprint().toUpperCase();

  return { publicKey, privateKey, fingerprint };
}

/** Read fingerprint from armored public key */
export async function getFingerprint(armoredPublicKey: string): Promise<string> {
  const key = await openpgp.readKey({ armoredKey: armoredPublicKey });
  return key.getFingerprint().toUpperCase();
}

/** Decrypt private key with passphrase */
export async function decryptPrivateKey(
  keyData: string | Uint8Array,
  passphrase: string
): Promise<openpgp.PrivateKey> {
  let privateKey: openpgp.PrivateKey;

  // Auto-detect format: armored text or binary
  if (typeof keyData === 'string') {
    privateKey = await openpgp.readPrivateKey({ armoredKey: keyData });
  } else if (keyData instanceof Uint8Array) {
    privateKey = await openpgp.readPrivateKey({ binaryKey: keyData });
  } else {
    throw new Error('Invalid key format: must be string (armored) or Uint8Array (binary)');
  }

  return openpgp.decryptKey({ privateKey, passphrase });
}

/**
 * Import and decrypt external private key from file
 *
 * SECURITY: The decrypted key is returned but should NEVER be persisted.
 * Caller must clear it from memory after use (set to null).
 *
 * @param keyData - PGP private key data (armored string or binary Uint8Array)
 * @param passphrase - Passphrase to decrypt the key
 * @returns Decrypted private key (MUST be cleared from memory after use)
 */
export async function importPrivateKey(
  keyData: string | Uint8Array,
  passphrase: string
): Promise<openpgp.PrivateKey> {
  let privateKey: openpgp.PrivateKey;

  // Auto-detect format: armored text or binary
  if (typeof keyData === 'string') {
    // Armored text format (-----BEGIN PGP PRIVATE KEY BLOCK-----)
    privateKey = await openpgp.readPrivateKey({ armoredKey: keyData });
  } else if (keyData instanceof Uint8Array) {
    // Binary format (OpenPGP binary packets)
    privateKey = await openpgp.readPrivateKey({ binaryKey: keyData });
  } else {
    throw new Error('Invalid key format: must be string (armored) or Uint8Array (binary)');
  }

  // Decrypt with passphrase
  const decryptedKey = await openpgp.decryptKey({ privateKey, passphrase });

  return decryptedKey;
}

/**
 * Clear sensitive data from memory
 * 
 * Note: JavaScript doesn't provide guaranteed memory clearing,
 * but this helps by nullifying references and suggesting GC.
 */
export function clearSensitiveData(...sensitiveVars: unknown[]): void {
  // Nullify all passed variables
  for (let i = 0; i < sensitiveVars.length; i++) {
    sensitiveVars[i] = null;
  }
  
  // Suggest garbage collection (if available in environment)
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
}

/** Encrypt text with public key → armored PGP message */
export async function encryptText(
  text: string,
  publicKeyArmored: string
): Promise<string> {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.createMessage({ text });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
    format: 'armored',
  });
  return encrypted as string;
}

/** Decrypt armored PGP message with decrypted private key */
export async function decryptMessage(
  encrypted: string | Uint8Array,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  if (typeof encrypted === 'string') {
    const message = await openpgp.readMessage({ armoredMessage: encrypted });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
    });
    return data as string;
  } else {
    const message = await openpgp.readMessage({ binaryMessage: encrypted });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
      format: 'utf8',
    });
    return data as string;
  }
}

/** Encrypt text with public key → Uint8Array (binary) */
export async function encryptBinary(
  text: string,
  publicKeyArmored: string
): Promise<Uint8Array> {
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.createMessage({ text });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
    format: 'binary',
  });
  return encrypted as Uint8Array;
}

/**
 * Error thrown when decryption fails due to wrong key
 * (entry was encrypted with a different PGP key)
 */
export class WrongKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongKeyError';
  }
}

/** Decrypt binary PGP message */
export async function decryptBinary(
  encrypted: Uint8Array,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  try {
    const message = await openpgp.readMessage({ binaryMessage: encrypted });
    const { data } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
    });
    return data as string;
  } catch (err: any) {
    // OpenPGP.js throws "Session key decryption failed" when the key doesn't match
    if (err.message?.includes('Session key decryption failed')) {
      throw new WrongKeyError(
        'This entry was encrypted with a different key. ' +
        'You need the original private key to decrypt it.'
      );
    }
    throw err;
  }
}

/** Encrypt text with a recipient's public key (for encrypt tool) */
export async function encryptForRecipient(
  text: string,
  recipientPublicKeyArmored: string
): Promise<string> {
  return encryptText(text, recipientPublicKeyArmored);
}

// ---------------------------------------------------------------------------
// PBKDF2 + AES-GCM helpers (not used for PAT - PAT uses PGP-only encryption)
// ---------------------------------------------------------------------------

/** Derive AES key from password using PBKDF2 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Generate random salt */
export function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

/** Encrypt data with AES-GCM */
export async function aesGcmEncrypt(
  data: string,
  key: CryptoKey
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const enc = new TextEncoder();
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    enc.encode(data)
  );

  return { ciphertext: new Uint8Array(ciphertext), iv };
}

/** Decrypt data with AES-GCM */
export async function aesGcmDecrypt(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  key: CryptoKey
): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );

  const dec = new TextDecoder();
  return dec.decode(new Uint8Array(decrypted));
}

/** Encode binary data to base64 string */
export function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 string to binary */
export function base64ToArrayBuffer(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encrypt PAT with PGP public key (single encryption).
 * Returns: armored PGP message
 */
export async function encryptPAT(
  pat: string,
  publicKeyArmored: string
): Promise<string> {
  return await encryptText(pat, publicKeyArmored);
}

/**
 * Decrypt PAT with PGP private key (single decryption).
 */
export async function decryptPAT(
  encryptedBlob: string,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  return await decryptMessage(encryptedBlob, privateKey);
}
