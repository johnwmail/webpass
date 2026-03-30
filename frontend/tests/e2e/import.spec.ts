/**
 * Import E2E tests.
 * Tests the import password store functionality.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';
import * as fs from 'fs';

test.describe('Import Entries', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('import entries - account migration flow', async ({ page }) => {
    // Set longer timeout for this test as it does full account lifecycle
    test.setTimeout(120000);

    const accountA = await generateTestUser();
    const accountAPassphrase = `pgp-pass-A-${Date.now()}`;

    // ========== ACCOUNT A: Create and Export ==========
    // Register Account A
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(accountA.password);
    await page.getByPlaceholder('Confirm your password').fill(accountA.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await accountA.registrationCode) || '');
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

    // Create test entries in Account A
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/gmail');
    await page.getByPlaceholder('Username').fill('test@gmail.com');
    await page.getByPlaceholder('Password').fill('gmail-password-123');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    await page.getByRole('button', { name: 'Entry' }).click();
    await page.waitForSelector('text=New Entry', { timeout: 5000 });
    await page.getByPlaceholder('Entry name').fill('Test/github');
    await page.getByPlaceholder('Username').fill('testuser');
    await page.getByPlaceholder('Password').fill('github-password-456');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForSelector('text=Test', { timeout: 30000 });

    // Open settings and export from Account A
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    // Export private key
    const [keyDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📤 Export Private Key' }).click(),
    ]);
    const keyFilePath = await keyDownload.path();

    // Export password store
    const [storeDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: '📦 Export All' }).click(),
    ]);
    const storeFilePath = await storeDownload.path();

    // Delete Account A completely
    await page.getByRole('button', { name: '✕' }).click(); // Close settings
    await page.waitForTimeout(1000);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });

    // Scroll to danger zone
    await page.getByRole('heading', { name: 'Danger Zone' }).scrollIntoViewIfNeeded();

    // Click delete account
    await page.getByRole('button', { name: '☠️ Permanently Delete Account' }).click();
    await page.waitForSelector('text=Enter your PGP passphrase', { timeout: 5000 });

    // Enter passphrase and confirm
    await page.getByPlaceholder('Enter your PGP passphrase').fill(accountAPassphrase);
    await page.getByRole('button', { name: 'Confirm' }).last().click();

    // Wait for account deleted and redirect to welcome
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // ========== ACCOUNT B: Create and Import ==========
    const accountB = await generateTestUser();
    const accountBPassphrase = `pgp-pass-B-${Date.now()}`;

    // Register Account B (new account with different keys)
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill(accountB.password);
    await page.getByPlaceholder('Confirm your password').fill(accountB.password);
    await page.getByPlaceholder('6-digit code from admin').fill((await accountA.registrationCode) || '');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a PGP passphrase').fill(accountBPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(accountBPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();
    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });

    // Login to Account B
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(accountB.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });

    // Verify Account B has no entries yet
    await expect(page.getByText('No entries yet')).toBeVisible();

    // Open settings and import into Account B
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForSelector('text=Settings', { timeout: 5000 });
    await page.getByRole('button', { name: '📥 Import .password-store' }).click();
    await page.waitForSelector('text=Import Password Store', { timeout: 5000 });

    // Upload the exported password store from Account A
    await page.locator('input[type="file"][accept=".tar.gz,.tgz,.tar"]').setInputFiles(storeFilePath);
    await page.waitForTimeout(500);

    // Upload the exported private key from Account A
    await page.locator('input[type="file"][accept=".asc,.pgp,.key,.gpg"]').setInputFiles(keyFilePath);
    await page.waitForTimeout(500);

    // Enter Account A's passphrase (to decrypt Account A's private key)
    await page.getByPlaceholder('Enter private key passphrase').fill(accountAPassphrase);
    await page.waitForTimeout(500);

    // Click import button
    const importDialog = page.locator('.modal:has-text("Import Password Store")');
    const importButton = importDialog.getByRole('button', { name: '📥 Import' });
    await importButton.click();

    // Wait for progress indicator to appear (shows "Extracting archive...")
    // Use a more flexible selector that matches any progress message
    const progressContainer = page.locator('[style*="background: var(--bg-tertiary)"]').first();
    await progressContainer.waitFor({ state: 'visible', timeout: 10000 });

    // Wait for import to complete - look for success message or progress completion
    try {
      // Wait for "Imported" text in success message (appears after completion)
      await page.waitForSelector('text=Imported', { timeout: 70000 });
    } catch {
      // Fallback: wait for progress to show "complete" stage or error
      const progressText = await page.locator('[style*="color: var(--text-muted)"]').first().textContent();
      if (progressText && progressText.includes('error')) {
        throw new Error('Import failed: ' + progressText);
      }
      // If still no success, wait a bit more and check again
      await page.waitForTimeout(5000);
      await page.waitForSelector('text=Imported', { timeout: 10000 });
    }

    // Verify success message shows 2 entries
    await expect(page.getByText(/Imported.*2.*entries/i)).toBeVisible();

    // The import dialog closes automatically, but Settings modal may still be open
    // Close Settings modal if it's still open
    const settingsCloseButton = page.getByRole('button', { name: '✕' }).first();
    if (await settingsCloseButton.isVisible().catch(() => false)) {
      await settingsCloseButton.click();
      await page.waitForTimeout(500);
    }

    // Verify entries were imported into Account B
    await page.waitForSelector('text=Test', { timeout: 10000 });
    await expect(page.locator('.tree-item').filter({ hasText: 'Test' })).toBeVisible();

    // Cleanup downloaded files
    try {
      fs.unlinkSync(keyFilePath);
      fs.unlinkSync(storeFilePath);
    } catch (e) {}

    // Set testUser for cleanup (Account B)
    testUser = accountB;
  });
});
