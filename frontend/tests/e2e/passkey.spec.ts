/**
 * Passkey / WebAuthn 2FA E2E test (Chromium virtual authenticator).
 */
import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

async function addVirtualAuthenticator(page: any) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable' as any);
  await client.send('WebAuthn.addVirtualAuthenticator' as any, {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  } as any);
}

async function registerAndLogin(page: any, testUser: TestUser, pgpPassphrase: string) {
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
}

test.describe('Passkeys (WebAuthn)', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('register a passkey and use it as second factor', async ({ page }) => {
    test.setTimeout(150000);
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await addVirtualAuthenticator(page);
    await registerAndLogin(page, testUser, pgpPassphrase);

    // Add a passkey from Settings.
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByRole('heading', { name: /Passkeys/i }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Required to add or remove passkeys').fill(testUser.password);
    await page.getByPlaceholder('e.g. iPhone').fill('Virtual Passkey');
    await page.getByRole('button', { name: /Add passkey/i }).click();
    await expect(page.getByText('Virtual Passkey')).toBeVisible({ timeout: 15000 });

    // Close Settings, then lock the session and log in again.
    await page.getByRole('button', { name: '✕' }).first().click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Lock Session/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    const passkeyButton = page.getByRole('button', { name: /Use Face ID \/ passkey/i });
    await passkeyButton.waitFor({ timeout: 10000 });
    await passkeyButton.click();

    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 15000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });
});
