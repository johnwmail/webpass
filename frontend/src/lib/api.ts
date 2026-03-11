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
    return `${this.baseUrl}${path}`;
  }

  /** POST /api/users — create user */
  async setup(
    password: string,
    publicKey: string,
    fingerprint: string
  ): Promise<{ fingerprint: string }> {
    const res = await fetch(this.url('/api/users'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ password, public_key: publicKey, fingerprint }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Setup failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/users/:fp/login */
  async login(
    password: string
  ): Promise<{ token?: string; requires_2fa?: boolean }> {
    const res = await fetch(this.url(`/api/users/${this.fingerprint}/login`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `Login failed (${res.status})`);
    }
    return res.json();
  }

  /** POST /api/users/:fp/login/2fa */
  async login2fa(
    password: string,
    code: string
  ): Promise<{ token: string }> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/login/2fa`),
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

  /** GET /api/users/:fp/entries */
  async listEntries(): Promise<EntryMeta[]> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/entries`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`List entries failed (${res.status})`);
    const data = await res.json();
    return data.entries || [];
  }

  /** GET /api/users/:fp/entries/:path — returns raw binary blob */
  async getEntry(path: string): Promise<Uint8Array> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/entries/${path}`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Get entry failed (${res.status})`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** PUT /api/users/:fp/entries/:path */
  async putEntry(path: string, content: Uint8Array): Promise<void> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/entries/${path}`),
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

  /** DELETE /api/users/:fp/entries/:path */
  async deleteEntry(path: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/entries/${path}`),
      {
        method: 'DELETE',
        headers: this.headers(),
      }
    );
    if (!res.ok) throw new Error(`Delete entry failed (${res.status})`);
  }

  /** POST /api/users/:fp/entries/move */
  async moveEntry(from: string, to: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/entries/move`),
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ from, to }),
      }
    );
    if (!res.ok) throw new Error(`Move entry failed (${res.status})`);
  }

  /** POST /api/users/:fp/totp/setup */
  async setupTOTP(): Promise<{ secret: string; url: string }> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/totp/setup`),
      {
        method: 'POST',
        headers: this.headers(),
      }
    );
    if (!res.ok) throw new Error(`TOTP setup failed (${res.status})`);
    return res.json();
  }

  /** POST /api/users/:fp/totp/confirm */
  async confirmTOTP(secret: string, code: string): Promise<void> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/totp/confirm`),
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

  /** GET /api/users/:fp/export */
  async exportAll(): Promise<Blob> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/export`),
      { headers: this.headers() }
    );
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    return res.blob();
  }

  /** POST /api/users/:fp/import */
  async importArchive(file: File | Blob): Promise<{ imported: number }> {
    const res = await fetch(
      this.url(`/api/users/${this.fingerprint}/import`),
      {
        method: 'POST',
        headers: {
          ...this.headers(true),
          'Content-Type': 'application/gzip',
        },
        body: file,
      }
    );
    if (!res.ok) throw new Error(`Import failed (${res.status})`);
    return res.json();
  }
}
