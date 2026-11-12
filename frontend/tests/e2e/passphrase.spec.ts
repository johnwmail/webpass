/**
 * Change PGP passphrase E2E test.
 */
import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

async function registerAndLogin(page: any, testUser: TestUser) {
  const pgpPassphrase = `pgp-pass-${Date.now()}`;

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

  await page.locator('.account-item').first().click({ timeout: 5000 });
  await page.getByPlaceholder('Enter your login password').fill(testUser.password);
  await page.getByRole('button', { name: /Login/i }).click();
  await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

  return pgpPassphrase;
}

test.describe('Change PGP passphrase', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('changes the passphrase and unlocks with the new one', async ({ page }) => {
    test.setTimeout(180000);
    testUser = await generateTestUser();
    const oldPassphrase = await registerAndLogin(page, testUser);
    const newPassphrase = `new-pgp-pass-${Date.now()}`;

    // Create an entry that must still decrypt after the passphrase change.
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('Passphrase');
    await page.getByPlaceholder('Entry name').fill('secret');
    await page.getByPlaceholder('Password').fill('passphrase-secret-123');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('Passphrase', { exact: false }).waitFor({ timeout: 30000 });

    // Change the PGP passphrase from Settings.
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByRole('heading', { name: 'PGP Key Management' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /Change PGP Passphrase/i }).click();
    await page.getByPlaceholder('Enter current PGP passphrase').fill(oldPassphrase);
    await page.getByPlaceholder('Enter new PGP passphrase (12+ characters)').fill(newPassphrase);
    await page.getByPlaceholder('Confirm new PGP passphrase').fill(newPassphrase);
    await page.getByRole('button', { name: /Change Passphrase/i }).click();
    await page.getByText(/PGP passphrase changed/i).waitFor({ timeout: 15000 });

    // Close Settings. The key should now be locked.
    await page.getByRole('button', { name: '✕' }).first().click();
    const unlockButton = page.getByTitle(/PGP key locked/i);
    await unlockButton.waitFor({ timeout: 10000 });
    await unlockButton.click();

    // The old passphrase must fail; the new one must work.
    await page.getByPlaceholder('Enter your PGP passphrase').fill(oldPassphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    const unlockError = page.locator('.modal .error-msg');
    await unlockError.waitFor({ timeout: 10000 });
    await expect(unlockError).toContainText(/decrypt|passphrase|unlock/i);

    await page.getByPlaceholder('Enter your PGP passphrase').fill(newPassphrase);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await page.getByTitle(/PGP key unlocked/i).waitFor({ timeout: 15000 });

    // The entry must still decrypt with the same key.
    await page.getByText('Passphrase', { exact: false }).click();
    await page.getByText('secret', { exact: false }).click();
    await page.getByTestId('password-toggle-btn').click();
    await expect(page.getByText('passphrase-secret-123')).toBeVisible({ timeout: 15000 });
  });
});
