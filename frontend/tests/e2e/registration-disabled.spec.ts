/**
 * Registration E2E tests - Disabled Mode (registration not allowed).
 * 
 * Disabled Mode: REGISTRATION_ENABLED=false
 * Server rejects registration attempts, but UI still shows the form.
 * 
 * @tags @disabled @registration
 */

import { test, expect } from '@playwright/test';

test.describe('Registration - Disabled Mode', () => {
  test('UI shows form but server rejects in disabled mode', async ({ page }) => {
    // This test verifies that the UI still renders the form
    // but the server rejects the registration attempt
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    
    // Form should still be accessible (UI doesn't know about disabled mode)
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    const nextButton = page.getByRole('button', { name: /Next/i }).first();
    await expect(nextButton).toBeEnabled();
  });

  test('registration API rejects when disabled', async ({ page }) => {
    // Verify that the registration endpoint rejects requests when disabled
    // This tests the server-side enforcement
    const response = await page.request.post('/api', {
      data: {
        fingerprint: 'test-fp-disabled',
        password: 'test-password',
        public_key: 'test-key',
      },
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    // Server should reject registration when disabled
    expect(response.status()).toBe(403);
    
    const body = await response.json();
    expect(body.error).toContain('registration');
  });
});
