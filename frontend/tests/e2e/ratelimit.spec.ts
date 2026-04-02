/**
 * Rate Limiting E2E tests.
 * Tests rate limiting on authentication endpoints to protect against brute-force attacks.
 */

import { test, expect } from '@playwright/test';
import { apiDeleteAccount, type TestUser } from '../helpers/api';
import { generateTestUser } from '../helpers/test-data';

test.describe('Rate Limiting', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {
        // Ignore cleanup errors
      });
    }
  });

  test('should rate limit login attempts via API', async ({ request }) => {
    // Create a test user via API first
    const user = await generateTestUser();
    testUser = user;

    const baseURL = process.env.TEST_BASE_URL || 'http://localhost:8080';

    // Make 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      const response = await request.post(`${baseURL}/api/${user.fingerprint}/login`, {
        data: { password: 'wrong-password' },
      });
      // Should get 401 (invalid credentials), not 429
      expect(response.status()).toBe(401);
    }

    // The 6th attempt should be rate limited (429)
    const response = await request.post(`${baseURL}/api/${user.fingerprint}/login`, {
      data: { password: 'wrong-password' },
    });
    expect(response.status()).toBe(429);

    const text = await response.text();
    expect(text.toLowerCase()).toMatch(/too many attempts|rate limit|try again later/i);
  });

  test('should rate limit registration attempts via API', async ({ request }) => {
    const baseURL = process.env.TEST_BASE_URL || 'http://localhost:8080';

    // Make 5 registration attempts
    for (let i = 0; i < 5; i++) {
      const user = await generateTestUser();
      const response = await request.post(`${baseURL}/api`, {
        data: {
          password: user.password,
          public_key: user.publicKey,
          fingerprint: user.fingerprint,
        },
        headers: {
          'X-Registration-Code': user.registrationCode || '',
        },
      });
      // Should succeed (201) or fail for other reasons, but not 429 yet
      expect(response.status()).not.toBe(429);
    }

    // The 6th registration should be rate limited
    const user = await generateTestUser();
    const response = await request.post(`${baseURL}/api`, {
      data: {
        password: user.password,
        public_key: user.publicKey,
        fingerprint: user.fingerprint,
      },
      headers: {
        'X-Registration-Code': user.registrationCode || '',
      },
    });
    expect(response.status()).toBe(429);

    const text = await response.text();
    expect(text.toLowerCase()).toMatch(/too many attempts|rate limit|try again later/i);
  });

  test('should show user-friendly error message when rate limited', async ({ request }) => {
    const user = await generateTestUser();
    testUser = user;
    const baseURL = process.env.TEST_BASE_URL || 'http://localhost:8080';

    // Exhaust the rate limit
    for (let i = 0; i < 5; i++) {
      await request.post(`${baseURL}/api/${user.fingerprint}/login`, {
        data: { password: 'wrong-password' },
      });
    }

    // Get the rate limit error
    const response = await request.post(`${baseURL}/api/${user.fingerprint}/login`, {
      data: { password: 'wrong-password' },
    });
    expect(response.status()).toBe(429);

    const text = await response.text();
    // Should be user-friendly, not technical
    expect(text.toLowerCase()).toMatch(/too many attempts|rate limit|try again later/i);
    // Should NOT contain technical details
    expect(text.toLowerCase()).not.toContain('429');
    expect(text.toLowerCase()).not.toContain('statustoomanyrequests');
  });
});
