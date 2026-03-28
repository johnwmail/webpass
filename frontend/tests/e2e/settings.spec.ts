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

  test('import entries', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
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

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click import button
    await page.getByRole('button', { name: /Import.*password|Import.*store/i }).click();

    // Import dialog should appear
    await page.getByText('Import Password Store', { exact: false }).waitFor({ timeout: 5000 });
    await expect(page.getByText('Import Password Store', { exact: false })).toBeVisible();

    // Verify file inputs are present
    await expect(page.locator('input[type="file"][accept=".tar.gz,.tgz,.tar"]')).toBeVisible();
    await expect(page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]')).toBeVisible();
    await expect(page.getByPlaceholder('Enter private key passphrase')).toBeVisible();

    // Close import dialog by clicking on the overlay (outside the modal)
    await page.locator('.modal-overlay').first().click({ position: { x: 50, y: 50 } });
    await page.waitForTimeout(500); // Wait for animation
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
    const secretElement = page.locator('.totp-secret');
    const secretText = await secretElement.textContent();
    expect(secretText).toBeTruthy();
    expect(secretText!.length).toBeGreaterThan(10);

    // Extract the TOTP secret (remove spaces)
    const totpSecret = secretText?.replace(/\s/g, '') || '';

    // Generate a valid TOTP code using the secret
    const otpauth = await import('otpauth');
    const totp = new otpauth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: otpauth.Secret.fromBase32(totpSecret),
    });
    const totpCode = totp.generate();

    // Enter the TOTP code
    await page.getByPlaceholder('6-digit code').fill(totpCode);

    // Click verify button
    await page.getByRole('button', { name: /Verify/i }).click();

    // Wait for success message
    await page.getByText(/2FA enabled|Two-factor authentication enabled/i).waitFor({ timeout: 10000 });

    // Close settings
    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);

    // Lock session to test 2FA login
    await page.getByRole('button', { name: 'Lock Session' }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login with password
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // 2FA code input should appear
    await page.getByPlaceholder('6-digit code').waitFor({ timeout: 5000 });

    // Generate a new TOTP code
    const totpCode2 = totp.generate();

    // Enter TOTP code
    await page.getByPlaceholder('6-digit code').fill(totpCode2);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Should login successfully
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('clear local data - cancel', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Scroll to danger zone using heading
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();

    // Click clear local data button
    await page.getByRole('button', { name: /Clear Local Data/i }).click();

    // Passphrase prompt dialog should appear
    await page.getByText('Enter your PGP passphrase', { exact: false }).waitFor({ timeout: 10000 });

    // Click the first cancel button (in the passphrase prompt)
    await page.getByRole('button', { name: 'Cancel' }).first().click();

    // Modal should still be open
    await expect(page.getByText('Settings', { exact: false })).toBeVisible();
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

  test('edit account name', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Account Name should show "Not set" initially
    await expect(page.getByText('Account Name')).toBeVisible();
    await expect(page.getByText('Not set')).toBeVisible();

    // Click edit button (pencil icon)
    await page.getByRole('button', { name: /Edit account name/i }).click();

    // Input field should appear
    const input = page.getByPlaceholder('Enter account name');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();

    // Enter account name
    await input.fill('test-account@example.com');

    // Click save button (checkmark)
    await page.getByRole('button', { name: '✓' }).click();

    // Wait for success message
    await page.getByText('Account name updated').waitFor({ timeout: 5000 });

    // Account name should be updated
    await expect(page.getByText('test-account@example.com')).toBeVisible();

    // Close and reopen settings to verify persistence
    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });

    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Verify account name persists
    await expect(page.getByText('test-account@example.com')).toBeVisible();
  });

  test('edit account name - cancel with escape key', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click edit button
    await page.getByRole('button', { name: /Edit account name/i }).click();

    // Enter account name
    const input = page.getByPlaceholder('Enter account name');
    await expect(input).toBeVisible();
    await input.fill('should-not-save@example.com');

    // Press Escape to cancel
    await input.press('Escape');

    // Input should be hidden, original value (Not set) should show
    await expect(input).not.toBeVisible();
    await expect(page.getByText('Not set')).toBeVisible();
  });

  test('edit account name - cancel with X button', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click edit button
    await page.getByRole('button', { name: /Edit account name/i }).click();

    // Enter account name
    const input = page.getByPlaceholder('Enter account name');
    await expect(input).toBeVisible();
    await input.fill('should-not-save-2@example.com');

    // Click X button to cancel
    await page.getByRole('button', { name: '✕' }).nth(1).click();

    // Input should be hidden, original value should show
    await expect(input).not.toBeVisible();
    await expect(page.getByText('Not set')).toBeVisible();
  });

  test('edit account name - save with enter key', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Click edit button
    await page.getByRole('button', { name: /Edit account name/i }).click();

    // Enter account name
    const input = page.getByPlaceholder('Enter account name');
    await expect(input).toBeVisible();
    await input.fill('keyboard-user@example.com');

    // Press Enter to save
    await input.press('Enter');

    // Wait for success message
    await page.getByText('Account name updated').waitFor({ timeout: 5000 });

    // Account name should be updated
    await expect(page.getByText('keyboard-user@example.com')).toBeVisible();
  });

  test('edit existing account name', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register with account name
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Enter account name and password
    await page.getByPlaceholder('e.g., Personal, Work, etc.').fill('original-name@example.com');
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
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

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Verify original account name is displayed
    await expect(page.getByText('original-name@example.com')).toBeVisible();

    // Click edit button
    await page.getByRole('button', { name: /Edit account name/i }).click();

    // Change account name
    const input = page.getByPlaceholder('Enter account name');
    await expect(input).toBeVisible();
    await input.fill('updated-name@example.com');

    // Click save
    await page.getByRole('button', { name: '✓' }).click();

    // Wait for success message
    await page.getByText('Account name updated').waitFor({ timeout: 5000 });

    // Account name should be updated
    await expect(page.getByText('updated-name@example.com')).toBeVisible();
  });

  test('clear local data only', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
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

    // Verify account is listed
    await expect(page.locator('.account-item')).toHaveCount(1);

    // Login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Scroll to danger zone
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();

    // Click clear local data button
    await page.getByRole('button', { name: /Clear Local Data/i }).click();

    // Passphrase prompt dialog should appear
    await page.getByText('Enter your PGP passphrase', { exact: false }).waitFor({ timeout: 10000 });

    // Enter the PGP passphrase
    await page.getByPlaceholder('Enter your PGP passphrase').fill(pgpPassphrase);

    // Click confirm button
    await page.getByRole('button', { name: /Confirm/i }).last().click();

    // Wait for success message and redirect to welcome page
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Account should no longer be listed (local data cleared)
    await expect(page.locator('.account-item')).toHaveCount(0);
  });

  test('full account deletion', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
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

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 10000 });

    // Scroll to danger zone
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();

    // Click delete account button
    await page.getByRole('button', { name: /Permanently Delete Account/i }).click();

    // Passphrase prompt dialog should appear
    await page.getByText('Enter your PGP passphrase', { exact: false }).waitFor({ timeout: 10000 });

    // Enter the PGP passphrase
    await page.getByPlaceholder('Enter your PGP passphrase').fill(pgpPassphrase);

    // Click confirm delete button
    await page.getByRole('button', { name: /Confirm|Delete/i }).last().click();

    // Wait for confirmation message and redirect to welcome/setup page
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Account should no longer be listed
    await expect(page.locator('.account-item')).toHaveCount(0);
  });
});
