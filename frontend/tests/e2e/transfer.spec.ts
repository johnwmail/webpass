/**
 * Device-to-device encrypted PGP key transfer E2E test.
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

test.describe('Device transfer', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('transfer the encrypted key and restore it on a new device', async ({ page, browser }) => {
    test.setTimeout(240000);
    testUser = await generateTestUser();
    const pgpPassphrase = await registerAndLogin(page, testUser);
    const pairingCode = `pair-${Date.now()}`;

    // Create an entry that the new device must decrypt.
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('Transfer');
    await page.getByPlaceholder('Entry name').fill('secret');
    await page.getByPlaceholder('Password').fill('transfer-secret-123');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('Transfer', { exact: false }).waitFor({ timeout: 30000 });

    // Device A: create a transfer link.
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /Transfer to new device/i }).click();
    await page.getByPlaceholder('Enter a temporary pairing code').fill(pairingCode);
    await page.getByPlaceholder('Confirm the pairing code').fill(pairingCode);
    await page.getByRole('button', { name: /Create 15-minute link/i }).click();

    const linkInput = page.locator('.modal input[readonly]').last();
    await linkInput.waitFor({ timeout: 10000 });
    const link = await linkInput.inputValue();
    expect(link).toContain('#/transfer?');
    expect(link).toContain('t=');

    // Device B: fresh browser context (empty IndexedDB).
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    try {
      await pageB.goto(link);
      await pageB.getByRole('heading', { name: 'Restore Account' }).waitFor({ timeout: 15000 });
      await pageB.getByPlaceholder('Enter your login password').fill(testUser.password);
      await pageB.getByRole('button', { name: 'Continue' }).click();

      await pageB.getByPlaceholder('Enter the pairing code').waitFor({ timeout: 15000 });
      await pageB.getByPlaceholder('Enter the pairing code').fill(pairingCode);
      await pageB.getByRole('button', { name: 'Verify & request approval' }).click();

      // Device A must see the request (IP/UA) and explicitly approve it.
      await page.getByText('A new device is requesting your key').waitFor({ timeout: 20000 });
      await page.getByText(/127\.0\.0\.1|::1/).waitFor({ timeout: 10000 });
      await page.getByText(/HeadlessChrome|Mozilla/i).first().waitFor({ timeout: 10000 });
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeEnabled({ timeout: 20000 });
      await approve.click();

      await pageB.getByText('Select an entry or create a new one').waitFor({ timeout: 30000 });

      // The transferred key must decrypt the entry.
      await pageB.getByText('Transfer', { exact: false }).click();
      await pageB.getByText('secret', { exact: false }).click();
      await pageB.getByText('This entry is encrypted.').waitFor({ timeout: 10000 });
      await pageB.getByRole('button', { name: 'Decrypt', exact: true }).click();
      await pageB.getByPlaceholder('Enter your PGP passphrase').fill(pgpPassphrase);
      await pageB.getByRole('button', { name: 'Unlock', exact: true }).click();

      await pageB.getByTestId('password-toggle-btn').click();
      await expect(pageB.getByText('transfer-secret-123')).toBeVisible({ timeout: 10000 });
    } finally {
      await contextB.close();
    }
  });
});
