import { ApiClient } from './api';
import type { SessionState } from '../types';

const SESSION_DURATION_MS = 5 * 60 * 1000; // 5 minutes

class Session {
  fingerprint: string | null = null;
  token: string | null = null;
  api: ApiClient | null = null;
  expiresAt: number | null = null;
  publicKey: string | null = null;
  private _listeners: Set<() => void> = new Set();

  isActive(): boolean {
    if (!this.token || !this.expiresAt) return false;
    return Date.now() < this.expiresAt;
  }

  remainingSeconds(): number {
    if (!this.expiresAt) return 0;
    return Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000));
  }

  activate(opts: {
    fingerprint: string;
    token: string;
    apiUrl: string;
    publicKey: string;
  }) {
    this.fingerprint = opts.fingerprint;
    this.token = opts.token;
    this.expiresAt = Date.now() + SESSION_DURATION_MS;
    this.publicKey = opts.publicKey;
    this.api = new ApiClient(opts.apiUrl);
    this.api.token = opts.token;
    this.api.fingerprint = opts.fingerprint;
    this._notify();
  }

  clear() {
    this.fingerprint = null;
    this.token = null;
    this.api = null;
    this.expiresAt = null;
    this.publicKey = null;
    this._notify();
  }

  getState(): SessionState {
    return {
      fingerprint: this.fingerprint,
      token: this.token,
      expiresAt: this.expiresAt,
      apiUrl: this.api?.baseUrl || null,
      publicKey: this.publicKey,
    };
  }

  subscribe(fn: () => void): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() {
    this._listeners.forEach((fn) => fn());
  }
}

export const session = new Session();
