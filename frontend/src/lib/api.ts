import type { EntryMeta } from '../types';

export class ApiClient {
  baseUrl: string;
  token: string | null = null;
  fingerprint: string = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(binary = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (!binary) h['Content-Type'] = 'application/json';
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  private url(path: string): string {
    // Strip leading /api if baseUrl already ends with /api
    if (this.baseUrl.endsWith('/api') && path.startsWith('/api')) {
      if (path === '/api') {
        // Exact match - just return baseUrl
        return this.baseUrl;
      }
      // Strip '/api' prefix (4 characters) from path
      path = path.slice(4);
    }
    return `${this.baseUrl}${path}`;
  }

  /** POST /api — create user */
  async setup(
    password: string,
    publicKey: string,
    fingerprint: string,
    registrationCode?: string
  ): Promise<{ fingerprint: string }> {
    const headers = this.headers();
    if (registrationCode) {
      headers['X-Registration-Code'] = registrationCode;
    }
    const res = await fetch(this.url('/api'), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ password, public_key: publicKey, fingerprint }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Setup failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/registration/validate — validate registration code */
  async validateRegistrationCode(code: string): Promise<{ valid: boolean }> {
    const res = await fetch(this.url('/api/registration/validate'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Validation failed' }));
      throw new Error(err.error || `Validation failed (${res.status})`);
    }
    return res.json();
  }

  /** GET /api/registration/mode — get registration mode */
  async getRegistrationMode(): Promise<{ mode: 'disabled' | 'open' | 'protected' }> {
    const res = await fetch(this.url('/api/registration/mode'));
    if (!res.ok) {
      throw new Error(`Failed to fetch registration mode (${res.status})`);
    }
    return res.json();
  }

  /** GET /api/:fingerprint — check if user exists */
  async checkUserExists(fingerprint: string): Promise<{ exists: boolean; public_key?: string }> {
    const res = await fetch(this.url(`/api/${fingerprint}`));
    if (res.status === 404) {
      throw new Error(`User not found (${res.status})`);
    }
    if (!res.ok) {
      throw new Error(`Request failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/:fp/login */
  async login(
    password: string
  ): Promise<{ token?: string; requires_2fa?: boolean }> {
    const res = await fetch(this.url(`/api/${this.fingerprint}/login`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      // Try to parse JSON error, fallback to text for HTML responses
      const text = await res.text().catch(() => '');
      let errMsg = `Login failed (${res.status})`;
      try {
        const err = JSON.parse(text);
        errMsg = err.error || errMsg;
      } catch {
        // Response was not JSON (e.g., HTML error page)
        if (res.status === 404) {
          errMsg = 'User not found';
        } else if (res.status === 401) {
          errMsg = 'invalid credentials';
        }
      }
      throw new Error(errMsg);
    }
    return res.json();
  }

  /** POST /api/:fp/login/2fa */
  async login2fa(
    password: string,
    code: string
  ): Promise<{ token: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/login/2fa`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ password, totp_code: code }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `2FA failed (${res.status})`);
    }
    return res.json();
  }

  /** GET /api/:fp/entries */
  async listEntries(): Promise<EntryMeta[]> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/entries`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`List entries failed (${res.status})`);
    const data = await res.json();
    return data.entries || [];
  }

  /** GET /api/:fp/entries/:path — returns raw binary blob */
  async getEntry(path: string): Promise<Uint8Array> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/entries/${path}`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Get entry failed (${res.status})`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** PUT /api/:fp/entries/:path */
  async putEntry(path: string, content: Uint8Array): Promise<void> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/entries/${path}`),
      {
        method: 'PUT',
        headers: {
          ...this.headers(true),
          'Content-Type': 'application/octet-stream',
        },
        body: content.buffer as ArrayBuffer,
      }
    );
    if (!res.ok) throw new Error(`Put entry failed (${res.status})`);
  }

  /** DELETE /api/:fp/entries/:path */
  async deleteEntry(path: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/entries/${path}`),
      {
        method: 'DELETE',
        headers: this.headers(),
      }
    );
    if (!res.ok) throw new Error(`Delete entry failed (${res.status})`);
  }

  /** DELETE /api/:fp/account — delete user account (server-side) */
  async deleteAccount(): Promise<void> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/account`),
      {
        method: 'DELETE',
        headers: this.headers(),
      }
    );
    if (!res.ok) throw new Error(`Delete account failed (${res.status})`);
  }

  /** POST /api/:fp/entries/move */
  async moveEntry(from: string, to: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/entries/move`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ from, to }),
      }
    );
    if (!res.ok) throw new Error(`Move entry failed (${res.status})`);
  }

  /** POST /api/:fp/totp/setup */
  async setupTOTP(): Promise<{ secret: string; url: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/totp/setup`),
      {
        method: 'POST',
        headers: this.headers(),
      }
    );
    if (!res.ok) throw new Error(`TOTP setup failed (${res.status})`);
    return res.json();
  }

  /** POST /api/:fp/totp/confirm */
  async confirmTOTP(secret: string, code: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/totp/confirm`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ secret, code }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `TOTP confirm failed (${res.status})`);
    }
  }

  /** GET /api/:fp/export */
  async exportAll(): Promise<Blob> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/export`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.blob();
  }

  /** POST /api/:fp/import */
  async importArchive(file: File | Blob): Promise<{ imported: number }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/import`),
      {
        method: 'POST',
        headers: {
          ...this.headers(true),
          'Content-Type': 'application/gzip',
        },
        body: file,
      }
    );
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown');
      throw new Error(`Import failed (${res.status})`);
    }
    const result = await res.json();
    return result;
  }

  /** POST /api/:fp/import — batch import with JSON array */
  async importBatch(entries: Array<{ path: string; content: string }>): Promise<{
    imported: number;
    overwritten?: number;
    errors?: Array<{ path: string; error: string }>;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/import`),
      {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(entries),
      }
    );
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'unknown');
      throw new Error(`Import failed (${res.status})`);
    }
    const result = await res.json();
    return result;
  }

  // ---------------------------------------------------------------------------
  // Git Sync API
  // ---------------------------------------------------------------------------

  /** GET /api/:fp/git/status */
  async getGitStatus(): Promise<{
    configured: boolean;
    repo_url?: string;
    has_encrypted_pat?: boolean;
    success_count: number;
    failed_count: number;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/status`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git status failed (${res.status})`);
    return res.json();
  }

  /** GET /api/:fp/git/config */
  async getGitConfig(): Promise<{
    configured: boolean;
    repo_url: string;
    encrypted_pat: string;
    has_encrypted_pat: boolean;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/config`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git config fetch failed (${res.status})`);
    return res.json();
  }

  /** POST /api/:fp/git/config */
  async configureGit(
    repoUrl: string,
    encryptedPat: string
  ): Promise<{ status: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/config`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ repo_url: repoUrl, encrypted_pat: encryptedPat, branch: 'HEAD' }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Git config failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/:fp/git/session — set git token for this session */
  async setGitSession(token: string): Promise<{ status: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/session`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ token }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Git session failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/:fp/git/push */
  async gitPush(token?: string): Promise<{
    status: string;
    operation: string;
    message: string;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/push`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ token: token || '' }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Git push failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/:fp/git/pull */
  async gitPull(token?: string): Promise<{
    status: string;
    operation: string;
    entries_changed?: number;
    message: string;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/pull`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ token: token || '' }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Git pull failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/:fp/git/toggle-sync — deprecated */
  async toggleGitSync(): Promise<{ status: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/toggle-sync`),
      {
        method: 'POST',
        headers: this.headers(),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Toggle sync failed (${res.status})`);
    }
    return res.json();
  }

  /** GET /api/:fp/git/log */
  async getGitLog(): Promise<{
    logs: Array<{
      id: number;
      operation: string;
      status: string;
      message: string;
      entries_changed: number;
      created_at: string;
    }>;
  }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/git/log`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Git log failed (${res.status})`);
    return res.json();
  }

  /** GET /api/version */
  async fetchVersion(): Promise<{ version: string; commit: string; build_time: string }> {
    const res = await fetch(this.url('/api/version'));
    if (!res.ok) throw new Error(`Version fetch failed (${res.status})`);
    return res.json();
  }

  /** POST /api/:fp/password — change password */
  async changePassword(currentPassword: string, newPassword: string): Promise<{ status: string }> {
    const res = await fetch(
      this.url(`/api/${this.fingerprint}/password`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Password change failed (${res.status})`);
    }
    return res.json();
  }
}
