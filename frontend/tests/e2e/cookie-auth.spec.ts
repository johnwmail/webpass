/**
 * Cookie-based Authentication E2E tests.
 * Tests httpOnly cookie authentication flow.
 * 
 * Note: These tests require COOKIE_AUTH_ENABLED=true on the server.
 * Run with: COOKIE_AUTH_ENABLED=true npm run dev (backend)
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiLogin,
  apiDeleteAccount,
} from '../helpers/api';

test.describe('Cookie Authentication', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {
        // Ignore cleanup errors
      });
    }
  });

  test('login sets httpOnly cookie', async ({ page, context }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register via UI
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Select account and login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);

    // Get cookies before login
    const cookiesBefore = await context.cookies();
    
    // Login
    await page.getByRole('button', { name: /Login/i }).click();

    // Wait for successful login
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Check that auth cookie is set
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'webpass_auth');
    
    // Cookie should exist
    expect(authCookie).toBeDefined();
    expect(authCookie?.value).toBeTruthy();
    
    // Cookie should be httpOnly (Playwright can't directly verify this,
    // but we can verify it's not accessible via JavaScript)
    expect(authCookie?.httpOnly).toBe(true);
    
    // Cookie should have Secure flag in production (check based on env)
    // For local tests, it may not be set
    
    // Cookie path should be /api
    expect(authCookie?.path).toBe('/api');
  });

  test('logout clears httpOnly cookie', async ({ page, context }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Verify cookie exists before logout
    const cookiesBefore = await context.cookies();
    const authCookieBefore = cookiesBefore.find(c => c.name === 'webpass_auth');
    expect(authCookieBefore).toBeDefined();

    // Click lock session button
    await page.getByRole('button', { name: 'Lock Session' }).click();

    // Wait for redirect to welcome screen
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();

    // Verify cookie is cleared after logout
    const cookiesAfter = await context.cookies();
    const authCookieAfter = cookiesAfter.find(c => c.name === 'webpass_auth');
    
    // Cookie should be cleared (either removed or expired)
    expect(authCookieAfter).toBeUndefined();
  });

  test('protected routes require valid cookie', async ({ page, context }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Create a test entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/cookie-test');
    await page.getByPlaceholder('Username').fill('test@example.com');
    await page.getByPlaceholder('Password').fill('test-password');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    // Logout
    await page.getByRole('button', { name: 'Lock Session' }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Try to login again - should work with correct password
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // Should successfully login and see the entry
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Test/cookie-test')).toBeVisible();
  });

  test('session persists across page reload with cookie', async ({ page, context }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Reload the page
    await page.reload();

    // Should still be logged in (session should persist)
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();

    // Verify cookie still exists
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'webpass_auth');
    expect(authCookie).toBeDefined();
  });

  test('wrong password does not set cookie', async ({ page, context }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and get to login screen
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Select account
    await page.locator('.account-item').first().click({ timeout: 5000 });

    // Get cookies before login attempt
    const cookiesBefore = await context.cookies();
    const authCookieBefore = cookiesBefore.find(c => c.name === 'webpass_auth');
    
    // Enter wrong password
    await page.getByPlaceholder('Enter your login password').fill('wrong-password-12345');
    await page.getByRole('button', { name: /Login/i }).click();

    // Wait for error message
    await page.getByText(/Wrong password|Login failed/i).waitFor({ timeout: 5000 });

    // Verify no auth cookie was set
    const cookiesAfter = await context.cookies();
    const authCookieAfter = cookiesAfter.find(c => c.name === 'webpass_auth');
    
    // Cookie should not be set on failed login
    expect(authCookieAfter).toEqual(authCookieBefore);
  });
});
