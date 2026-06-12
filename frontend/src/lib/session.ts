import { ApiClient } from './api';
import type { SessionState } from '../types';
import type { PrivateKey } from 'openpgp';

const STORAGE_KEY = 'webpass_session';

class Session {
  fingerprint: string | null = null;
  token: string | null = null;
  api: ApiClient | null = null;
  expiresAt: number | null = null;
  publicKey: string | null = null;
  private _privateKey: PrivateKey | null = null;
  private _listeners: Set<() => void> = new Set();
  private _keyTimeoutMs: number = 30000; // default 30s
  private _keyTimer: ReturnType<typeof setTimeout> | null = null;
  private _keyExpiresAt: number | null = null; // epoch ms when key auto-lock fires

  constructor() {
    this._restore();
  }

  /** Override auto-lock timeout (for testing). Resets current timer if key is unlocked. */
  setKeyTimeout(seconds: number): void {
    this._keyTimeoutMs = seconds * 1000;
    if (this._privateKey) {
      this._resetKeyTimer();
      this._notify();
    }
  }

  /** Seconds remaining before PGP key auto-locks (0 = locked) */
  keyRemainingSeconds(): number {
    if (!this._privateKey || this._keyExpiresAt === null) return 0;
    return Math.max(0, Math.round((this._keyExpiresAt - Date.now()) / 1000));
  }

  private _resetKeyTimer(): void {
    this._clearKeyTimer();
    if (!this._privateKey) return;
    this._keyExpiresAt = Date.now() + this._keyTimeoutMs;
    this._keyTimer = setTimeout(() => {
      this._privateKey = null;
      this._keyExpiresAt = null;
      this._notify();
    }, this._keyTimeoutMs);
  }

  private _clearKeyTimer(): void {
    if (this._keyTimer !== null) {
      clearTimeout(this._keyTimer);
      this._keyTimer = null;
    }
    this._keyExpiresAt = null;
  }

  private _restore() {
    if (typeof sessionStorage === 'undefined') return;
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
          this.api.authenticated = true;
          // Restore expiry so timer survives page refreshes
          this.expiresAt = state.expiresAt ?? null;
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
    if (typeof sessionStorage === 'undefined') return;
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
    if (this.expiresAt === null) return 0;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, this.expiresAt - now);
  }

  /**
   * Parse the `exp` claim from a JWT and return the epoch seconds.
   * Returns null if the token is missing or malformed.
   */
  private _parseJwtExpiry(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1]));
      return payload.exp ?? null;
    } catch {
      return null;
    }
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
    this.api.authenticated = true;
    // Parse expiry from JWT token so the timer can show countdown
    this.expiresAt = this._parseJwtExpiry(opts.token);
    // Token is now in httpOnly cookie - don't store it in sessionStorage
    this._persist();
    this._notify();
  }

  getCachedPrivateKey(): PrivateKey | null {
    // Reset timer on activity — key is being used
    if (this._privateKey) this._resetKeyTimer();
    return this._privateKey;
  }

  setCachedPrivateKey(key: PrivateKey): void {
    this._privateKey = key;
    this._resetKeyTimer();
    this._notify();
  }

  clearPrivateKey(): void {
    this._privateKey = null;
    this._clearKeyTimer();
    this._notify();
  }

  clear() {
    this.fingerprint = null;
    this.token = null;
    this.api = null;
    this.expiresAt = null;
    this.publicKey = null;
    this._privateKey = null;
    this._clearKeyTimer();
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STORAGE_KEY);
    }
    this._notify();
  }

  getState(): SessionState {
    return {
      fingerprint: this.fingerprint,
      token: null, // Token is in cookie, not exposed to JS
      expiresAt: this.expiresAt, // Expiry is parsed from JWT
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
export { Session };
