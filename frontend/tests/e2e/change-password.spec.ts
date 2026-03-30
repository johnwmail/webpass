/**
 * Change Password E2E tests.
 * Tests password change functionality with various scenarios.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount, apiLogin } from '../helpers/api';

/**
 * Helper function to register and login via UI
 * Returns the actual fingerprint (derived from PGP key)
 */
async function registerAndLogin(page: any, testUser: any): Promise<string> {
  const pgpPassphrase = `pgp-pass-${Date.now()}`;

  await page.goto('/');
  await page.getByRole('button', { name: /Get Started/i }).click();
  await page.waitForSelector('input[type="url"]', { timeout: 5000 });
  await page.getByRole('button', { name: /Next/i }).first().click();
  await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

  await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
  await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
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

  // Get the actual fingerprint from the account item
  const accountFpElement = page.locator('.account-item .fp').first();
  const accountFpText = await accountFpElement.textContent();
  const actualFingerprint = accountFpText?.replace(/\s/g, '') || '';

  // Login
  await page.locator('.account-item').first().click({ timeout: 5000 });
  await page.getByPlaceholder('Enter your login password').fill(testUser.password);
  await page.getByRole('button', { name: /Login/i }).click();
  await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

  return actualFingerprint;
}

/**
 * Helper function to open settings and navigate to password change
 */
async function openPasswordChange(page: any) {
  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /Change Password/i }).click();
}

test.describe('Change Password', () => {
  let testUser: TestUser;

  test.afterEach(async ({ page }) => {
    // Cleanup: Delete test account from server
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
    // Clear IndexedDB after each test
    await page.evaluate(async () => {
      indexedDB.deleteDatabase('webpass');
      localStorage.clear();
      sessionStorage.clear();
    });
  });

  test('change password - success and login with new password', async ({ page }) => {
    testUser = await generateTestUser();
    const newPassword = `newpass-${Date.now()}`;
    
    // Register and login, get the actual fingerprint
    const actualFingerprint = await registerAndLogin(page, testUser);

    // Open password change form
    await openPasswordChange(page);

    // Fill in password change form
    await page.getByPlaceholder('Enter current password').fill(testUser.password);
    await page.getByPlaceholder('Enter new password').fill(newPassword);
    await page.getByPlaceholder('Confirm new password').fill(newPassword);

    // Submit and wait for response
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for success message to appear
    await page.getByText(/Password changed successfully/i).waitFor({ timeout: 15000 });
    await expect(page.getByText(/Password changed successfully/i)).toBeVisible();

    // Wait for settings modal to close and redirect to welcome page
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Click on the first (and only) account - storage was cleared in beforeEach
    const accountItem = page.locator('.account-item').first();
    await accountItem.waitFor({ state: 'visible', timeout: 10000 });
    await accountItem.click({ timeout: 5000 });

    // Wait for password input to be visible AND enabled
    const passwordInput = page.getByPlaceholder('Enter your login password');
    await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
    await passwordInput.fill(newPassword);

    // Small delay to ensure input is registered
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /Login/i }).click();

    // Should be logged in - wait for main app to load
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 20000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('change password - wrong current password', async ({ page }) => {
    testUser = await generateTestUser();
    
    await registerAndLogin(page, testUser);

    // Open password change form
    await openPasswordChange(page);

    // Fill in wrong current password
    await page.getByPlaceholder('Enter current password').fill('wrong-password');
    await page.getByPlaceholder('Enter new password').fill('newpass123');
    await page.getByPlaceholder('Confirm new password').fill('newpass123');

    // Submit
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for error message
    await page.getByText(/invalid current password|Password change failed/i).waitFor({ timeout: 10000 });
    await expect(page.getByText(/invalid current password|Password change failed/i)).toBeVisible();

    // Should still be in settings
    await expect(page.getByText('Settings', { exact: false })).toBeVisible();
  });

  test('change password - mismatched confirmation', async ({ page }) => {
    testUser = await generateTestUser();
    
    await registerAndLogin(page, testUser);

    // Open password change form
    await openPasswordChange(page);

    // Fill in mismatched passwords
    await page.getByPlaceholder('Enter current password').fill(testUser.password);
    await page.getByPlaceholder('Enter new password').fill('newpass123');
    await page.getByPlaceholder('Confirm new password').fill('different-pass');

    // Submit
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for error message
    await page.getByText(/do not match/i).waitFor({ timeout: 5000 });
    await expect(page.getByText(/do not match/i)).toBeVisible();

    // Should still be in password change form
    await expect(page.getByPlaceholder('Enter new password')).toBeVisible();
  });

  test('change password - with 2FA enabled', async ({ page }) => {
    testUser = await generateTestUser();
    const newPassword = `newpass-2fa-${Date.now()}`;

    // Register and login, get the actual fingerprint
    const actualFingerprint = await registerAndLogin(page, testUser);

    // Setup 2FA from settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: /2FA/i }).click();
    await page.getByText('Two-Factor Authentication', { exact: false }).waitFor({ timeout: 10000 });

    // Extract TOTP secret
    const secretElement = page.locator('.totp-secret');
    await expect(secretElement).toBeVisible();
    const secretText = await secretElement.textContent();
    const totpSecret = secretText?.replace(/\s/g, '') || '';

    // Generate valid TOTP code
    const otpauth = await import('otpauth');
    const totp = new otpauth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: otpauth.Secret.fromBase32(totpSecret),
    });
    const totpCode = totp.generate();

    // Enter TOTP code
    await page.getByPlaceholder('6-digit code').fill(totpCode);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Wait for success
    await page.getByText(/2FA enabled/i).waitFor({ timeout: 10000 });

    // Close settings
    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(500);

    // Lock session
    await page.getByRole('button', { name: 'Lock Session' }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login with 2FA - click on the first (and only) account
    const accountItem = page.locator('.account-item').first();
    await accountItem.waitFor({ state: 'visible', timeout: 10000 });
    await accountItem.click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // Enter 2FA code
    const totpCode2 = totp.generate();
    await page.getByPlaceholder('6-digit code').fill(totpCode2);
    await page.getByRole('button', { name: /Verify/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Now change password
    await openPasswordChange(page);

    // Fill in password change form
    await page.getByPlaceholder('Enter current password').fill(testUser.password);
    await page.getByPlaceholder('Enter new password').fill(newPassword);
    await page.getByPlaceholder('Confirm new password').fill(newPassword);

    // Submit and wait for response
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for success message and modal to close
    await page.getByText(/Password changed successfully/i).waitFor({ timeout: 15000 });
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });
    
    // Wait for redirect to welcome page
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Click on the first (and only) account - storage was cleared in beforeEach
    const accountItem2 = page.locator('.account-item').first();
    await accountItem2.waitFor({ state: 'visible', timeout: 10000 });
    await accountItem2.click({ timeout: 5000 });

    // Wait for password input to be visible AND enabled
    const passwordInput = page.getByPlaceholder('Enter your login password');
    await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
    await passwordInput.fill(newPassword);

    // Small delay to ensure input is registered
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /Login/i }).click();

    // 2FA should still be required - wait for code input
    await page.getByPlaceholder('6-digit code').waitFor({ timeout: 15000 });

    // Enter 2FA code (generate fresh code right before use)
    const totpCode3 = totp.generate();
    await page.getByPlaceholder('6-digit code').fill(totpCode3);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Should be logged in - wait for main app
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 20000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('change password - can decrypt entries after password change', async ({ page }) => {
    testUser = await generateTestUser();
    const newPassword = `newpass-${Date.now()}`;
    const categoryName = `TestCategory-${Date.now()}`;
    const entryName = `test-entry-${Date.now()}`;
    const entryPassword = `secret-pass-${Date.now()}`;

    await registerAndLogin(page, testUser);

    // Create an entry BEFORE password change
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill(categoryName);
    await page.getByPlaceholder('Entry name').fill(entryName);
    await page.getByPlaceholder('Password').fill(entryPassword);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText(categoryName, { exact: false }).waitFor({ timeout: 30000 });

    // Click on category folder to expand
    await page.getByText(categoryName, { exact: false }).first().click();

    // Click on the entry
    await page.getByText(entryName, { exact: true }).click();

    // Entry detail panel should show
    await expect(page.getByRole('heading', { name: new RegExp(`${categoryName}.*${entryName}`, 'i') })).toBeVisible();

    // Open password change form
    await openPasswordChange(page);

    // Fill in password change form
    await page.getByPlaceholder('Enter current password').fill(testUser.password);
    await page.getByPlaceholder('Enter new password').fill(newPassword);
    await page.getByPlaceholder('Confirm new password').fill(newPassword);

    // Submit
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for success message
    await page.getByText(/Password changed successfully/i).waitFor({ timeout: 15000 });
    await expect(page.getByText(/Password changed successfully/i)).toBeVisible();

    // Wait for settings modal to close and redirect to welcome page
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Click on the first (and only) account
    const accountItem = page.locator('.account-item').first();
    await accountItem.waitFor({ state: 'visible', timeout: 10000 });
    await accountItem.click({ timeout: 5000 });

    // Wait for password input to be visible AND enabled
    const passwordInput = page.getByPlaceholder('Enter your login password');
    await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
    await passwordInput.fill(newPassword);

    // Small delay to ensure input is registered
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: /Login/i }).click();

    // Should be logged in - wait for main app to load
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 20000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();

    // CRITICAL: Verify the entry created BEFORE password change can still be decrypted
    // Click on category folder to expand
    await page.getByText(categoryName, { exact: false }).first().click();
    
    // Click on the entry
    await page.getByText(entryName, { exact: true }).click();
    
    // Entry detail panel should show - proving decryption works with new password
    await expect(page.getByRole('heading', { name: new RegExp(`${categoryName}.*${entryName}`, 'i') })).toBeVisible();
  });

  test('change password - session invalidated after change', async ({ page }) => {
    testUser = await generateTestUser();
    const newPassword = `newpass-session-${Date.now()}`;
    
    await registerAndLogin(page, testUser);

    // Create an entry to verify we're logged in
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('Entry name').fill('TestEntry');
    await page.getByPlaceholder('Password').fill('testpass');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('TestEntry', { exact: false }).waitFor({ timeout: 30000 });

    // Open password change form
    await openPasswordChange(page);

    // Fill in password change form
    await page.getByPlaceholder('Enter current password').fill(testUser.password);
    await page.getByPlaceholder('Enter new password').fill(newPassword);
    await page.getByPlaceholder('Confirm new password').fill(newPassword);

    // Submit
    await page.getByRole('button', { name: /Save New Password/i }).click();

    // Wait for success message
    await page.getByText(/Password changed successfully/i).waitFor({ timeout: 10000 });

    // Wait for redirect to welcome page (session cleared)
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Verify we need to login again (account should be listed but requires password)
    await expect(page.locator('.account-item')).toHaveCount(1);
    
    // Click account and verify password is required
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await expect(page.getByPlaceholder('Enter your login password')).toBeVisible();
  });
});
