import { ApiClient } from './api';
import type { SessionState } from '../types';

const SESSION_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_KEY = 'webpass_session';

class Session {
  fingerprint: string | null = null;
  token: string | null = null;
  api: ApiClient | null = null;
  expiresAt: number | null = null;
  publicKey: string | null = null;
  private _listeners: Set<() => void> = new Set();

  constructor() {
    // Restore session from localStorage on init
    this._restore();
  }

  private _restore() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state: SessionState = JSON.parse(stored);
        if (state.token && state.expiresAt && Date.now() < state.expiresAt && state.fingerprint) {
          this.fingerprint = state.fingerprint;
          this.token = state.token;
          this.expiresAt = state.expiresAt;
          this.publicKey = state.publicKey;
          if (state.apiUrl) {
            this.api = new ApiClient(state.apiUrl);
            this.api.token = state.token;
            this.api.fingerprint = state.fingerprint;
          }
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  private _persist() {
    try {
      const state = this.getState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Ignore persistence errors
    }
  }

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
    this._persist();
    this._notify();
  }

  clear() {
    this.fingerprint = null;
    this.token = null;
    this.api = null;
    this.expiresAt = null;
    this.publicKey = null;
    localStorage.removeItem(STORAGE_KEY);
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
