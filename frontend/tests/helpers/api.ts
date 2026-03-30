/**
 * API helpers for E2E test setup and teardown.
 */

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8080';

export interface TestUser {
  fingerprint: string;
  password: string;
  publicKey: string;
  privateKey?: string;
  totpSecret?: string;
  registrationCode?: string;
}

export interface ApiError {
  error: string;
}

/**
 * Register a new user via API with TOTP code for Protected Mode.
 */
export async function apiRegister(overrides?: Partial<TestUser>): Promise<TestUser> {
  const user = {
    fingerprint: `test-${cryptoRandomHex(8)}`,
    password: `test-password-${cryptoRandomHex(8)}`,
    publicKey: `test-public-key-${cryptoRandomHex(16)}`,
    ...overrides,
  };

  // Generate valid TOTP code for Protected Mode
  const otpauth = await import('otpauth');
  const totp = new otpauth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 3600,
    secret: otpauth.Secret.fromBase32('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'),
  });
  const registrationCode = totp.generate();

  const response = await fetch(`${BASE_URL}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Registration-Code': registrationCode,
    },
    body: JSON.stringify({
      fingerprint: user.fingerprint,
      password: user.password,
      public_key: user.publicKey,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to register: ${response.status} ${JSON.stringify(error)}`);
  }

  return { ...user, registrationCode };
}

/**
 * Login via API and return the JWT token.
 */
export async function apiLogin(user: TestUser): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: user.password }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to login: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  return data.token;
}

/**
 * Login with 2FA via API.
 */
export async function apiLoginWith2FA(user: TestUser, totpCode: string): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/login/2fa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: user.password, totp_code: totpCode }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to login with 2FA: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  return data.token;
}

/**
 * Create an entry via API.
 */
export async function apiCreateEntry(
  user: TestUser,
  path: string,
  blob: string | Uint8Array
): Promise<void> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/entries/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: blob,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to create entry: ${response.status} ${JSON.stringify(error)}`);
  }
}

/**
 * Get an entry via API.
 */
export async function apiGetEntry(user: TestUser, path: string): Promise<string> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/entries/${encodeURIComponent(path)}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to get entry: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.text();
}

/**
 * List entries via API.
 */
export async function apiListEntries(
  user: TestUser
): Promise<Array<{ path: string; created: string; updated: string }>> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/entries`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to list entries: ${response.status} ${JSON.stringify(error)}`);
  }

  const data = await response.json();
  return data.entries || [];
}

/**
 * Delete an entry via API.
 */
export async function apiDeleteEntry(user: TestUser, path: string): Promise<void> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/entries/${encodeURIComponent(path)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to delete entry: ${response.status} ${JSON.stringify(error)}`);
  }
}

/**
 * Delete user account via API.
 */
export async function apiDeleteAccount(user: TestUser): Promise<void> {
  try {
    const token = await apiLogin(user);

    const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/account`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(`Failed to delete account: ${response.status} ${JSON.stringify(error)}`);
    }
  } catch (e) {
    // Ignore errors - account might not exist
  }
}

/**
 * Setup TOTP via API.
 */
export async function apiSetupTOTP(user: TestUser): Promise<{ secret: string; url: string }> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/totp/setup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to setup TOTP: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.json();
}

/**
 * Confirm TOTP via API.
 */
export async function apiConfirmTOTP(
  user: TestUser,
  secret: string,
  code: string
): Promise<{ enabled: boolean }> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/totp/confirm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ secret, code }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to confirm TOTP: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.json();
}

/**
 * Export entries via API.
 */
export async function apiExport(user: TestUser): Promise<Uint8Array> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/export`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to export: ${response.status} ${JSON.stringify(error)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Import entries via API.
 */
export async function apiImport(
  user: TestUser,
  tarGzData: Uint8Array
): Promise<{ imported: number }> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: tarGzData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to import: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.json();
}

/**
 * Configure git remote via API.
 */
export async function apiConfigureGit(
  user: TestUser,
  remoteUrl: string,
  pat: string,
  pgpPassphrase?: string
): Promise<void> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/git/config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      repo_url: remoteUrl,
      encrypted_pat: pat,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to configure git: ${response.status} ${JSON.stringify(error)}`);
  }
}

/**
 * Set git session token via API.
 */
export async function apiSetGitSession(user: TestUser, token: string): Promise<void> {
  const authToken = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/git/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to set git session: ${response.status} ${JSON.stringify(error)}`);
  }
}

/**
 * Push to git remote via API.
 */
export async function apiGitPush(user: TestUser): Promise<{ message?: string }> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/git/push`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to push: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.json();
}

/**
 * Pull from git remote via API.
 */
export async function apiGitPull(user: TestUser): Promise<{ message?: string }> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/git/pull`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to pull: ${response.status} ${JSON.stringify(error)}`);
  }

  return await response.json();
}

/**
 * Generate a random hex string.
 */
function cryptoRandomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
