import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

test.describe('PGP Key Auto-Decrypt', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('entry auto-decrypts when PGP key is already unlocked', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Register and login via full UI flow
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin (required)').fill((await testUser.registrationCode) || '').catch(() => {});
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
    await page.getByRole('button', { name: /Unlock|Login|Sign In/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);

    // Create first entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('AutoDecrypt');
    await page.getByPlaceholder('Entry name').fill('entry-one');
    await page.getByPlaceholder('Password').fill('password1');
    await page.getByPlaceholder('Additional notes, username, URLs...').fill('Notes for entry one');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('AutoDecrypt', { exact: false }).waitFor({ timeout: 30000 });

    // Create second entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('AutoDecrypt');
    await page.getByPlaceholder('Entry name').fill('entry-two');
    await page.getByPlaceholder('Password').fill('password2');
    await page.getByPlaceholder('Additional notes, username, URLs...').fill('Notes for entry two');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('AutoDecrypt', { exact: false }).waitFor({ timeout: 30000 });

    // Expand folder, then click entry-one
    await page.getByText('AutoDecrypt', { exact: false }).first().click();
    await page.getByText('entry-one', { exact: true }).waitFor({ timeout: 5000 });

    // Click on entry-one to view details
    await page.getByText('entry-one', { exact: true }).click();

    // Decrypt entry-one (this caches the PGP key)
    const decryptBtn = page.getByRole('button', { name: 'Decrypt', exact: true });
    await decryptBtn.waitFor({ state: 'visible', timeout: 10000 });
    await decryptBtn.click();
    const passphraseInput = page.getByPlaceholder('Enter your PGP passphrase');
    await passphraseInput.waitFor({ state: 'visible', timeout: 5000 });
    await passphraseInput.fill(pgpPassphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.locator('.password-display').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);

    // Click on entry-two — PGP key is cached, so it should auto-decrypt
    await page.getByText('entry-two', { exact: true }).click();

    // No Decrypt button should appear
    await expect(page.getByRole('button', { name: 'Decrypt', exact: true })).not.toBeVisible({ timeout: 10000 });

    // Password display should render with masked content
    const passwordDisplay = page.locator('.password-display').first();
    await expect(passwordDisplay).toBeVisible({ timeout: 10000 });

    // Click eye to reveal and verify correct password
    await page.getByTestId('password-toggle-btn').click();
    await page.waitForTimeout(300);
    const revealedText = await passwordDisplay.textContent();
    expect(revealedText).toContain('password2');

    // Notes should also be visible
    const notesToggle = page.getByTestId('notes-toggle-btn');
    await expect(notesToggle).toBeVisible({ timeout: 5000 });
  });
});
