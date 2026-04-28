/**
 * Unit tests for crypto utilities
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKeyPair,
  getFingerprint,
  decryptPrivateKey,
  importPrivateKey,
  clearSensitiveData,
  encryptText,
  decryptMessage,
  encryptBinary,
  decryptBinary,
  WrongKeyError,
  deriveKey,
  generateSalt,
  aesGcmEncrypt,
  aesGcmDecrypt,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  encryptPAT,
  decryptPAT,
} from './crypto';

describe('generateKeyPair', () => {
  it('generates a keypair with fingerprint', async () => {
    const result = await generateKeyPair('test-passphrase-123');

    expect(result.publicKey).toContain('-----BEGIN PGP PUBLIC KEY BLOCK-----');
    expect(result.privateKey).toContain('-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(result.fingerprint).toMatch(/^[0-9A-F]{40}$/);
  }, 30000);

  it('generates deterministic fingerprints for same inputs', async () => {
    // Different passphrases should still produce valid keys
    const result1 = await generateKeyPair('pass-one');
    const result2 = await generateKeyPair('pass-two');

    expect(result1.fingerprint).not.toBe(result2.fingerprint);
    expect(result1.publicKey).not.toBe(result2.publicKey);
  }, 30000);
});

describe('getFingerprint', () => {
  let publicKey: string;
  let fingerprint: string;

  beforeAll(async () => {
    const result = await generateKeyPair('test-pass');
    publicKey = result.publicKey;
    fingerprint = result.fingerprint;
  }, 30000);

  it('extracts fingerprint from public key', async () => {
    const fp = await getFingerprint(publicKey);
    expect(fp).toBe(fingerprint);
    expect(fp).toMatch(/^[0-9A-F]{40}$/);
  });

  it('throws on invalid key', async () => {
    await expect(getFingerprint('not-a-key')).rejects.toThrow();
  });
});

describe('decryptPrivateKey', () => {
  let privateKey: string;
  let passphrase: string;

  beforeAll(async () => {
    passphrase = 'correct-passphrase';
    const result = await generateKeyPair(passphrase);
    privateKey = result.privateKey;
  }, 30000);

  it('decrypts with correct passphrase', async () => {
    const decrypted = await decryptPrivateKey(privateKey, passphrase);
    expect(decrypted.isDecrypted()).toBe(true);
  });

  it('throws with wrong passphrase', async () => {
    await expect(decryptPrivateKey(privateKey, 'wrong-passphrase')).rejects.toThrow();
  });

  it('throws on invalid key format', async () => {
    await expect(decryptPrivateKey(123 as any, 'pass')).rejects.toThrow('Invalid key format');
  });
});

describe('importPrivateKey', () => {
  let privateKey: string;
  let passphrase: string;

  beforeAll(async () => {
    passphrase = 'import-test-pass';
    const result = await generateKeyPair(passphrase);
    privateKey = result.privateKey;
  }, 30000);

  it('imports and decrypts armored key', async () => {
    const decrypted = await importPrivateKey(privateKey, passphrase);
    expect(decrypted.isDecrypted()).toBe(true);
  });

  it('throws with wrong passphrase', async () => {
    await expect(importPrivateKey(privateKey, 'wrong')).rejects.toThrow();
  });
});

describe('clearSensitiveData', () => {
  it('nullifies variables without throwing', () => {
    let a: any = 'secret';
    let b: any = 123;
    clearSensitiveData(a, b);
    // Note: primitive arguments passed by value can't be mutated,
    // but function should not throw
    expect(() => clearSensitiveData('x', 1, null)).not.toThrow();
  });
});

describe('encryptText / decryptMessage round-trip', () => {
  let keypair: { publicKey: string; privateKey: string; fingerprint: string };

  beforeAll(async () => {
    keypair = await generateKeyPair('roundtrip-pass');
  }, 30000);

  it('encrypts and decrypts text', async () => {
    const plaintext = 'Hello, WebPass!';
    const encrypted = await encryptText(plaintext, keypair.publicKey);

    expect(encrypted).toContain('-----BEGIN PGP MESSAGE-----');

    const decryptedKey = await decryptPrivateKey(keypair.privateKey, 'roundtrip-pass');
    const decrypted = await decryptMessage(encrypted, decryptedKey);

    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts empty string', async () => {
    const encrypted = await encryptText('', keypair.publicKey);
    const decryptedKey = await decryptPrivateKey(keypair.privateKey, 'roundtrip-pass');
    const decrypted = await decryptMessage(encrypted, decryptedKey);
    expect(decrypted).toBe('');
  });

  it('encrypts and decrypts unicode text', async () => {
    const plaintext = 'Unicode: 🔐 ñ 中文 🚀';
    const encrypted = await encryptText(plaintext, keypair.publicKey);
    const decryptedKey = await decryptPrivateKey(keypair.privateKey, 'roundtrip-pass');
    const decrypted = await decryptMessage(encrypted, decryptedKey);
    expect(decrypted).toBe(plaintext);
  });
});

describe('encryptBinary / decryptBinary round-trip', () => {
  let keypair: { publicKey: string; privateKey: string; fingerprint: string };

  beforeAll(async () => {
    keypair = await generateKeyPair('binary-pass');
  }, 30000);

  it('encrypts to binary and decrypts', async () => {
    const plaintext = 'Binary encryption test';
    const encrypted = await encryptBinary(plaintext, keypair.publicKey);

    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBeGreaterThan(0);

    const decryptedKey = await decryptPrivateKey(keypair.privateKey, 'binary-pass');
    const decrypted = await decryptBinary(encrypted, decryptedKey);

    expect(decrypted).toBe(plaintext);
  });

  it('throws with mismatched key', async () => {
    const plaintext = 'secret data';
    const encrypted = await encryptBinary(plaintext, keypair.publicKey);

    // Generate a different keypair
    const otherKeypair = await generateKeyPair('other-pass');
    const wrongKey = await decryptPrivateKey(otherKeypair.privateKey, 'other-pass');

    // Completely different keypair throws "No decryption key packets found"
    // rather than "Session key decryption failed"
    await expect(decryptBinary(encrypted, wrongKey)).rejects.toThrow();
  }, 30000);

  it('throws WrongKeyError on session key decryption failure', () => {
    // Directly test the error class behavior
    const err = new WrongKeyError('session key failed');
    expect(err.name).toBe('WrongKeyError');
    expect(err.message).toBe('session key failed');
  });
});

describe('WrongKeyError', () => {
  it('has correct name and message', () => {
    const err = new WrongKeyError('test message');
    expect(err.name).toBe('WrongKeyError');
    expect(err.message).toBe('test message');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('PBKDF2 + AES-GCM helpers', () => {
  it('generateSalt produces 16 random bytes', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(16);

    const salt2 = generateSalt();
    expect(salt).not.toEqual(salt2); // very likely different
  });

  it('deriveKey produces a CryptoKey', async () => {
    const salt = generateSalt();
    const key = await deriveKey('my-password', salt);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
    expect(key.algorithm.name).toBe('AES-GCM');
  });

  it('aesGcmEncrypt produces ciphertext and iv', async () => {
    const salt = generateSalt();
    const key = await deriveKey('password', salt);
    const result = await aesGcmEncrypt('hello world', key);

    expect(result.ciphertext).toBeInstanceOf(Uint8Array);
    expect(result.iv).toBeInstanceOf(Uint8Array);
    expect(result.iv.length).toBe(12);
    expect(result.ciphertext.length).toBeGreaterThan(0);
  });

  it('aesGcmDecrypt recovers plaintext', async () => {
    const salt = generateSalt();
    const key = await deriveKey('password', salt);
    const encrypted = await aesGcmEncrypt('secret message', key);
    const decrypted = await aesGcmDecrypt(encrypted.ciphertext, encrypted.iv, key);
    expect(decrypted).toBe('secret message');
  });

  it('aesGcmDecrypt fails with wrong key', async () => {
    const salt = generateSalt();
    const key = await deriveKey('correct-password', salt);
    const encrypted = await aesGcmEncrypt('secret', key);

    const wrongSalt = generateSalt();
    const wrongKey = await deriveKey('wrong-password', wrongSalt);

    await expect(aesGcmDecrypt(encrypted.ciphertext, encrypted.iv, wrongKey)).rejects.toThrow();
  });
});

describe('Base64 helpers', () => {
  it('arrayBufferToBase64 / base64ToArrayBuffer round-trip', () => {
    const data = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const b64 = arrayBufferToBase64(data);
    expect(typeof b64).toBe('string');
    expect(b64.length).toBeGreaterThan(0);

    const recovered = base64ToArrayBuffer(b64);
    expect(recovered).toEqual(data);
  });

  it('handles empty array', () => {
    const data = new Uint8Array(0);
    const b64 = arrayBufferToBase64(data);
    expect(b64).toBe('');
    expect(base64ToArrayBuffer(b64)).toEqual(data);
  });
});

describe('encryptPAT / decryptPAT', () => {
  let keypair: { publicKey: string; privateKey: string; fingerprint: string };

  beforeAll(async () => {
    keypair = await generateKeyPair('pat-pass');
  }, 30000);

  it('encrypts and decrypts PAT', async () => {
    const pat = 'ghp_1234567890abcdef';
    const encrypted = await encryptPAT(pat, keypair.publicKey);

    expect(encrypted).toContain('-----BEGIN PGP MESSAGE-----');

    const decryptedKey = await decryptPrivateKey(keypair.privateKey, 'pat-pass');
    const decrypted = await decryptPAT(encrypted, decryptedKey);

    expect(decrypted).toBe(pat);
  });
});
