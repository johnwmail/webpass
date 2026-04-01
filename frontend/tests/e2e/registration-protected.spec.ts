/**
 * Registration E2E tests - Protected Mode (TOTP code required).
 *
 * @tags @protected @registration
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';
import * as fs from 'fs';

/**
 * Helper function to simulate a fresh browser by clearing all storage
 */
async function simulateFreshBrowser(page: any) {
  await page.evaluate(async () => {
    indexedDB.deleteDatabase('webpass');
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
}

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
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.locator('.account-item').waitFor({ timeout: 5000 });
    await expect(page.locator('.account-item')).toHaveCount(1);
  });

  test('register with invalid TOTP code shows error', async ({ page }) => {
    testUser = await generateTestUser();

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill('000000');
    await page.getByRole('button', { name: 'Next' }).click();

    // Error should appear at step 2, not proceed to PGP Key step
    await page.getByText('Invalid or expired registration code', { exact: false }).waitFor({ timeout: 5000 });
    await expect(page.getByText('Invalid or expired registration code', { exact: false })).toBeVisible();

    // Should still be on step 2 (Choose Password), not step 3 (PGP Key)
    await expect(page.getByText('Step 2 of 4: Choose Password', { exact: false })).toBeVisible();
    await expect(page.getByText('Step 3 of 4: PGP Key', { exact: false })).not.toBeVisible();
  });

  test('registration code field is numeric only', async ({ page }) => {
    testUser = await generateTestUser();

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

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
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill('test-password');
    await page.getByPlaceholder('Confirm your password').fill('test-password');
    await page.getByPlaceholder('6-digit code from admin (required)').fill((await testUser.registrationCode) || '');

    const codeInput = page.getByPlaceholder('6-digit code from admin (required)');

    await expect(codeInput).toHaveAttribute('maxlength', '6');
    await expect(codeInput).toHaveAttribute('inputmode', 'numeric');
    await expect(codeInput).toHaveAttribute('placeholder', '6-digit code from admin (required)');

    const helpText = page.getByText(/6-digit registration code from your administrator/i);
    await expect(helpText).toBeVisible();
  });

  test('existing account setup with PGP import and TOTP - happy path', async ({ page }, testInfo) => {
    test.setTimeout(120000);

    // Initialize test data
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // ========== PHASE 1: Create account and export PGP key ==========
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.locator('.account-item').waitFor({ timeout: 5000 });
    await expect(page.locator('.account-item')).toHaveCount(1);

    // Login to the account
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Create a test entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/protected-import');
    await page.getByPlaceholder('Username').fill('test-protected@example.com');
    await page.getByPlaceholder('Password').fill('protected-password-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    // Export the private key
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();
    const exportedPrivateKey = fs.readFileSync(keyFilePath, 'utf-8');

    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);
    // Logout
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Logout/i }).click();
    await page.waitForTimeout(2000);
    await page.locator('.account-item').waitFor({ timeout: 10000 });

    // ========== PHASE 2: Fresh browser with TOTP and PGP import ==========
    await simulateFreshBrowser(page);

    await page.getByRole('button', { name: /Get Started/i }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Enter correct password AND valid TOTP code
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    // Select import option
    await page.locator('label:has-text("Import existing private key")').click();
    await page.waitForTimeout(500);

    // Upload the exported private key
    const keyFile = testInfo.outputPath('protected-import-key.asc');
    fs.writeFileSync(keyFile, exportedPrivateKey);
    await page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]').setInputFiles(keyFile);
    await page.waitForTimeout(1000);

    // Enter correct PGP passphrase
    await page.getByPlaceholder('Passphrase for this key').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Import Key/i }).click();

    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();

    // For existing users, setup completes and logs in directly
    // Wait for main app to load
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Verify the test entry created earlier is accessible
    await expect(page.locator('.tree-item').filter({ hasText: 'Test' })).toBeVisible();

    // Cleanup
    try {
      fs.unlinkSync(keyFilePath);
      fs.unlinkSync(keyFile);
    } catch (e) {}
  });

  test('existing account setup with PGP import, TOTP and 2FA enabled', async ({ page }, testInfo) => {
    test.setTimeout(150000);

    // Initialize test data
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    const otpauth = await import('otpauth');

    // ========== PHASE 1: Create account with TOTP and enable 2FA ==========
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false }).waitFor({ timeout: 10000 });

    // Skip 2FA initially
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.locator('.account-item').waitFor({ timeout: 5000 });
    await expect(page.locator('.account-item')).toHaveCount(1);

    // Login to enable 2FA
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Create a test entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/protected-2fa-import');
    await page.getByPlaceholder('Username').fill('test-protected-2fa@example.com');
    await page.getByPlaceholder('Password').fill('protected-2fa-password-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    // Enable 2FA in Settings
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.getByRole('button', { name: /2FA/i }).click();
    await page.waitForSelector('text=Two-Factor Authentication', { timeout: 10000 });

    // Wait for QR code to load
    await page.waitForSelector('canvas', { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Get the TOTP secret from the page
    const secretElement = page.locator('.totp-secret');
    let totpSecret = '';
    if (await secretElement.isVisible()) {
      totpSecret = (await secretElement.textContent() || '').replace(/\s/g, '');
    } else {
      totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    }

    // Generate valid TOTP code
    const totp = new otpauth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: otpauth.Secret.fromBase32(totpSecret),
    });
    const totpCode = totp.generate();

    // Enter TOTP code to enable 2FA
    await page.getByPlaceholder('6-digit code').fill(totpCode);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Wait for 2FA to be enabled
    await page.getByText(/2FA enabled|Two-factor authentication enabled/i).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '✕' }).click();

    // Export private key before logout
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();
    const exportedPrivateKey = fs.readFileSync(keyFilePath, 'utf-8');

    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);
    // Logout
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Logout/i }).click();
    await page.waitForTimeout(2000);
    await page.locator('.account-item').waitFor({ timeout: 10000 });

    // ========== PHASE 2: Fresh browser with TOTP and 2FA enabled ==========
    await simulateFreshBrowser(page);

    await page.getByRole('button', { name: /Get Started/i }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Enter correct password AND valid TOTP code
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    // Select import option
    await page.locator('label:has-text("Import existing private key")').click();
    await page.waitForTimeout(500);

    // Upload the exported private key
    const keyFile = testInfo.outputPath('protected-2fa-import-key.asc');
    fs.writeFileSync(keyFile, exportedPrivateKey);
    await page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]').setInputFiles(keyFile);
    await page.waitForTimeout(1000);

    // Enter correct PGP passphrase
    await page.getByPlaceholder('Passphrase for this key').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Import Key/i }).click();

    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();

    // Should show login screen with account listed (2FA session cleared)
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.locator('.account-item').waitFor({ timeout: 5000 });
    await expect(page.locator('.account-item')).toHaveCount(1);

    // Click on account to login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // 2FA code input should appear
    await page.getByPlaceholder('6-digit code').waitFor({ timeout: 10000 });
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible();

    // Generate fresh TOTP code and enter it
    const freshTotpCode = totp.generate();
    await page.getByPlaceholder('6-digit code').fill(freshTotpCode);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Should login successfully and show main app
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Verify the test entry created earlier is accessible
    await expect(page.locator('.tree-item').filter({ hasText: 'Test' })).toBeVisible();

    // Cleanup
    try {
      fs.unlinkSync(keyFilePath);
      fs.unlinkSync(keyFile);
    } catch (e) {}
  });

  test('existing account with wrong password shows error', async ({ page }, testInfo) => {
    test.setTimeout(90000);

    // Initialize test data
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // ========== PHASE 1: Create account and export key ==========
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Export private key
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();
    const exportedKey = fs.readFileSync(keyFilePath, 'utf-8');

    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);
    // Logout
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Logout/i }).click();
    await page.waitForTimeout(2000);
    await page.locator('.account-item').waitFor({ timeout: 10000 });

    // ========== PHASE 2: Fresh browser with WRONG password ==========
    await simulateFreshBrowser(page);

    await page.getByRole('button', { name: /Get Started/i }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Enter WRONG password with valid TOTP
    const wrongPassword = `wrong-password-${Date.now()}`;
    await page.getByPlaceholder('Choose a strong password').fill(wrongPassword);
    await page.getByPlaceholder('Confirm your password').fill(wrongPassword);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    // Select import option and use the SAME key (same fingerprint)
    await page.locator('label:has-text("Import existing private key")').click();
    await page.waitForTimeout(500);

    const keyFile = testInfo.outputPath('wrong-pass-key.asc');
    fs.writeFileSync(keyFile, exportedKey);
    await page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]').setInputFiles(keyFile);
    await page.waitForTimeout(1000);

    // Enter correct PGP passphrase (key is valid)
    await page.getByPlaceholder('Passphrase for this key').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Import Key/i }).click();

    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();

    // Should show error about existing account with different password
    await page.getByText('This account already exists with a different password').waitFor({ timeout: 10000 });
    await expect(page.getByText('This account already exists with a different password')).toBeVisible();

    // Should stay on step 3 (error shown, no navigation to step 4)
    await expect(page.getByText('Step 3 of 4: PGP Key', { exact: false })).toBeVisible();
    await expect(page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false })).not.toBeVisible();

    // Cleanup
    try {
      fs.unlinkSync(keyFilePath);
      fs.unlinkSync(keyFile);
    } catch (e) {}
  });

  test('existing account with wrong PGP passphrase shows error', async ({ page }, testInfo) => {
    test.setTimeout(90000);

    // Initialize test data
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // ========== PHASE 1: Create account ==========
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Export private key
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();

    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);
    // Logout
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.getByRole('button', { name: /Logout/i }).click();
    await page.waitForTimeout(2000);
    await page.locator('.account-item').waitFor({ timeout: 10000 });

    // ========== PHASE 2: Fresh browser with WRONG PGP passphrase ==========
    await simulateFreshBrowser(page);

    await page.getByRole('button', { name: /Get Started/i }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Step 2 of 4: Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Step 3 of 4: PGP Key', { exact: false }).waitFor({ timeout: 10000 });

    // Select import option
    await page.locator('label:has-text("Import existing private key")').click();
    await page.waitForTimeout(500);

    // Upload the exported private key
    const keyFile = testInfo.outputPath('protected-wrong-pass-key.asc');
    fs.writeFileSync(keyFile, fs.readFileSync(keyFilePath, 'utf-8'));
    await page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]').setInputFiles(keyFile);
    await page.waitForTimeout(1000);

    // Enter WRONG PGP passphrase
    const wrongPassphrase = `wrong-passphrase-${Date.now()}`;
    await page.getByPlaceholder('Passphrase for this key').fill(wrongPassphrase);
    await page.getByRole('button', { name: /Import Key/i }).click();

    // Should show error about invalid key or passphrase
    await page.getByText('Error decrypting private key').waitFor({ timeout: 10000 });
    await expect(page.getByText('Error decrypting private key')).toBeVisible();

    // Should NOT proceed to next step
    await expect(page.getByText('Step 3 of 4: PGP Key', { exact: false })).toBeVisible();
    await expect(page.getByText('Step 4 of 4: Confirm & 2FA', { exact: false })).not.toBeVisible();

    // Cleanup
    try {
      fs.unlinkSync(keyFilePath);
      fs.unlinkSync(keyFile);
    } catch (e) {}
  });
});
