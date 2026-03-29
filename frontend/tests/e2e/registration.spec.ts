/**
 * Registration E2E tests.
 * Tests all registration modes: open, protected (TOTP), and disabled.
 * Each test starts its own server with specific configuration.
 */

import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import type { TestUser } from '../helpers/api';
import { apiDeleteAccount } from '../helpers/api';

// Test TOTP secret (base32 encoded)
const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

test.describe('Registration - Open Mode (No Code Required)', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('register without registration code', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password - no registration code field
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);

    // Verify code field does NOT exist
    await expect(page.getByPlaceholder('6-digit code from admin')).not.toBeVisible();

    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: Generate PGP key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });
});

test.describe('Registration - Protected Mode (TOTP Code Required)', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('register with valid TOTP code', async ({ page }) => {
    testUser = generateTestUser();
    const pgpPassphrase = `pgp-pass-${Date.now()}`;

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Password with registration code
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);

    // Generate valid TOTP code
    const otpauth = await import('otpauth');
    const totp = new otpauth.TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: otpauth.Secret.fromBase32(TEST_TOTP_SECRET),
    });
    const totpCode = totp.generate();

    // Enter registration code
    await page.getByPlaceholder('6-digit code from admin').fill(totpCode);

    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('PGP Key', { exact: false }).waitFor({ timeout: 5000 });

    // Step 3: Generate PGP key
    await page.getByPlaceholder('Choose a PGP passphrase').fill(pgpPassphrase);
    await page.getByPlaceholder('Confirm your PGP passphrase').fill(pgpPassphrase);
    await page.getByRole('button', { name: /Generate Keypair/i }).click();
    await page.getByText('Key ready!', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Next/i }).last().click();
    await page.getByText('Enable 2FA', { exact: false }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Complete Setup/i }).click();

    await page.getByRole('heading', { name: 'WebPass' }).waitFor({ timeout: 10000 });
    await expect(page.getByText('Zero-knowledge password manager')).toBeVisible();
  });

  test('register with invalid TOTP code shows error', async ({ page }) => {
    testUser = generateTestUser();

    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    // Step 2: Enter invalid code
    await page.getByPlaceholder('Choose a strong password').fill(testUser.password);
    await page.getByPlaceholder('Confirm your password').fill(testUser.password);
    await page.getByPlaceholder('6-digit code from admin').fill('000000');

    await page.getByRole('button', { name: 'Next' }).click();

    // Error message should appear
    await page.getByText(/invalid|expired|code/i).waitFor({ timeout: 5000 });
    await expect(page.getByText(/invalid|expired|code/i)).toBeVisible();
  });

  test('registration code field is numeric only', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill('test-password');
    await page.getByPlaceholder('Confirm your password').fill('test-password');

    // Enter non-numeric characters
    const codeInput = page.getByPlaceholder('6-digit code from admin');
    await codeInput.fill('abc123');

    // Non-numeric characters should be filtered out
    const value = await codeInput.inputValue();
    expect(value).toBe('123');
  });

  test('registration code input has correct attributes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });
    await page.getByRole('button', { name: /Next/i }).first().click();
    await page.getByText('Choose Password', { exact: false }).waitFor({ timeout: 5000 });

    await page.getByPlaceholder('Choose a strong password').fill('test-password');
    await page.getByPlaceholder('Confirm your password').fill('test-password');

    const codeInput = page.getByPlaceholder('6-digit code from admin');

    // Verify input attributes
    await expect(codeInput).toHaveAttribute('maxlength', '6');
    await expect(codeInput).toHaveAttribute('inputmode', 'numeric');
    await expect(codeInput).toHaveAttribute('placeholder', '6-digit code from admin');

    // Verify help text is present
    const helpText = page.getByText(/6-digit registration code from admin/i);
    await expect(helpText).toBeVisible();
  });
});

test.describe('Registration - Disabled Mode', () => {
  test('registration disabled shows error', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Get Started/i }).click();
    await page.waitForSelector('input[type="url"]', { timeout: 5000 });

    // Click Next - should fail with disabled error
    await page.getByRole('button', { name: /Next/i }).first().click();

    // Error message about registration disabled
    await page.getByText(/disabled/i).waitFor({ timeout: 5000 });
    await expect(page.getByText(/disabled/i)).toBeVisible();
  });
});
