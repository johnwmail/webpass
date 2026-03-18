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
    testUser = generateTestUser();
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
    const testUserData = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // First, register via UI
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    
    // Step 1: API Server
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password
    await page.getByPlaceholder('Choose a strong password').fill(testUserData.password);
    await page.getByPlaceholder('Confirm your password').fill(testUserData.password);
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
    await page.getByPlaceholder('Enter your login password').fill(testUserData.password);
    await page.getByRole('button', { name: /Login/i }).click();

    // Wait for successful login - should show MainApp with "Select an entry" message
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await expect(page.getByText('Select an entry or create a new one')).toBeVisible();
  });

  test('login with wrong password', async ({ page }) => {
    const testUserData = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // First, register via UI
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password
    await page.getByPlaceholder('Choose a strong password').fill(testUserData.password);
    await page.getByPlaceholder('Confirm your password').fill(testUserData.password);
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
    const testUserData = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Go to the app
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started|Setup/i }).click();

    // Step 1: API Server
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Set login password
    await page.getByPlaceholder('Choose a strong password').fill(testUserData.password);
    await page.getByPlaceholder('Confirm your password').fill(testUserData.password);
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
    await expect(page.locator('.totp-secret')).toBeVisible();

    // Verify skip button exists and click it
    await page.getByRole('button', { name: /Skip/i }).click();

    // Wait for the confirmation screen (Step 4 of 4)
    await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 5000 });

    // Click "Complete Setup" to finish registration
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    // Should redirect to Welcome page with account saved
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await page.getByText('Zero-knowledge password manager').waitFor({ timeout: 5000 });
    
    // Verify account is listed
    await expect(page.locator('.account-item')).toBeVisible();
  });

  test('logout and session cleanup', async ({ page }) => {
    const testUserData = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    // Register and login
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
});
