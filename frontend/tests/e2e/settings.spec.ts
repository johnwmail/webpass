/**
 * Settings E2E tests.
 * Tests account management, 2FA, export/import, and delete account flows.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser, createTarGz } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiLogin,
  apiDeleteAccount,
  apiCreateEntry,
  apiExport,
  apiImport,
  apiListEntries,
} from '../helpers/api';

/**
 * Helper function to register and login via UI
 */
async function registerAndLogin(page: any, testUserData: any) {
  const pgpPassphrase = `pgp-pass-${Date.now()}`;

  await page.goto('/');
  await page.getByRole('button', { name: /Get Started/i }).click();
  await page.waitForSelector('input[type="url"]', { timeout: 5000 });
  await page.getByRole('button', { name: /Next/i }).first().click();
  await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

  await page.getByPlaceholder('Choose a strong password').fill(testUserData.password);
  await page.getByPlaceholder('Confirm your password').fill(testUserData.password);
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
  await page.getByPlaceholder('Enter your login password').fill(testUserData.password);
  await page.getByRole('button', { name: /Login/i }).click();
  await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
}

test.describe('Settings', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('open settings modal', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Click settings button
    await page.getByRole('button', { name: /Settings/i }).click();

    // Wait for settings modal
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
    await expect(page.getByText('Settings', { exact: false })).toBeVisible();
  });

  test('export entries', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Create some entries via UI
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('ExportTest');
    await page.getByPlaceholder('Entry name').fill('test-entry');
    await page.getByPlaceholder('Password').fill('testpass123');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('ExportTest', { exact: false }).waitFor({ timeout: 30000 });

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click export entries button (nth(2) is the export all entries button)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export/i }).nth(2).click(),
    ]);

    // Verify download
    expect(download.suggestedFilename()).toMatch(/.*\.tar\.gz/);

    // Download the file
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
  });

  test('export private key', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });

    // Look for export private key button
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export.*Private|Private.*Key/i }).click(),
    ]);

    // Verify download
    expect(download.suggestedFilename()).toMatch(/.*private.*\.asc/);
  });

  test('export public key', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });

    // Look for export public key button
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export.*Public|Public.*Key/i }).click(),
    ]);

    // Verify download
    expect(download.suggestedFilename()).toMatch(/.*public.*\.asc/);
  });

  test('setup 2FA from settings', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click enable 2FA button
    await page.getByRole('button', { name: /2FA/i }).click();

    // Wait for 2FA setup dialog
    await page.getByText('Two-Factor Authentication', { exact: false }).waitFor({ timeout: 10000 });

    // QR code should be visible
    await expect(page.locator('canvas')).toBeVisible();

    // Secret should be displayed
    const secretText = await page.locator('.totp-secret').textContent();
    expect(secretText).toBeTruthy();
    expect(secretText!.length).toBeGreaterThan(10);
  });

  test('delete account - cancel', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Scroll to danger zone using heading
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();

    // Click delete account button
    await page.getByRole('button', { name: /Permanently Delete Account/i }).click();

    // Passphrase prompt dialog should appear
    await page.getByText('Enter your PGP passphrase', { exact: false }).waitFor({ timeout: 10000 });

    // Click the first cancel button (in the passphrase prompt)
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    // Modal should still be open
    await expect(page.getByText('Settings', { exact: false })).toBeVisible();
  });

  test('version information displayed', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Version heading should be visible
    await expect(page.getByRole('heading', { name: 'Version' })).toBeVisible();
  });

  test('logout from settings', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Close settings modal by clicking the X button
    await page.getByRole('button', { name: '✕' }).click();
    
    // Wait for modal to close
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });

    // Now click lock session button in the main header
    await page.getByRole('button', { name: 'Lock Session' }).click();

    // Should redirect to welcome screen
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });

  test('git sync button visible', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });

    // Git sync button should be visible
    await expect(page.getByRole('button', { name: /Git.*Sync|Sync.*Git/i })).toBeVisible();
  });
});
