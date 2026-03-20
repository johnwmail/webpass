/**
 * Entry Detail Toggle E2E Tests
 * Tests show/hide toggle for password, notes, and OTP code
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import {
  apiRegister,
  apiLogin,
  apiDeleteAccount,
  apiCreateEntry,
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

/**
 * Helper function to create an entry with notes and TOTP
 */
async function createEntryWithNotesAndTOTP(page: any, folderName: string, entryName: string) {
  await page.getByRole('button', { name: 'Entry' }).click();
  await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
  await page.getByPlaceholder('e.g. Email (optional)').fill(folderName);
  await page.getByPlaceholder('Entry name').fill(entryName);
  await page.getByPlaceholder('Password').fill('testpass123');
  await page.getByPlaceholder('Additional notes, username, URLs...').fill('Test notes content');
  await page.getByRole('button', { name: /Save/i }).click();
  await page.getByText(folderName, { exact: false }).waitFor({ timeout: 30000 });
}

/**
 * Helper function to decrypt an entry
 */
async function decryptEntry(page: any, pgpPassphrase: string) {
  await page.getByRole('button', { name: 'Decrypt', exact: true }).click();
  await page.getByPlaceholder('Enter your PGP passphrase').waitFor({ timeout: 5000 });
  await page.getByPlaceholder('Enter your PGP passphrase').fill(pgpPassphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForTimeout(1000);
}

/**
 * Helper function to wait for countdown timer
 */
async function waitForCountdown(page: any, seconds: number) {
  await page.waitForTimeout(seconds * 1000 + 500);
}

test.describe('Entry Detail Toggle Visibility', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup: Delete test account after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('password show/hide toggle works', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry
    await createEntryWithNotesAndTOTP(page, 'PasswordTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('PasswordTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Password should be hidden by default - eye icon without countdown
    const passwordElement = page.locator('.password-display').first();
    const toggleBtn = passwordElement.locator('button').first();
    
    // Click to show password
    await toggleBtn.click();
    await page.waitForTimeout(500);

    // Password should now be visible with countdown timer
    const passwordText = await passwordElement.textContent();
    expect(passwordText).toContain('testpass123');
    expect(passwordText).toContain('s'); // countdown timer

    // Click hide button
    await toggleBtn.click();
    await page.waitForTimeout(300);

    // Password should be hidden again
    const hiddenText = await passwordElement.textContent();
    expect(hiddenText).toContain('•');
  });

  test('notes show/hide toggle works', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry with notes
    await createEntryWithNotesAndTOTP(page, 'NotesTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('NotesTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Notes should be hidden by default - click to show using notes container
    const notesContainer = page.locator('.entry-field').filter({ hasText: 'Notes' }).first();
    const notesShowBtn = notesContainer.locator('button').first();
    await notesShowBtn.click();
    await page.waitForTimeout(500);

    // Notes should now be visible with countdown timer
    const notesValue = notesContainer.locator('.value');
    await expect(notesValue).toContainText('Test notes');
    const notesText = await notesContainer.textContent();
    expect(notesText).toContain('s'); // countdown timer

    // Click to hide again
    const notesHideBtn = notesContainer.locator('button').first();
    await notesHideBtn.click();
    await page.waitForTimeout(300);

    // Notes should be hidden again
    const hiddenNotesText = await notesValue.textContent();
    expect(hiddenNotesText).toContain('•');
  });

  test('password copy button is clickable', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry
    await createEntryWithNotesAndTOTP(page, 'CopyTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('CopyTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Password should be hidden by default - click to show
    const passwordElement = page.locator('.password-display').first();
    const togglePasswordBtn = passwordElement.locator('button').first();
    await togglePasswordBtn.click();

    // Wait for password to be visible
    await page.waitForTimeout(300);

    // Click copy button (second button in password-display) - should be enabled
    const copyBtn = passwordElement.locator('button').nth(1);
    await expect(copyBtn).toBeEnabled();
    await copyBtn.click();
    
    // Button should still be visible after click
    await expect(copyBtn).toBeVisible();
  });

  test('entry detail container has correct structure', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry
    await createEntryWithNotesAndTOTP(page, 'ActivityTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('ActivityTest', { exact: false }).first().click();

    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Verify the entry-detail container exists
    const entryDetailContainer = page.locator('.entry-detail');
    await expect(entryDetailContainer).toBeVisible();

    // Verify it contains the expected elements
    await expect(entryDetailContainer.locator('.entry-detail-header')).toBeVisible();
    // Check that there are multiple entry-field elements (password, notes, etc.)
    await expect(entryDetailContainer.locator('.entry-field').first()).toBeVisible();
  });

  test('auto-hide after 15 seconds', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry
    await createEntryWithNotesAndTOTP(page, 'AutoHideTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('AutoHideTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Click to show password using getByTitle
    await page.getByTitle('Show').first().click();
    await page.waitForTimeout(500);

    // Password should be visible now
    const passwordElement = page.locator('.password-display').first();
    const visibleText = await passwordElement.textContent();
    expect(visibleText).toContain('testpass123');

    // Wait for 15 seconds auto-hide
    await waitForCountdown(page, 15);

    // Password should be hidden now
    const hiddenText = await passwordElement.textContent();
    expect(hiddenText).toContain('•');
  });

  test('notes hidden by default after decrypt', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry with notes
    await createEntryWithNotesAndTOTP(page, 'NotesDefaultTest', 'test-entry');

    // Click on the folder to expand
    await page.getByText('NotesDefaultTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('test-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // Notes should be hidden by default (masked with bullets)
    const notesContainer = page.locator('.entry-field').filter({ hasText: 'Notes' }).first();
    const notesValue = notesContainer.locator('.value');
    const notesText = await notesValue.textContent();
    expect(notesText).toContain('•');
  });

  test('OTP always visible with manual toggle', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;
    await registerAndLogin(page, testUser);

    // Create an entry with TOTP URI in notes
    await page.getByRole('button', { name: 'Entry' }).click();
    await page.getByText('New Entry', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByPlaceholder('e.g. Email (optional)').fill('OTPTest');
    await page.getByPlaceholder('Entry name').fill('totp-entry');
    await page.getByPlaceholder('Password').fill('testpass123');
    await page.getByPlaceholder('Additional notes, username, URLs...').fill(
      'Test notes\notpauth://totp/TestService:user?secret=JBSWY3DP'
    );
    await page.getByRole('button', { name: /Save/i }).click();
    await page.getByText('OTPTest', { exact: false }).waitFor({ timeout: 30000 });

    // Click on the folder to expand
    await page.getByText('OTPTest', { exact: false }).first().click();
    
    // Click on the entry to view details
    await page.getByText('totp-entry', { exact: true }).click();

    // Decrypt the entry
    await decryptEntry(page, pgpPassphrase);

    // Wait for content to be fully loaded
    await page.waitForTimeout(500);

    // OTP should be visible by default (6-digit code)
    const otpSection = page.locator('.otp-display');
    await expect(otpSection).toBeVisible();
    
    // OTP code should be visible (6 digits)
    const otpCode = otpSection.locator('.otp-code');
    const otpText = await otpCode.textContent();
    expect(otpText).toMatch(/^\d{6}$/);

    // Click hide button (second button in otp-code-container)
    const hideBtn = otpSection.locator('.otp-copy').nth(1);
    await hideBtn.click();
    await page.waitForTimeout(300);

    // OTP should now be hidden (masked)
    const hiddenOtpText = await otpCode.textContent();
    expect(hiddenOtpText).toContain('•');
  });
});
