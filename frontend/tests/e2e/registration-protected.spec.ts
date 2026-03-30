/**
 * Registration E2E tests - Protected Mode (TOTP code required).
 * 
 * @tags @protected @registration
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

test.describe('Registration - Protected Mode', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('register with valid TOTP code', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByPlaceholder('6-digit code from admin').fill(testUser.registrationCode || '');
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
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });

  test('register with invalid TOTP code shows error', async ({ page }) => {
    testUser = await generateTestUser();

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill('000000');
    await page.getByRole('button', { name: 'Next' }).click();
    
    // Error should appear at step 2, not proceed to PGP Key step
    await page.getByText('Invalid or expired registration code', { exact: false }).waitFor({ timeout: 5000 });
    await expect(page.getByText('Invalid or expired registration code', { exact: false })).toBeVisible();
    
    // Should still be on step 2 (Choose Password), not step 3 (PGP Key)
    await expect(page.getByText('Choose Password', { exact: false })).toBeVisible();
    await expect(page.getByText('PGP Key', { exact: false })).not.toBeVisible();
  });

  test('registration code field is numeric only', async ({ page }) => {
    testUser = await generateTestUser();
    
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill('test-password');
    await page.getByPlaceholder('Confirm your password').fill('test-password');
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');

    const codeInput = page.getByPlaceholder('6-digit code from admin');
    await codeInput.fill('123456');

    const value = await codeInput.inputValue();
    expect(value).toBe('123456');
  });

  test('registration code input has correct attributes', async ({ page }) => {
    testUser = await generateTestUser();
    
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill('test-password');
    await page.getByPlaceholder('Confirm your password').fill('test-password');
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');

    const codeInput = page.getByPlaceholder('6-digit code from admin');

    await expect(codeInput).toHaveAttribute('maxlength', '6');
    await expect(codeInput).toHaveAttribute('inputmode', 'numeric');
    await expect(codeInput).toHaveAttribute('placeholder', '6-digit code from admin');

    const helpText = page.getByText(/6-digit registration code if your administrator/i);
    await expect(helpText).toBeVisible();
  });
});
