import { ApiClient } from './api';
import type { SessionState } from '../types';

const STORAGE_KEY = 'webpass_session';

class Session {
  fingerprint: string | null = null;
  token: string | null = null;
  api: ApiClient | null = null;
  expiresAt: number | null = null;
  publicKey: string | null = null;
  private _listeners: Set<() => void> = new Set();

  constructor() {
    // Restore session from sessionStorage on init (only non-sensitive metadata)
    this._restore();
  }

  private _restore() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state: SessionState = JSON.parse(stored);
        // Note: token is now in httpOnly cookie, we only restore metadata here
        if (state.fingerprint && state.publicKey && state.apiUrl) {
          this.fingerprint = state.fingerprint;
          this.publicKey = state.publicKey;
          this.api = new ApiClient(state.apiUrl);
          this.api.fingerprint = state.fingerprint;
          // Token will be read from cookie by the browser automatically
        } else {
          sessionStorage.removeItem(STORAGE_KEY);
        }
      }
    } catch (e) {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  private _persist() {
    try {
      const state = this.getState();
      // Only store non-sensitive metadata (fingerprint, publicKey, apiUrl)
      // Token is stored in httpOnly cookie by the server
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // Ignore persistence errors
    }
  }

  isActive(): boolean {
    // Session is active if we have fingerprint and API client
    // Token validity is verified server-side via cookie
    return this.fingerprint !== null && this.api !== null;
  }

  remainingSeconds(): number {
    // With cookie-based auth, we don't track expiry client-side
    // The server validates the cookie expiry on each request
    return 0;
  }

  activate(opts: {
    fingerprint: string;
    token: string;
    apiUrl: string;
    publicKey: string;
  }) {
    this.fingerprint = opts.fingerprint;
    this.token = opts.token; // Keep for backward compatibility, but not stored
    this.publicKey = opts.publicKey;
    this.api = new ApiClient(opts.apiUrl);
    this.api.fingerprint = opts.fingerprint;
    this.api.token = opts.token; // Set token on API client for Authorization header
    // Token is now in httpOnly cookie - don't store it in sessionStorage
    this._persist();
    this._notify();
  }

  clear() {
    this.fingerprint = null;
    this.token = null;
    this.api = null;
    this.expiresAt = null;
    this.publicKey = null;
    sessionStorage.removeItem(STORAGE_KEY);
    this._notify();
  }

  getState(): SessionState {
    return {
      fingerprint: this.fingerprint,
      token: null, // Token is in cookie, not exposed to JS
      expiresAt: null, // Expiry is server-side now
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
