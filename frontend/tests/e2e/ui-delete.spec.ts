/**
 * UI Delete E2E tests.
 * Tests entry deletion via UI (not API) after logout/login.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiDeleteAccount,
} from '../helpers/api';

/**
 * Helper function to register and login via UI
 */
async function registerAndLogin(page: any) {
  const pgpPassphrase = `pgp-pass-${Date.now()}`;
  const testUser = generateTestUser();

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

  return { testUser, pgpPassphrase };
}

/**
 * Logout via UI
 */
async function logout(page: any) {
  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(1000);
  
  // Click logout button
  await page.getByRole('button', { name: /Logout/i }).click();
  await page.waitForTimeout(2000);
  
  // Wait for login screen (use heading to avoid ambiguity)
  await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
}

/**
 * Create an entry via UI
 */
async function createEntry(page: any, folder: string, name: string, password: string) {
  await page.getByRole('button', { name: /Entry/i }).first().click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('e.g. Email (optional)').fill(folder);
  await page.getByPlaceholder('Entry name').fill(name);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: /Save/i }).click();
  // Wait for folder to appear in tree (PGP encryption takes time)
  await page.getByText(folder, { exact: false }).waitFor({ timeout: 30000 });
  // Additional wait for encryption to complete
  await page.waitForTimeout(3000);
}

/**
 * Check if an entry exists in the sidebar
 */
async function entryExists(page: any, folderName: string, entryName: string): Promise<boolean> {
  // First check if folder is visible
  const folderVisible = await page.getByText(folderName, { exact: false }).first().isVisible().catch(() => false);
  if (!folderVisible) return false;
  
  // Click folder to expand (it might already be expanded)
  try {
    await page.getByText(folderName, { exact: false }).first().click();
    await page.waitForTimeout(500);
  } catch (e) {
    // Folder might already be expanded, continue
  }
  
  // Check if entry is visible (use contains instead of exact match)
  const exists = await page.getByText(entryName).first().isVisible().catch(() => false);
  return exists;
}

/**
 * Close any open modal by clicking the overlay
 */
async function closeModal(page: any) {
  const modalOverlay = page.locator('.modal-overlay');
  if (await modalOverlay.isVisible().catch(() => false)) {
    await modalOverlay.first().click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(1000);
  }
}

/**
 * Delete entry via right-click context menu
 */
async function deleteViaRightClick(page: any, folderName: string, entryName: string) {
  // Click folder to expand
  await page.getByText(folderName, { exact: false }).first().click();
  await page.waitForTimeout(500);
  
  // Right-click on the entry
  await page.getByText(entryName).first().click({ button: 'right' });
  await page.waitForTimeout(500);
  
  // Click delete in context menu
  await page.getByRole('button', { name: /Delete/i }).first().click();
  await page.waitForTimeout(1000);
  
  // Click delete again to confirm (button text doesn't change, just becomes red)
  await page.getByRole('button', { name: /Delete/i }).last().click();
  await page.waitForTimeout(2000);
}

/**
 * Delete entry via entry detail view (click entry → delete button)
 */
async function deleteViaDetail(page: any, folderName: string, entryName: string, pgpPassphrase: string) {
  // Click folder to expand
  const folder = page.getByText(folderName).first();
  await folder.click();
  await page.waitForTimeout(1000);
  
  // Click on the entry NAME (not the folder) to open detail view
  const entry = page.getByText(entryName).filter({ hasNot: page.getByRole('heading') }).first();
  await entry.click();
  await page.waitForTimeout(3000);
  
  // Wait for entry detail view to appear (look for Edit button which is always visible)
  await page.getByRole('button', { name: /Edit/i }).first().waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1000);
  
  // Enter PGP passphrase to decrypt (if prompt appears)
  const passphrasePrompt = page.getByText('🔐 Enter PGP Passphrase', { exact: false });
  if (await passphrasePrompt.isVisible().catch(() => false)) {
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(3000);
  }
  
  // Click delete button
  await page.getByRole('button', { name: /Delete/i }).first().click();
  await page.waitForTimeout(1000);
  
  // Click delete again to confirm
  await page.getByRole('button', { name: /Delete/i }).last().click();
  await page.waitForTimeout(2000);
}

test.describe('UI Delete - After Logout/Login', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('delete entry via right-click context menu after logout/login', async ({ page }) => {
    test.setTimeout(120000); // 2 minutes

    // Step 1: Register and login
    const result = await registerAndLogin(page);
    testUser = result.testUser;
    pgpPassphrase = result.pgpPassphrase;

    // Step 2: Create two entries in separate folders
    await createEntry(page, 'FolderOne', 'Entry One', 'Password123!');
    await page.waitForTimeout(2000);
    await createEntry(page, 'FolderTwo', 'Entry Two', 'Password456!');
    await page.waitForTimeout(2000);

    // Verify both entries exist
    const entryOneExists = await entryExists(page, 'FolderOne', 'Entry One');
    expect(entryOneExists).toBeTruthy();
    const entryTwoExists = await entryExists(page, 'FolderTwo', 'Entry Two');
    expect(entryTwoExists).toBeTruthy();

    // Step 3: Logout
    await logout(page);

    // Step 4: Re-login
    await page.locator('.account-item').first().click({ timeout: 5000 });
    await page.getByPlaceholder('Enter your login password').fill(testUser.password);
    await page.getByRole('button', { name: /Login/i }).click();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Step 5: Delete Entry One via right-click
    await deleteViaRightClick(page, 'FolderOne', 'Entry One');

    // Step 6: Verify Entry One is GONE, Entry Two still EXISTS
    const entryOneAfterDelete = await entryExists(page, 'FolderOne', 'Entry One');
    expect(entryOneAfterDelete).toBeFalsy();

    const entryTwoAfterDelete = await entryExists(page, 'FolderTwo', 'Entry Two');
    expect(entryTwoAfterDelete).toBeTruthy();

    // Verify no errors
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });
});
