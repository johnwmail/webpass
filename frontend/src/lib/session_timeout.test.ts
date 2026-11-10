// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Session } from './session';

describe('Session PGP key timeout from index.html meta tag', () => {
  it('uses pgp-key-timeout-seconds', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'pgp-key-timeout-seconds');
    meta.setAttribute('content', '45');
    document.head.appendChild(meta);
    try {
      const s = new Session();
      expect(s.keyTimeoutSeconds()).toBe(45);
    } finally {
      meta.remove();
    }
  });

  it('falls back to 30 seconds when the tag is absent', () => {
    const s = new Session();
    expect(s.keyTimeoutSeconds()).toBe(30);
  });
});
