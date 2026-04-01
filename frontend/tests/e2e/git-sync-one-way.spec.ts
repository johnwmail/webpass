/**
 * Git Sync One-Way Sync Tests.
 * Tests that push/pull operations completely overwrite/replace data (not merge).
 * 
 * These tests validate the one-way sync behavior:
 * - Push completely overwrites remote (not merge)
 * - Pull completely replaces local DB (not merge)
 * 
 * Note: These tests were previously removed due to fragility.
 * This implementation uses simpler UI interactions and longer timeouts.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiDeleteAccount,
  apiDeleteEntry,
} from '../helpers/api';

// Get Git credentials from environment variables
const WEBPASS_REPO_URL = process.env.WEBPASS_REPO_URL || '';
const WEBPASS_REPO_PAT = process.env.WEBPASS_REPO_PAT || '';

/**
 * Helper to verify entries exist in remote git repo
 * Clones repo and checks for .gpg files using Node.js child_process
 */
async function verifyEntriesInRemoteRepo(
  repoUrl: string,
  pat: string,
  expectedEntries: { folder: string; name: string }[]
): Promise<boolean> {
  const { execSync } = await import('child_process');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpass-git-verify-'));
  const cloneDir = path.join(tempDir, 'repo');

  try {
    // Clone repo using PAT
    const urlWithAuth = repoUrl.replace('https://', `https://token:${pat}@`);
    execSync(`git clone --depth 1 ${urlWithAuth} ${cloneDir}`, { stdio: 'pipe' });

    // Check for each entry's .gpg file
    for (const entry of expectedEntries) {
      const gpgPath = path.join(cloneDir, entry.folder, `${entry.name}.gpg`);
      if (!fs.existsSync(gpgPath)) {
        console.log(`Missing entry in remote: ${entry.folder}/${entry.name}.gpg`);
        return false;
      }
    }

    return true;
  } catch (error: any) {
    console.error('Failed to verify remote repo:', error.message);
    return false;
  } finally {
    // Cleanup temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Helper function to register and login via UI
 */
async function registerAndLogin(page: any) {
  const pgpPassphrase = `pgp-pass-${Date.now()}`;
  const testUser = await generateTestUser();

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

  return { testUser, pgpPassphrase };
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
 * Get user fingerprint from Settings modal
 */
async function getFingerprintFromSettings(page: any): Promise<string> {
  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(1000);

  // Get fingerprint text (formatted with spaces like "AB12 CD34 EF56...")
  // Note: Use nth(1) because Account Name is now the first .value-text
  const fpText = await page.locator('.value-text').nth(1).textContent();

  // Close modal
  await closeModal(page);

  // Remove spaces to get raw fingerprint
  return fpText?.replace(/\s/g, '') || '';
}

/**
 * Delete an entry via API and reload page to refresh UI
 */
async function deleteEntryViaAPI(page: any, testUser: TestUser, path: string) {
  await apiDeleteEntry(testUser, path);
  await page.reload();
  await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
  await page.waitForTimeout(2000);
}

/**
 * Open git sync modal from settings
 * Handles both initial configuration and managing existing config
 */
async function openGitSync(page: any) {
  // First ensure no modal is open
  await closeModal(page);
  
  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(2000);
  
  // Try "Manage" button first (for existing config), then "Configure Git Sync" (for new config)
  const manageButton = page.getByRole('button', { name: /Manage/i });
  const configureButton = page.getByRole('button', { name: /Configure Git Sync/i });
  
  if (await manageButton.isVisible().catch(() => false)) {
    await manageButton.click();
  } else {
    await configureButton.click();
  }
  
  // Wait for Git Sync modal content to appear
  await page.getByText('Repository URL').waitFor({ timeout: 10000 });
}

/**
 * Configure git sync with valid credentials
 */
async function configureGit(page: any, repoUrl: string, pat: string) {
  await openGitSync(page);
  await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(repoUrl);
  await page.getByPlaceholder('ghp_...').fill(pat);
  await page.getByRole('button', { name: /Configure/i }).click();
  await page.waitForTimeout(5000);
  
  // Wait for git sync modal to show push/pull buttons after configure
  await page.getByRole('button', { name: /Push Now/i }).waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Create an entry via UI
 */
async function createEntry(page: any, folder: string, name: string, password: string) {
  // Ensure no modal is blocking the button
  await closeModal(page);
  
  await page.getByRole('button', { name: /Entry/i }).first().click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('e.g. Email (optional)').fill(folder);
  await page.getByPlaceholder('Entry name').fill(name);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: /Save/i }).click();
  // Wait for folder to appear in tree
  await page.getByText(folder, { exact: false }).waitFor({ timeout: 30000 });
}

/**
 * Check if an entry exists in the sidebar
 */
async function entryExists(page: any, folderName: string, entryName: string): Promise<boolean> {
  // First check if folder is visible
  const folderVisible = await page.getByText(folderName, { exact: false }).first().isVisible().catch(() => false);
  if (!folderVisible) return false;
  
  // Click folder to expand (if not already expanded)
  await page.getByText(folderName, { exact: false }).first().click();
  await page.waitForTimeout(500);
  
  // Check if entry is visible
  const exists = await page.getByText(entryName, { exact: true }).isVisible().catch(() => false);
  return exists;
}

/**
 * Check if a folder exists in the sidebar
 */
async function folderExists(page: any, folderName: string): Promise<boolean> {
  return await page.getByText(folderName, { exact: false }).first().isVisible().catch(() => false);
}

test.describe('Git Sync - One-Way Sync Behavior', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    const result = await registerAndLogin(page);
    testUser = result.testUser;
    pgpPassphrase = result.pgpPassphrase;
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('one-way sync: push overwrites remote, pull replaces local', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    test.setTimeout(180000); // 3 minutes for this complex test

    // Generate unique entry names with timestamp
    const timestamp = Date.now();
    const entryOneName = `Entry One-${timestamp}`;
    const entryTwoName = `Entry Two-${timestamp}`;
    const entryThreeName = `Entry Three-${timestamp}`;

    // Step 1: Create "Entry One" and push to remote
    await createEntry(page, 'FolderOne', entryOneName, 'PasswordOne123!');
    await page.waitForTimeout(2000);

    // Configure git and push
    await configureGit(page, WEBPASS_REPO_URL, WEBPASS_REPO_PAT);

    // Push first entry (button already visible from configureGit)
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);

    // Close git sync modal - try multiple times
    await closeModal(page);
    await page.waitForTimeout(2000);
    
    // Make sure we're on the main page before checking entries
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Verify "Entry One" exists locally
    const entryOneExists = await entryExists(page, 'FolderOne', entryOneName);
    expect(entryOneExists).toBeTruthy();

    // Step 2: Get fingerprint from Settings (needed for API delete)
    const realFingerprint = await getFingerprintFromSettings(page);
    testUser.fingerprint = realFingerprint;

    // Step 3: Delete "Entry One" via API
    await deleteEntryViaAPI(page, testUser, `FolderOne/${entryOneName}`);

    // Verify "Entry One" is gone from UI
    const entryOneAfterDelete = await entryExists(page, 'FolderOne', entryOneName);
    expect(entryOneAfterDelete).toBeFalsy();

    // Step 4: Create "Entry Two" and "Entry Three"
    await createEntry(page, 'FolderTwo', entryTwoName, 'PasswordTwo123!');
    await page.waitForTimeout(2000);
    await createEntry(page, 'FolderThree', entryThreeName, 'PasswordThree123!');
    await page.waitForTimeout(2000);

    // Reopen git sync modal and push
    await openGitSync(page);
    await page.waitForTimeout(2000);

    // Push (should overwrite remote with Entry Two + Entry Three only)
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);

    // Close modal
    await closeModal(page);

    // Step 5: Delete "Entry Two" via API (before pull, Entry Three still exists locally)
    await deleteEntryViaAPI(page, testUser, `FolderTwo/${entryTwoName}`);

    // Verify "Entry Two" is gone locally, "Entry Three" still exists
    const entryTwoAfterDelete = await entryExists(page, 'FolderTwo', entryTwoName);
    expect(entryTwoAfterDelete).toBeFalsy();
    
    const entryThreeStillExists = await entryExists(page, 'FolderThree', entryThreeName);
    expect(entryThreeStillExists).toBeTruthy();

    // Step 6: Pull from remote (should import Entry Two + Entry Three from remote)
    await openGitSync(page);
    await page.waitForTimeout(2000);
    
    await page.getByRole('button', { name: /Pull Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);

    // Close modal
    await closeModal(page);
    
    // Wait for UI to update after pull
    await page.waitForTimeout(5000);
    
    // Reload page to ensure UI is fresh
    await page.reload();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await page.waitForTimeout(3000);

    // Step 7: Verify one-way sync behavior
    // "Entry One" should be GONE (was deleted before second push, overwritten on remote)
    const entryOneAfterPull = await entryExists(page, 'FolderOne', entryOneName);
    expect(entryOneAfterPull).toBeFalsy();

    // "Entry Two" should EXISTS (pulled from remote, even though deleted locally before pull)
    const entryTwoAfterPull = await entryExists(page, 'FolderTwo', entryTwoName);
    expect(entryTwoAfterPull).toBeTruthy();

    // "Entry Three" should EXISTS (pulled from remote)
    const entryThreeAfterPull = await entryExists(page, 'FolderThree', entryThreeName);
    expect(entryThreeAfterPull).toBeTruthy();

    // Verify no error messages appeared
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });
});

test.describe('Git Sync - Branch Detection Edge Cases', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    const result = await registerAndLogin(page);
    testUser = result.testUser;
    pgpPassphrase = result.pgpPassphrase;
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('multiple pushes to same repo maintain branch consistency', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    test.setTimeout(240000); // 4 minutes for multiple push operations

    const timestamp = Date.now();
    const entryNames = [
      { folder: `Folder-A-${timestamp}`, name: `Entry-A-${timestamp}` },
      { folder: `Folder-B-${timestamp}`, name: `Entry-B-${timestamp}` },
      { folder: `Folder-C-${timestamp}`, name: `Entry-C-${timestamp}` },
    ];

    // First push: Entry-A
    await createEntry(page, entryNames[0].folder, entryNames[0].name, 'PassA123!');
    await configureGit(page, WEBPASS_REPO_URL, WEBPASS_REPO_PAT);

    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);
    await closeModal(page);
    await page.waitForTimeout(2000);

    // Second push: Entry-B (same branch, should append)
    await createEntry(page, entryNames[1].folder, entryNames[1].name, 'PassB123!');
    await page.waitForTimeout(2000);

    await openGitSync(page);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);
    await closeModal(page);
    await page.waitForTimeout(2000);

    // Third push: Entry-C (verify branch consistency across multiple pushes)
    await createEntry(page, entryNames[2].folder, entryNames[2].name, 'PassC123!');
    await page.waitForTimeout(2000);

    await openGitSync(page);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);
    await closeModal(page);
    await page.waitForTimeout(2000);

    // All three entries should exist locally
    for (const entry of entryNames) {
      const exists = await entryExists(page, entry.folder, entry.name);
      expect(exists).toBeTruthy();
    }

    // CRITICAL: Verify ALL entries actually exist in remote repo
    const inRemote = await verifyEntriesInRemoteRepo(
      WEBPASS_REPO_URL,
      WEBPASS_REPO_PAT,
      entryNames
    );
    expect(inRemote).toBeTruthy();

    // No errors should have occurred
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });

  test('pull after push maintains data consistency', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    test.setTimeout(180000); // 3 minutes

    const timestamp = Date.now();
    const entryFolder = `ConsistencyFolder-${timestamp}`;
    const entryName = `Consistency-Test-${timestamp}`;

    // Create entry and push
    await createEntry(page, entryFolder, entryName, 'ConsistencyPass123!');
    await configureGit(page, WEBPASS_REPO_URL, WEBPASS_REPO_PAT);

    // Push
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);
    await closeModal(page);
    await page.waitForTimeout(2000);

    // CRITICAL: Verify entry was pushed to remote
    const pushedToRemote = await verifyEntriesInRemoteRepo(
      WEBPASS_REPO_URL,
      WEBPASS_REPO_PAT,
      [{ folder: entryFolder, name: entryName }]
    );
    expect(pushedToRemote).toBeTruthy();

    // Get fingerprint for API operations
    const realFingerprint = await getFingerprintFromSettings(page);
    testUser.fingerprint = realFingerprint;

    // Delete entry via API
    await deleteEntryViaAPI(page, testUser, `${entryFolder}/${entryName}`);
    await page.waitForTimeout(2000);

    // Verify entry is gone locally
    const existsBeforePull = await entryExists(page, entryFolder, entryName);
    expect(existsBeforePull).toBeFalsy();

    // Pull - should restore entry from remote
    await openGitSync(page);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /Pull Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);
    await closeModal(page);
    await page.waitForTimeout(5000);

    // Reload to ensure fresh UI state
    await page.reload();
    await page.getByText('Select an entry or create a new one').waitFor({ timeout: 10000 });
    await page.waitForTimeout(3000);

    // Entry should exist after pull
    const existsAfterPull = await entryExists(page, entryFolder, entryName);
    expect(existsAfterPull).toBeTruthy();

    // No errors
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });
});
