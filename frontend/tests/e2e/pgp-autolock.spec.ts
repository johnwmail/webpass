import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

test.describe('PGP Key Auto-Lock', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('auto-locks PGP key after timeout', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login via full UI flow
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    const regCodeField = page.getByPlaceholder('6-digit code from admin');
    if (await regCodeField.isVisible().catch(() => false)) {
      await regCodeField.fill((await testUser.registrationCode) || '');
    }
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

    // Login to the app
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Unlock|Login|Sign In/i }).click();
    await page.waitForTimeout(500);

    // Override auto-lock timeout to 5s BEFORE unlocking
    await page.evaluate(() => {
      (window as any).__webpass.session.setKeyTimeout(5);
    });

    // Click lock button to open unlock modal
    const header = page.locator('.app-header-right');
    await header.locator('button[title*="locked"]').click();

    // Enter PGP passphrase and unlock
    await page.getByPlaceholder('Enter your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();

    // Verify key is unlocked — countdown text (5s) should appear
    await expect(header.getByText(/^\d+s$/)).toBeVisible({ timeout: 3000 });

    // Wait for auto-lock (5s + buffer)
    await page.waitForTimeout(7000);

    // Verify key is locked — countdown gone, lock icon shown
    await expect(header.getByText(/^\d+s$/)).not.toBeVisible({ timeout: 3000 });
  });
});
