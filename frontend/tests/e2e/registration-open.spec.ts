/**
 * Registration E2E tests - Open Mode (no TOTP code required).
 * 
 * Open Mode: REGISTRATION_ENABLED=true, REGISTRATION_TOTP_SECRET not set
 * Users can register without entering a TOTP code.
 * 
 * @tags @open @registration
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

test.describe('Registration - Open Mode', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('register without TOTP code', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    // Open mode: TOTP field is optional, leave it empty
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });

  test('register with empty TOTP field succeeds in open mode', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    // Leave TOTP field empty - should succeed in open mode
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });
});
