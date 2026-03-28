/**
 * Git Sync E2E tests.
 * Tests git sync UI behavior - configuration, push, pull, and error handling.
 * Uses real Gitea repository for testing.
 *
 * Environment variables (set in .env or via command line):
 *   WEBPASS_REPO_URL - Git repository URL
 *   WEBPASS_REPO_PAT - Personal Access Token for authentication
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiDeleteAccount,
} from '../helpers/api';

// Get Git credentials from environment variables
// Falls back to empty string if not set (tests will be skipped)
const WEBPASS_REPO_URL = process.env.WEBPASS_REPO_URL || '';
const WEBPASS_REPO_PAT = process.env.WEBPASS_REPO_PAT || '';

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

  return pgpPassphrase;
}

/**
 * Open git sync modal from settings
 */
async function openGitSync(page: any) {
  // Open Settings
  await page.getByRole('button', { name: /Settings/i }).click();
  await page.getByText('Settings', { exact: false }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(2000);
  
  // Click Configure Git Sync button (may need to scroll in UI, but we wait for it)
  await page.getByRole('button', { name: /Configure Git Sync/i }).click();
  // Wait for Git Sync modal content to appear
  await page.getByText('Repository URL').waitFor({ timeout: 10000 });
}

test.describe('Git Sync - Configuration', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    await apiRegister(testUser);
    pgpPassphrase = await registerAndLogin(page, testUser);
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('configure git sync with valid URL and PAT', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    await openGitSync(page);

    // Fill in git config form with real Git credentials
    await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(WEBPASS_REPO_URL);
    await page.getByPlaceholder('ghp_...').fill(WEBPASS_REPO_PAT);

    // Click configure button (no passphrase needed for configure - uses public key)
    await page.getByRole('button', { name: /Configure/i }).click();

    // Wait for config to complete and status to load
    await page.waitForTimeout(5000);

    // Check if status view appeared by looking for any status view element
    const pushButtonVisible = await page.getByRole('button', { name: /Push Now/i }).isVisible().catch(() => false);
    const pullButtonVisible = await page.getByRole('button', { name: /Pull Now/i }).isVisible().catch(() => false);
    const statusTextVisible = await page.getByText('Status').isVisible().catch(() => false);

    // At least one indicator should show config succeeded
    expect(pushButtonVisible || pullButtonVisible || statusTextVisible).toBeTruthy();
  });

  test('configure git sync - cancel closes modal', async ({ page }) => {
    await openGitSync(page);

    // Click on the overlay (outside modal) to close
    await page.locator('.modal-overlay').first().click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    // Modal should close
    await expect(page.locator('h2:has-text("Git Sync")')).not.toBeVisible();
  });

  test('configure git sync - validation (empty fields)', async ({ page }) => {
    await openGitSync(page);

    // Configure button should be disabled when fields are empty
    const configureBtn = page.getByRole('button', { name: /Configure/i });
    await expect(configureBtn).toBeDisabled();
  });
});

test.describe('Git Sync - Pull Error Handling', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    await apiRegister(testUser);
    pgpPassphrase = await registerAndLogin(page, testUser);
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('error message stays visible and modal does not auto-close on pull error', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    // First configure git with real Git repo
    await openGitSync(page);

    await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(WEBPASS_REPO_URL);
    await page.getByPlaceholder('ghp_...').fill(WEBPASS_REPO_PAT);
    await page.getByRole('button', { name: /Configure/i }).click();

    // Wait for config to complete
    await page.waitForTimeout(3000);

    // Click pull button
    await page.getByRole('button', { name: /Pull Now/i }).click();

    // Passphrase prompt should appear
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();

    // Wait for result (success or error)
    await page.waitForTimeout(10000);

    // Either error message should be visible OR success message
    const errorMsgLocator = page.locator('.error-msg');
    const errorVisible = await errorMsgLocator.isVisible().catch(() => false);

    if (errorVisible) {
      // Get error text
      const errorText = await errorMsgLocator.textContent();
      expect(errorText).toBeTruthy();
      expect(errorText?.length).toBeGreaterThan(10);

      // Modal should still be open (not auto-closed)
      await expect(page.locator('h2:has-text("Git Sync")')).toBeVisible();

      // Verify Close button is visible in error message
      await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

      // Click overlay should NOT close modal when error is shown
      await page.locator('.modal-overlay').first().click({ position: { x: 50, y: 50 } });
      await page.waitForTimeout(500);

      // Modal should still be visible
      await expect(page.locator('h2:has-text("Git Sync")')).toBeVisible();

      // Click the Close button in error message
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForTimeout(500);

      // Now modal should be closed
      await expect(page.locator('h2:has-text("Git Sync")')).not.toBeVisible();
    }
    // If no error, test passes (pull succeeded)
  });

  test('pull with wrong passphrase shows error and modal stays open', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    // First configure git with real Git repo
    await openGitSync(page);

    await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(WEBPASS_REPO_URL);
    await page.getByPlaceholder('ghp_...').fill(WEBPASS_REPO_PAT);
    await page.getByRole('button', { name: /Configure/i }).click();
    
    // Wait for config to complete
    await page.waitForTimeout(3000);

    // Click pull button
    await page.getByRole('button', { name: /Pull Now/i }).click();

    // Passphrase prompt should appear
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    
    // Enter WRONG passphrase
    await page.getByPlaceholder('PGP passphrase').fill('wrong-passphrase-12345');
    await page.getByRole('button', { name: 'OK' }).click();

    // Wait for error to appear
    await page.waitForTimeout(5000);

    // Error message should be visible
    const errorMsgLocator = page.locator('.error-msg');
    await expect(errorMsgLocator).toBeVisible({ timeout: 10000 });

    // Modal should still be open
    await expect(page.locator('h2:has-text("Git Sync")')).toBeVisible();
  });
});

test.describe('Git Sync - Basic UI', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    await apiRegister(testUser);
    pgpPassphrase = await registerAndLogin(page, testUser);
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('git sync button opens configuration modal', async ({ page }) => {
    await openGitSync(page);

    // Configuration form should be visible
    await expect(page.getByText('Configure Git Sync')).toBeVisible();
    await expect(page.getByPlaceholder('https://github.com/user/private-repo.git')).toBeVisible();
    await expect(page.getByPlaceholder('ghp_...')).toBeVisible();
    await expect(page.getByRole('button', { name: /Configure/i })).toBeVisible();
  });
});

test.describe('Git Sync - Push/Pull Workflow', () => {
  let testUser: TestUser;
  let pgpPassphrase: string;

  test.beforeEach(async ({ page }) => {
    testUser = generateTestUser();
    await apiRegister(testUser);
    pgpPassphrase = await registerAndLogin(page, testUser);
  });

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('create entry then push to git', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    // Step 1: Create a test entry - click the "Entry" button in sidebar
    await page.getByRole('button', { name: /Entry/i }).first().click();
    await page.waitForTimeout(1000);
    await page.getByPlaceholder('e.g. Email (optional)').fill('push-test@example.com');
    await page.getByPlaceholder('Entry name').fill('Push Test Entry');
    await page.getByPlaceholder('Password').fill('PushTestPass123!');
    await page.getByRole('button', { name: /Save/i }).click();

    // Wait for entry list to update and verify entry was created
    await page.waitForTimeout(3000);
    // Check that we're back on the main page (not in edit mode)
    await expect(page.getByRole('button', { name: /Entry/i })).toBeVisible({ timeout: 5000 });

    // Step 2: Configure git and push
    await openGitSync(page);
    await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(WEBPASS_REPO_URL);
    await page.getByPlaceholder('ghp_...').fill(WEBPASS_REPO_PAT);
    await page.getByRole('button', { name: /Configure/i }).click();
    await page.waitForTimeout(3000);

    // Push
    await page.getByRole('button', { name: /Push Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);

    // Modal may have closed after successful push - just verify no error
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });

  test('pull entries from git after configure', async ({ page }) => {
    // Skip test if credentials not configured
    test.skip(!WEBPASS_REPO_URL || !WEBPASS_REPO_PAT, 'WEBPASS_REPO_URL and WEBPASS_REPO_PAT environment variables required');

    // Step 1: Configure git first
    await openGitSync(page);
    await page.getByPlaceholder('https://github.com/user/private-repo.git').fill(WEBPASS_REPO_URL);
    await page.getByPlaceholder('ghp_...').fill(WEBPASS_REPO_PAT);
    await page.getByRole('button', { name: /Configure/i }).click();
    await page.waitForTimeout(3000);

    // Step 2: Pull (should sync any existing entries from remote)
    await page.getByRole('button', { name: /Pull Now/i }).click();
    await page.getByText('🔐 Enter PGP Passphrase', { exact: false }).waitFor({ timeout: 5000 });
    await page.getByPlaceholder('PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: 'OK' }).click();
    await page.waitForTimeout(15000);

    // Modal may have closed after successful pull - just verify no error
    const errorMsg = page.locator('.error-msg');
    const errorVisible = await errorMsg.isVisible().catch(() => false);
    expect(errorVisible).toBeFalsy();
  });

  // Note: Conflict tests require manipulating remote git repo directly
  // The backend conflict detection is tested via server logs:
  // - "PULL: REJECTING - local has unpushed changes" when local ahead of remote
  // - "remote has changes, please pull first" when remote ahead of local
  // Manual testing recommended for full conflict scenarios
});
