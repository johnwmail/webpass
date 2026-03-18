/**
 * Entry Management E2E tests.
 * Tests CRUD operations for password entries.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser, generateTestEntry } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiLogin,
  apiDeleteAccount,
  apiCreateEntry,
  apiGetEntry,
  apiListEntries,
  apiDeleteEntry,
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

test.describe('Entry Management', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('create new entry', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Click "New Entry" button
    await page.getByRole('button', { name: 'Entry' }).click();

    // Wait for form to appear
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });

    // Fill in the form using placeholders
    await page.getByPlaceholder('e.g. Email (optional)').fill('TestFolder');
    await page.getByPlaceholder('Entry name').fill('testentry');
    await page.getByPlaceholder('Password').fill('testpass123');
    await page.getByPlaceholder('Additional notes, username, URLs...').fill('Test notes');

    // Save
    await page.getByRole('button', { name: /Save/i }).click();

    // Wait for TestFolder to appear in tree (PGP encryption takes time)
    await page.getByText('TestFolder', { exact: false }).waitFor({ timeout: 30000 });
    await expect(page.getByText('TestFolder', { exact: false })).toBeVisible();
  });

  test('create entry with generated password', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Click "New Entry" button
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });

    // Fill in basic info using placeholders
    await page.getByPlaceholder('e.g. Email (optional)').fill('Social');
    await page.getByPlaceholder('Entry name').fill('twitter');

    // Click generate password button
    await page.getByTitle('Generate password').click();

    // Wait for generator modal
    await page.getByText('Password Generator', { exact: false }).waitFor({ timeout: 10000 });

    // Click generate button in modal
    await page.getByRole('button', { name: /Generate/i }).first().click();
    
    // Wait a moment for password to be generated
    await page.waitForTimeout(500);

    // Close the generator modal by clicking outside or use the use button
    // Click the "Use" button to apply password and close modal
    await page.getByRole('button', { name: /Use/i }).click();

    // Save entry
    await page.getByRole('button', { name: /Save/i }).click();

    // Verify Social folder was created
    await page.getByText('Social', { exact: false }).waitFor({ timeout: 30000 });
    await expect(page.getByText('Social', { exact: false })).toBeVisible();
  });

  test('view entry details', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Create an entry via UI first
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('ViewTest');
    await page.getByPlaceholder('Entry name').fill('testview');
    await page.getByPlaceholder('Password').fill('testpass123');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('ViewTest', { exact: false }).waitFor({ timeout: 30000 });

    // Click on ViewTest folder to expand
    await page.getByText('ViewTest', { exact: false }).first().click();
    
    // Click on the entry
    await page.getByText('testview', { exact: true }).click();

    // Entry detail panel should show the entry name in header
    await expect(page.getByRole('heading', { name: /ViewTest.*testview/i })).toBeVisible();
  });

  test('create entry in nested folder', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Click "New Entry" button
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });

    // Fill in nested folder path using placeholders
    await page.getByPlaceholder('e.g. Email (optional)').fill('Work');
    await page.getByPlaceholder('Entry name').fill('work-email');
    await page.getByPlaceholder('Password').fill('secure-work-password');

    // Save
    await page.getByRole('button', { name: /Save/i }).click();

    // Verify Work folder is visible
    await page.getByText('Work', { exact: false }).waitFor({ timeout: 30000 });
    await expect(page.getByText('Work', { exact: false })).toBeVisible();
  });

  test('search entries', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Create an entry
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('SearchTest');
    await page.getByPlaceholder('Entry name').fill('gmail');
    await page.getByPlaceholder('Password').fill('gmail-pass');
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('SearchTest', { exact: false }).waitFor({ timeout: 30000 });

    // Find search input
    const searchInput = page.getByPlaceholder('Search entries...');
    await searchInput.fill('gmail');

    // SearchTest folder should still be visible
    await expect(page.getByText('SearchTest', { exact: false })).toBeVisible();
  });

  test('multiple entries - list view', async ({ page }) => {
    testUser = generateTestUser();
    await registerAndLogin(page, testUser);

    // Create multiple entries in different folders
    const folders = ['Email', 'Social', 'Finance'];

    for (const folder of folders) {
      await page.getByRole('button', { name: 'Entry' }).click();
      await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
      await page.getByPlaceholder('e.g. Email (optional)').fill(folder);
      await page.getByPlaceholder('Entry name').fill(`${folder.toLowerCase()}-entry`);
      await page.getByPlaceholder('Password').fill('password123');
      await page.getByRole('button', { name: /Save/i }).click();
      await page.getByText(folder, { exact: false }).waitFor({ timeout: 30000 });
    }

    // Verify all folders are visible in the tree
    await expect(page.getByText('Email', { exact: false })).toBeVisible();
    await expect(page.getByText('Social', { exact: false })).toBeVisible();
    await expect(page.getByText('Finance', { exact: false })).toBeVisible();
  });
});
