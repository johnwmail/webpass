/**
 * Authentication E2E tests.
 * Tests user registration, login, 2FA setup, and logout flows.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiLogin,
  apiDeleteAccount,
  apiSetupTOTP,
  apiConfirmTOTP,
} from '../helpers/api';
import { execSync } from 'child_process';
import * as fs from 'fs';

test.describe('Authentication', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {
        // Ignore cleanup errors
      });
    }
  });

  test('register new user', async ({ page }) => {
    testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Go to the app
    await page.goto('/');

    // Click "Get Started" or "Setup" button
    await page.getByRole('button', { name: /Get Started|Setup/i }).click();

    // Step 1: API Server - use default URL, click Next
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Set login password
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: Generate PGP key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();

    // Wait for key generation
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });

    // Click Next to complete setup
    await page.getByRole('button', { name: /Next/i }).last().click();

    // Wait for 2FA step or completion
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });

    // Skip 2FA - look for skip button or it might auto-skip
    const skipButton = page.getByRole('button', { name: /Skip/i });
    if (await skipButton.isVisible()) {
      await skipButton.click();
    }

    // Wait for step 4 confirmation screen
    await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 10000 });

    // Click "Complete Setup" button
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    // Wait for setup completion and redirect to main app (Welcome page with account selection)
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 10000 });

    // Verify we're logged in by checking the account is listed
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });

  test('login with correct password', async ({ page }) => {
    const testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // First, register via UI
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    
    // Step 1: API Server
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: PGP Key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    
    // Step 4: 2FA - skip and complete
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    
    // Wait for Welcome page with account selection
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    
    // The account should be listed - just click on the first account item to select it
    await page.locator('.account-item').first().click({ timeout: 5000 });
    
    // Wait for password field to be enabled
    await page.getByPlaceholder('Enter your login password').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // Wait for successful login - should show MainApp with "Select an entry" message
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('login with wrong password', async ({ page }) => {
    const testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // First, register via UI
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: PGP Key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Select the account
    await page.locator('.account-item').first().click({ timeout: 5000 });
    
    // Enter wrong password
    await page.getByPlaceholder('Enter your login password').fill('wrong-password-12345');
    await page.getByRole('button', { name: /Login/i }).click();

    // Wait for error message
    await page.getByText(/Wrong password|Login failed/i).waitFor({ timeout: 5000 });
    await expect(page.getByText(/Wrong password|Login failed/i)).toBeVisible();
  });

  test('setup 2FA during registration', async ({ page }) => {
    const testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Go to the app
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started|Setup/i }).click();

    // Step 1: API Server
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Set login password
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: Generate PGP key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });

    // Complete setup
    await page.getByRole('button', { name: /Next/i }).last().click();

    // Step 4: 2FA setup screen appears
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });

    // Verify QR code is displayed
    await expect(page.locator('canvas')).toBeVisible();

    // Verify secret is displayed
    const secretElement = page.locator('.totp-secret');
    await expect(secretElement).toBeVisible();
    
    // Extract the TOTP secret (remove spaces)
    const secretText = await secretElement.textContent();
    const totpSecret = secretText?.replace(/\s/g, '') || '';
    expect(totpSecret.length).toBeGreaterThan(10);

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

    // Wait for the confirmation screen (Step 4 of 4)
    await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 10000 });

    // Click "Complete Setup" to finish registration
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    // Should redirect to Welcome page with account saved
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });

    // Verify account is listed
    await expect(page.locator('.account-item')).toBeVisible();

    // Now test login with 2FA
    await page.locator('.account-item').first().click({ timeout: 5000 });

    // Enter password
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // 2FA code input should appear
    await page.getByPlaceholder('6-digit code').waitFor({ timeout: 5000 });
    await expect(page.getByPlaceholder('6-digit code')).toBeVisible();

    // Generate a new TOTP code (codes expire every 30 seconds)
    const totpCode2 = totp.generate();

    // Enter TOTP code
    await page.getByPlaceholder('6-digit code').fill(totpCode2);
    await page.getByRole('button', { name: /Verify/i }).click();

    // Should login successfully and show main app
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('logout and session cleanup', async ({ page }) => {
    const testUser = await generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
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
    
    // Login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Open settings
    await page.getByRole('button', { name: /Settings/i }).click();
    await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });

    // Close settings modal by clicking the X button
    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForSelector('.modal-overlay', { state: 'hidden', timeout: 5000 });
    
    // Click lock session button in the main header
    await page.getByRole('button', { name: 'Lock Session' }).click();

    // Should redirect to welcome screen
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();

    // Verify session is cleared by checking that login is required again
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await expect(page.getByPlaceholder('Enter your login password')).toBeVisible();
  });

  // Test importing an existing private key during account setup
  // This simulates the scenario where a user wants to restore from backup
  test('import private key during setup', async ({ page }) => {
    const accountA = await generateTestUser();
    const accountAPassphrase = `pgp-pass-A-${Date.now()}`;

    // Step 1: Create Account A and export its private key
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(accountA.password);
    await page.getByPlaceholder('Confirm your password').fill(accountA.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(accountAPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(accountAPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login to Account A
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(accountA.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Create a test entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/entry');
    await page.getByPlaceholder('Username').fill('test@example.com');
    await page.getByPlaceholder('Password').fill('test-password');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    // Export private key from Account A
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();

    // Delete Account A
    await page.getByRole('button', { name: '✕' }).click();
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '☠️ Permanently Delete Account' }).click();
    await page.waitForSelector('text=Enter your PGP passphrase', { timeout: 5000 });
    await page.getByPlaceholder('Enter your PGP passphrase').fill(accountAPassphrase);
    await page.getByRole('button', { name: 'Confirm' }).last().click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Step 2: Create Account B using Account A's exported private key
    const accountB = await generateTestUser();
    const accountBPassword = `password-B-${Date.now()}`;

    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(accountBPassword);
    await page.getByPlaceholder('Confirm your password').fill(accountBPassword);
    await page.getByPlaceholder('6-digit code from admin').fill((await testUser.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Select "Import existing private key" radio option
    await page.getByLabel('Import existing private key').check();

    // File input should appear
    await page.getByText('Import Private Key', { exact: false }).waitFor({ timeout: 5000 });

    // Upload the exported private key from Account A
    const fileInput = page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]');
    await fileInput.setInputFiles(keyFilePath);
    await page.waitForTimeout(1000);

    // Passphrase input should appear
    await expect(page.getByPlaceholder('Passphrase for this key')).toBeVisible();

    // Enter Account A's passphrase
    await page.getByPlaceholder('Passphrase for this key').fill(accountAPassphrase);

    // Verify import button is enabled
    const importButton = page.getByRole('button', { name: /Import Key/i });
    await expect(importButton).toBeEnabled();

    // Cleanup temp file
    try {
      fs.unlinkSync(keyFilePath);
    } catch (e) {}

    // Set testUser for cleanup (Account B)
    testUser = accountB;
  });
});
