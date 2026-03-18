/**
 * Test data generators for E2E tests.
 */

import * as crypto from 'crypto';

export interface TestUser {
  fingerprint: string;
  password: string;
  publicKey: string;
  privateKey?: string;
  email?: string;
}

export interface TestEntry {
  path: string;
  username: string;
  password: string;
  notes?: string;
}

/**
 * Generate a random test user.
 */
export function generateTestUser(overrides?: Partial<TestUser>): TestUser {
  const suffix = crypto.randomBytes(8).toString('hex');
  return {
    fingerprint: `test-fp-${suffix}`,
    password: `test-password-${suffix}`,
    publicKey: `test-public-key-${suffix}`,
    email: `test-${suffix}@example.com`,
    ...overrides,
  };
}

/**
 * Generate a random hex string.
 */
export function randomHex(length: number): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a random string.
 */
export function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(crypto.randomInt(0, chars.length));
  }
  return result;
}

/**
 * Generate test entry data.
 */
export function generateTestEntry(overrides?: Partial<TestEntry>): TestEntry {
  const suffix = crypto.randomBytes(4).toString('hex');
  return {
    path: `Test/${suffix}`,
    username: `user-${suffix}@example.com`,
    password: `secure-password-${suffix}`,
    notes: `Test notes for ${suffix}`,
    ...overrides,
  };
}

/**
 * Generate a mock TOTP code (6 digits).
 * Note: For real TOTP validation, use the otpauth library with a secret.
 */
export function generateMockTOTPCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * Create a tar.gz archive in memory for import tests.
 */
export async function createTarGz(
  files: Array<{ path: string; content: string | Buffer }>
): Promise<Buffer> {
  const tar = await import('tar-stream');
  const { gzipSync } = await import('zlib');

  const pack = tar.pack();
  const chunks: Buffer[] = [];

  pack.on('data', (chunk: Buffer) => chunks.push(chunk));

  for (const file of files) {
    pack.entry(
      { name: file.path, size: Buffer.isBuffer(file.content) ? file.content.length : file.content.length },
      file.content
    );
  }

  pack.finalize();

  // Wait for packing to complete
  await new Promise<void>((resolve) => {
    pack.on('end', () => resolve());
  });

  const tarBuffer = Buffer.concat(chunks);
  return gzipSync(tarBuffer);
}

/**
 * Sample test entries for common scenarios.
 */
export const sampleEntries: TestEntry[] = [
  {
    path: 'Email/gmail',
    username: 'user@gmail.com',
    password: 'gmail-password-123',
    notes: 'Personal Gmail account',
  },
  {
    path: 'Email/outlook',
    username: 'user@outlook.com',
    password: 'outlook-password-456',
    notes: 'Work Outlook account',
  },
  {
    path: 'Social/github',
    username: 'github-user',
    password: 'github-password-789',
    notes: 'GitHub account',
  },
  {
    path: 'Social/twitter',
    username: '@twitter-handle',
    password: 'twitter-password-abc',
    notes: 'Twitter account',
  },
  {
    path: 'Finance/chase',
    username: 'chase-user',
    password: 'chase-password-def',
    notes: 'Chase bank account',
  },
];

/**
 * Generate PGP-like key placeholder.
 * Note: For real PGP operations, use the openpgp library.
 */
export function generateMockPGPKey(): { publicKey: string; privateKey: string; fingerprint: string } {
  const keyId = crypto.randomBytes(16).toString('hex').toUpperCase();
  const fingerprint = crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g)?.join(' ') || '';
  
  const publicKey = `-----BEGIN PGP PUBLIC KEY BLOCK-----
Version: OpenPGP.js v4.10.10
Comment: https://openpgpjs.org

xsBNBF/test-${keyId}
Mock public key content for testing
=mock1
-----END PGP PUBLIC KEY BLOCK-----`;

  const privateKey = `-----BEGIN PGP PRIVATE KEY BLOCK-----
Version: OpenPGP.js v4.10.10
Comment: https://openpgpjs.org

xcBNBF/test-${keyId}
Mock private key content for testing
=mock2
-----END PGP PRIVATE KEY BLOCK-----`;

  return {
    publicKey,
    privateKey,
    fingerprint,
  };
}
