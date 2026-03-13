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
  armoredKey: string,
  passphrase: string
): Promise<openpgp.PrivateKey> {
  const privateKey = await openpgp.readPrivateKey({ armoredKey });
  return openpgp.decryptKey({ privateKey, passphrase });
}

/**
 * Import and decrypt external private key from file
 * 
 * SECURITY: The decrypted key is returned but should NEVER be persisted.
 * Caller must clear it from memory after use (set to null).
 * 
 * @param armoredKey - Armored PGP private key (from .asc or .pgp file)
 * @param passphrase - Passphrase to decrypt the key
 * @returns Decrypted private key (MUST be cleared from memory after use)
 */
export async function importPrivateKey(
  armoredKey: string,
  passphrase: string
): Promise<openpgp.PrivateKey> {
  // Read and parse the armored key
  const privateKey = await openpgp.readPrivateKey({ armoredKey });
  
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

/** Decrypt binary PGP message */
export async function decryptBinary(
  encrypted: Uint8Array,
  privateKey: openpgp.PrivateKey
): Promise<string> {
  const message = await openpgp.readMessage({ binaryMessage: encrypted });
  const { data } = await openpgp.decrypt({
    message,
    decryptionKeys: privateKey,
  });
  return data as string;
}

/** Encrypt text with a recipient's public key (for encrypt tool) */
export async function encryptForRecipient(
  text: string,
  recipientPublicKeyArmored: string
): Promise<string> {
  return encryptText(text, recipientPublicKeyArmored);
}

// ---------------------------------------------------------------------------
// PBKDF2 + AES-GCM helpers for PAT encryption
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
 * Double-encrypt PAT:
 * 1. PAT → PGP encrypt → pat.pgp
 * 2. pat.pgp → password encrypt (PBKDF2 + AES-GCM) → final blob
 * Returns: JSON string with encrypted data
 */
export async function encryptPAT(
  pat: string,
  publicKeyArmored: string,
  password: string
): Promise<string> {
  // Step 1: PGP encrypt
  const pgpEncrypted = await encryptBinary(pat, publicKeyArmored);
  
  // Step 2: Password encrypt
  const salt = generateSalt();
  const key = await deriveKey(password, salt);
  const { ciphertext, iv } = await aesGcmEncrypt(
    arrayBufferToBase64(pgpEncrypted),
    key
  );
  
  // Return as JSON
  return JSON.stringify({
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertext),
  });
}

/**
 * Double-decrypt PAT:
 * 1. blob → password decrypt (PBKDF2 + AES-GCM) → pat.pgp
 * 2. pat.pgp → PGP decrypt → PAT (plaintext)
 */
export async function decryptPAT(
  encryptedBlob: string,
  privateKey: openpgp.PrivateKey,
  password: string
): Promise<string> {
  const data = JSON.parse(encryptedBlob);
  const salt = base64ToArrayBuffer(data.salt);
  const iv = base64ToArrayBuffer(data.iv);
  const ciphertext = base64ToArrayBuffer(data.ciphertext);
  
  // Step 1: Password decrypt
  const key = await deriveKey(password, salt);
  const pgpEncryptedBase64 = await aesGcmDecrypt(ciphertext, iv, key);
  const pgpEncrypted = base64ToArrayBuffer(pgpEncryptedBase64);
  
  // Step 2: PGP decrypt
  return await decryptBinary(pgpEncrypted, privateKey);
}
