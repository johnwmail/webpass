/**
 * Unit tests for storage utilities
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Account } from '../types';
import {
  saveAccount,
  getAccount,
  listAccounts,
  deleteAccount,
  saveGitToken,
  getGitToken,
  deleteGitToken,
  aesEncrypt,
  aesDecrypt,
  savePublicKey,
  getPublicKey,
  savePrivateKey,
  getDecryptedPrivateKey,
} from './storage';

describe('Account CRUD', () => {
  const mockAccount: Account = {
    fingerprint: 'abc123',
    privateKey: '-----BEGIN PGP PRIVATE KEY BLOCK-----\ntest\n-----END PGP PRIVATE KEY BLOCK-----',
    publicKey: '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest\n-----END PGP PUBLIC KEY BLOCK-----',
    apiUrlEncrypted: 'encrypted-data',
    apiUrlSalt: 'salt123',
    apiUrlIv: 'iv456',
    label: 'Test Account',
  };

  beforeEach(async () => {
    // Clean up any existing accounts
    const accounts = await listAccounts();
    for (const acc of accounts) {
      await deleteAccount(acc.fingerprint);
    }
  });

  it('saves and retrieves an account', async () => {
    await saveAccount(mockAccount);
    const retrieved = await getAccount('abc123');
    expect(retrieved).toEqual(mockAccount);
  });

  it('returns null for non-existent account', async () => {
    const retrieved = await getAccount('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('lists all accounts', async () => {
    await saveAccount(mockAccount);
    await saveAccount({ ...mockAccount, fingerprint: 'def456', label: 'Second' });

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.fingerprint)).toContain('abc123');
    expect(accounts.map((a) => a.fingerprint)).toContain('def456');
  });

  it('returns empty array when no accounts', async () => {
    const accounts = await listAccounts();
    expect(accounts).toEqual([]);
  });

  it('deletes an account', async () => {
    await saveAccount(mockAccount);
    await deleteAccount('abc123');
    const retrieved = await getAccount('abc123');
    expect(retrieved).toBeNull();
  });

  it('updates an existing account', async () => {
    await saveAccount(mockAccount);
    await saveAccount({ ...mockAccount, label: 'Updated' });
    const retrieved = await getAccount('abc123');
    expect(retrieved?.label).toBe('Updated');
  });
});

describe('Git Token Storage', () => {
  beforeEach(async () => {
    const token = await getGitToken('test-fp');
    if (token) await deleteGitToken('test-fp');
  });

  it('saves and retrieves git token', async () => {
    await saveGitToken('test-fp', 'encrypted-token', 'salt123', 'iv456');
    const retrieved = await getGitToken('test-fp');
    expect(retrieved).toEqual({
      fingerprint: 'test-fp',
      encryptedToken: 'encrypted-token',
      salt: 'salt123',
      iv: 'iv456',
    });
  });

  it('returns null for non-existent token', async () => {
    const retrieved = await getGitToken('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('deletes git token', async () => {
    await saveGitToken('test-fp', 'token', 'salt', 'iv');
    await deleteGitToken('test-fp');
    const retrieved = await getGitToken('test-fp');
    expect(retrieved).toBeNull();
  });
});

describe('AES Encrypt/Decrypt', () => {
  it('encrypts and decrypts data', async () => {
    const password = 'my-secret-password';
    const plaintext = 'Hello, WebPass!';

    const encrypted = await aesEncrypt(plaintext, password);
    expect(encrypted.encrypted).toBeDefined();
    expect(encrypted.salt).toBeDefined();
    expect(encrypted.iv).toBeDefined();

    const decrypted = await aesDecrypt(encrypted.encrypted, password, encrypted.salt, encrypted.iv);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertexts for same plaintext', async () => {
    const password = 'password123';
    const plaintext = 'same text';

    const encrypted1 = await aesEncrypt(plaintext, password);
    const encrypted2 = await aesEncrypt(plaintext, password);

    expect(encrypted1.encrypted).not.toBe(encrypted2.encrypted);
    expect(encrypted1.salt).not.toBe(encrypted2.salt);
    expect(encrypted1.iv).not.toBe(encrypted2.iv);
  });

  it('decrypts with correct password', async () => {
    const password = 'correct-password';
    const plaintext = 'secret data';

    const encrypted = await aesEncrypt(plaintext, password);
    const decrypted = await aesDecrypt(encrypted.encrypted, password, encrypted.salt, encrypted.iv);
    expect(decrypted).toBe(plaintext);
  });

  it('fails with wrong password', async () => {
    const password = 'correct-password';
    const plaintext = 'secret data';

    const encrypted = await aesEncrypt(plaintext, password);
    await expect(
      aesDecrypt(encrypted.encrypted, 'wrong-password', encrypted.salt, encrypted.iv)
    ).rejects.toThrow();
  });

  it('handles unicode plaintext', async () => {
    const password = 'unicode-pass';
    const plaintext = 'Unicode: 🔐 ñ 中文 🚀';

    const encrypted = await aesEncrypt(plaintext, password);
    const decrypted = await aesDecrypt(encrypted.encrypted, password, encrypted.salt, encrypted.iv);
    expect(decrypted).toBe(plaintext);
  });

  it('handles empty string', async () => {
    const password = 'empty-pass';
    const plaintext = '';

    const encrypted = await aesEncrypt(plaintext, password);
    const decrypted = await aesDecrypt(encrypted.encrypted, password, encrypted.salt, encrypted.iv);
    expect(decrypted).toBe(plaintext);
  });
});

describe('PGP Key Storage', () => {
  beforeEach(async () => {
    const accounts = await listAccounts();
    for (const acc of accounts) {
      await deleteAccount(acc.fingerprint);
    }
  });

  it('saves and retrieves public key', async () => {
    const fp = 'key-fp-123';
    const pubKey = '-----BEGIN PGP PUBLIC KEY BLOCK-----\ntest-key\n-----END PGP PUBLIC KEY BLOCK-----';

    await savePublicKey(fp, pubKey);
    const retrieved = await getPublicKey(fp);
    expect(retrieved).toBe(pubKey);
  });

  it('falls back to account store for public key', async () => {
    const fp = 'key-fp-456';
    const pubKey = 'fallback-public-key';
    const account: Account = {
      fingerprint: fp,
      privateKey: 'priv',
      publicKey: pubKey,
      apiUrlEncrypted: 'enc',
      apiUrlSalt: 'salt',
      apiUrlIv: 'iv',
    };

    await saveAccount(account);
    const retrieved = await getPublicKey(fp);
    expect(retrieved).toBe(pubKey);
  });

  it('returns null for missing public key', async () => {
    const retrieved = await getPublicKey('nonexistent');
    expect(retrieved).toBeNull();
  });

  it('saves and retrieves private key', async () => {
    const fp = 'key-fp-789';
    const privKey = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nprivate\n-----END PGP PRIVATE KEY BLOCK-----';

    await savePrivateKey(fp, privKey);
    const retrieved = await getDecryptedPrivateKey(fp, 'any-passphrase');
    expect(retrieved).toBe(privKey);
  });

  it('falls back to account store for private key', async () => {
    const fp = 'key-fp-abc';
    const privKey = 'fallback-private-key';
    const account: Account = {
      fingerprint: fp,
      privateKey: privKey,
      publicKey: 'pub',
      apiUrlEncrypted: 'enc',
      apiUrlSalt: 'salt',
      apiUrlIv: 'iv',
    };

    await saveAccount(account);
    const retrieved = await getDecryptedPrivateKey(fp, 'any-passphrase');
    expect(retrieved).toBe(privKey);
  });

  it('returns null for missing private key', async () => {
    const retrieved = await getDecryptedPrivateKey('nonexistent', 'pass');
    expect(retrieved).toBeNull();
  });
});
