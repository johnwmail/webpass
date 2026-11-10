import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Session, parseKeyTimeoutSeconds } from './session';

describe('Session PGP key auto-lock', () => {
  let s: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    s = new Session();
    s.setKeyTimeout(60); // 60s for deterministic tests
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 remaining when no key is cached', () => {
    expect(s.keyRemainingSeconds()).toBe(0);
  });

  it('returns >0 remaining after key is set', () => {
    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(60);
  });

  it('auto-locks key after timeout expires', () => {
    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(60);

    vi.advanceTimersByTime(60_000);

    expect(s.keyRemainingSeconds()).toBe(0);
  });

  it('resets timer on getCachedPrivateKey activity', () => {
    s.setCachedPrivateKey({} as any);
    vi.advanceTimersByTime(30_000); // half way
    expect(s.keyRemainingSeconds()).toBe(30);

    s.getCachedPrivateKey();
    expect(s.keyRemainingSeconds()).toBe(60); // reset

    vi.advanceTimersByTime(60_000);
    expect(s.keyRemainingSeconds()).toBe(0); // locked
  });

  it('clearPrivateKey stops timer immediately', () => {
    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(60);

    s.clearPrivateKey();
    expect(s.keyRemainingSeconds()).toBe(0);

    // Timer should not fire after clear
    vi.advanceTimersByTime(120_000);
    expect(s.keyRemainingSeconds()).toBe(0);
  });

  it('clear stops timer and resets state', () => {
    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(60);

    s.clear();
    expect(s.keyRemainingSeconds()).toBe(0);

    vi.advanceTimersByTime(120_000);
    expect(s.keyRemainingSeconds()).toBe(0);
  });

  it('notifies listeners on auto-lock', () => {
    const listener = vi.fn();
    s.subscribe(listener);

    s.setCachedPrivateKey({} as any);
    listener.mockClear();

    vi.advanceTimersByTime(60_000);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports setKeyTimeout override', () => {
    s.setKeyTimeout(30);
    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(30);

    vi.advanceTimersByTime(30_000);
    expect(s.keyRemainingSeconds()).toBe(0);
  });

  it('handles multiple set/reset cycles', () => {
    s.setCachedPrivateKey({} as any);
    vi.advanceTimersByTime(10_000);
    s.getCachedPrivateKey();
    vi.advanceTimersByTime(20_000);
    s.getCachedPrivateKey();
    vi.advanceTimersByTime(30_000);
    expect(s.keyRemainingSeconds()).toBe(30);

    s.clearPrivateKey();
    expect(s.keyRemainingSeconds()).toBe(0);

    s.setCachedPrivateKey({} as any);
    expect(s.keyRemainingSeconds()).toBe(60);
  });
});

describe('parseKeyTimeoutSeconds', () => {
  it('defaults to 30 seconds', () => {
    expect(parseKeyTimeoutSeconds(null)).toBe(30);
    expect(parseKeyTimeoutSeconds(undefined)).toBe(30);
    expect(parseKeyTimeoutSeconds('')).toBe(30);
    expect(parseKeyTimeoutSeconds('nope')).toBe(30);
    expect(parseKeyTimeoutSeconds('0')).toBe(0); // 0 disables caching
    expect(parseKeyTimeoutSeconds('-1')).toBe(30);
  });

  it('accepts configured values', () => {
    expect(parseKeyTimeoutSeconds('60')).toBe(60);
    expect(parseKeyTimeoutSeconds('300')).toBe(300);
  });

  it('clamps to the supported range', () => {
    expect(parseKeyTimeoutSeconds('1')).toBe(5);
    expect(parseKeyTimeoutSeconds('999999')).toBe(3600);
  });
});

describe('Session PGP key caching disabled', () => {
  let s: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    s = new Session();
    s.setKeyTimeout(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not retain the private key', () => {
    s.setCachedPrivateKey({} as any);
    expect(s.getCachedPrivateKey()).toBeNull();
    expect(s.keyRemainingSeconds()).toBe(0);
    expect(s.keyTimeoutSeconds()).toBe(0);
  });

  it('never exposes a cached key to later operations', () => {
    s.setCachedPrivateKey({} as any);
    vi.advanceTimersByTime(60_000);
    expect(s.getCachedPrivateKey()).toBeNull();
  });
});
