import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair } from './crypto';
import {
  encryptKeyTransfer,
  decryptKeyTransfer,
  inspectPrivateKey,
  KEY_TRANSFER_ITERATIONS,
} from './keyTransfer';

describe('key transfer envelope', () => {
  let privateKey: string;
  let fingerprint: string;
  const pairingCode = 'temporary-pairing-code';

  beforeAll(async () => {
    const kp = await generateKeyPair('test-pgp-passphrase');
    privateKey = kp.privateKey;
    fingerprint = kp.fingerprint;
  }, 60000);

  it('round-trips the passphrase-protected private key', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    expect(envelope.version).toBe(1);
    expect(envelope.kdf).toBe('pbkdf2-sha256');
    expect(envelope.iterations).toBe(KEY_TRANSFER_ITERATIONS);
    expect(envelope.fingerprint).toBe(fingerprint);
    expect(envelope.ciphertext).not.toContain('BEGIN PGP');

    const restored = await decryptKeyTransfer(envelope, pairingCode, fingerprint);
    expect(restored).toBe(privateKey);

    const info = await inspectPrivateKey(restored);
    expect(info.fingerprint).toBe(fingerprint);
  });

  it('rejects a wrong pairing code', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    await expect(decryptKeyTransfer(envelope, 'wrong-code', fingerprint)).rejects.toThrow();
  });

  it('rejects a tampered ciphertext', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    const bytes = atob(envelope.ciphertext);
    const tampered = `${bytes.slice(0, -1)}${bytes.slice(-1) === 'A' ? 'B' : 'A'}`;
    await expect(
      decryptKeyTransfer({ ...envelope, ciphertext: btoa(tampered) }, pairingCode, fingerprint)
    ).rejects.toThrow();
  });

  it('rejects a fingerprint mismatch', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    await expect(decryptKeyTransfer(envelope, pairingCode, 'OTHERFINGERPRINT')).rejects.toThrow();
  });

  it('rejects a different fingerprint in the envelope (AAD binding)', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    await expect(
      decryptKeyTransfer({ ...envelope, fingerprint: 'OTHERFINGERPRINT' }, pairingCode, 'OTHERFINGERPRINT')
    ).rejects.toThrow();
  });

  it('rejects weak KDF parameters', async () => {
    const envelope = await encryptKeyTransfer(privateKey, pairingCode, fingerprint);
    await expect(
      decryptKeyTransfer({ ...envelope, iterations: 1000 }, pairingCode, fingerprint)
    ).rejects.toThrow();
  });
});
