# E2E Testing with Playwright

WebPass uses Playwright for end-to-end (E2E) testing. This guide covers everything you need to know about running, writing, and configuring E2E tests.

---

## Quick Start

```bash
# Run all E2E tests
./frontend/playwright-e2e-test.sh

# Or use npx directly (requires server running)
cd frontend && npx playwright test
```

---

## Prerequisites

- Go 1.26+
- Node.js 24+
- Playwright (installed automatically by test script)

---

## Test Script

The `frontend/playwright-e2e-test.sh` script handles everything:

```bash
./frontend/playwright-e2e-test.sh
```

**What it does:**
1. Installs Go and Node.js dependencies
2. Builds the frontend
3. Starts the backend server (in-memory database)
4. Installs Playwright browsers
5. Runs all tests
6. Cleans up on exit (stops server, removes temp files)

**Options:**
```bash
# Run specific tests
./frontend/playwright-e2e-test.sh --grep "import"
./frontend/playwright-e2e-test.sh --grep "2FA"
./frontend/playwright-e2e-test.sh git-sync

# Run with UI (interactive)
./frontend/playwright-e2e-test.sh --ui

# Run with visible browser
./frontend/playwright-e2e-test.sh --headed

# Run in debug mode
./frontend/playwright-e2e-test.sh --debug

# Run with HTML report
./frontend/playwright-e2e-test.sh
npx playwright show-report
```

---

## Test Suite Overview

### Core Tests: 26 tests (all must pass)

#### Authentication (6 tests)

| Test | Description |
|------|-------------|
| `register new user` | Complete signup flow |
| `login with correct password` | Valid login |
| `login with wrong password` | Invalid login shows error |
| `setup 2FA during registration` | **Real TOTP code generation and login** |
| `logout and session cleanup` | Session cleared on logout |
| `import private key during setup` | Import key from exported account |

#### Entry Management (6 tests)

| Test | Description |
|------|-------------|
| `create new entry` | Manual password entry |
| `create entry with generated password` | Password generator |
| `view entry details` | View entry content |
| `create entry in nested folder` | Nested paths (e.g., `Folder/Entry`) |
| `search entries` | Filter by name |
| `multiple entries - list view` | List multiple entries |

#### Import (1 test)

| Test | Description |
|------|-------------|
| `import entries - account migration flow` | **Export → Delete Account → Import to new account** |

#### Settings (13 tests)

| Test | Description |
|------|-------------|
| `open settings modal` | Open settings |
| `export entries` | Export tar.gz |
| `export private key` | Export encrypted private key |
| `export public key` | Export public key |
| `import entries` | Import dialog UI |
| `setup 2FA from settings` | **Real TOTP code generation and login** |
| `clear local data - cancel` | Cancel clear data |
| `delete account - cancel` | Cancel delete account |
| `version information displayed` | Version info shown |
| `logout from settings` | Logout via settings |
| `git sync button visible` | Git sync UI |
| `clear local data only` | Clear local data (keep server) |
| `full account deletion` | Delete account completely |

### Git Sync Tests: 8 tests

| Test | Description |
|------|-------------|
| `configure git sync with valid URL and PAT` | Configure with real Gitea repo |
| `configure git sync - cancel closes modal` | Cancel configuration |
| `configure git sync - validation (empty fields)` | Empty field validation |
| `error message stays visible on pull error` | Network error handling |
| `pull with wrong passphrase shows error` | Wrong passphrase error |
| `git sync button opens configuration modal` | Modal opens correctly |
| `create entry then push to git` | Push with real entries |
| `pull entries from git after configure` | Pull and sync entries |

---

## Git Sync Test Configuration

The Git Sync E2E tests require a real Git repository to test push/pull functionality.

### Option 1: Local .env File (Recommended for Development)

Create a `.env` file in the project root (already gitignored):

```bash
# Copy example and edit
cp .env.example .env
nano .env  # or your preferred editor
```

Add your Git credentials:

```bash
# E2E Test Configuration
WEBPASS_REPO_URL="https://gitea.example.com/user/password-store.git"
WEBPASS_REPO_PAT="your-personal-access-token"
```

Then run tests normally:

```bash
./frontend/playwright-e2e-test.sh git-sync
```

### Option 2: Environment Variables

Set environment variables before running tests:

```bash
export WEBPASS_REPO_URL="https://gitea.example.com/user/password-store.git"
export WEBPASS_REPO_PAT="your-personal-access-token"
./frontend/playwright-e2e-test.sh git-sync
```

### Option 3: GitHub Secrets (CI/CD)

For GitHub Actions, add these secrets to your repository:

- `WEBPASS_REPO_URL` - Git repository URL
- `WEBPASS_REPO_PAT` - Personal Access Token

The test script will automatically load them.

### Test Output

The test script will show:

```
[INFO] Test configuration:
[INFO]   WEBPASS_REPO_URL: https://gitea.example.com/user/password-store.git
[INFO]   WEBPASS_REPO_PAT: ***REDACTED***
```

If credentials are not set, Git Sync tests will be **skipped** with a warning:

```
[WARN]   WEBPASS_REPO_URL: not set (git-sync tests will be skipped)
[WARN]   WEBPASS_REPO_PAT: not set (git-sync tests will be skipped)
```

---

## Running Tests

### All Tests

```bash
./frontend/playwright-e2e-test.sh
```

### Specific Tests

```bash
# By name pattern
npx playwright test --grep "import"
npx playwright test --grep "2FA"
npx playwright test --grep "login"

# By file
npx playwright test tests/e2e/auth.spec.ts
npx playwright test tests/e2e/import.spec.ts
npx playwright test tests/e2e/git-sync.spec.ts

# By line number
npx playwright test tests/e2e/auth.spec.ts:171
```

### Interactive Mode

```bash
# UI mode (watch tests, retry, debug)
npx playwright test --ui

# Debug mode (step through, inspect)
npx playwright test --debug

# Visible browser (not headless)
npx playwright test --headed
```

### View Report

```bash
# Open HTML report
npx playwright show-report
```

---

## Test Architecture

### Test Files

```
frontend/tests/
├── e2e/
│   ├── auth.spec.ts          # Authentication tests
│   ├── entries.spec.ts       # Entry management tests
│   ├── import.spec.ts        # Import tests
│   ├── settings.spec.ts      # Settings tests
│   └── git-sync.spec.ts      # Git sync tests
└── helpers/
    ├── api.ts                # API helpers for setup/teardown
    └── test-data.ts          # Test data generators
```

### Test Patterns

**Export → Delete → Import Pattern**

Used for testing import and key import without GPG CLI:

```typescript
// 1. Create Account A
const accountA = generateTestUser();
// ... register and login ...

// 2. Create entries and export
await page.getByRole('button', { name: 'Entry' }).click();
// ... create entry ...

const [keyDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: '📤 Export Private Key' }).click(),
]);
const keyFilePath = await keyDownload.path();

// 3. Delete Account A
await page.getByRole('button', { name: '☠️ Permanently Delete Account' }).click();

// 4. Create Account B and import Account A's data
// ... register Account B ...
await page.locator('input[type="file"]').setInputFiles(keyFilePath);
```

**Real TOTP Code Generation**

Used for testing 2FA without manual codes:

```typescript
// Extract TOTP secret from UI
const secretElement = page.locator('.totp-secret');
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

// Enter code
await page.getByPlaceholder('6-digit code').fill(totpCode);
await page.getByRole('button', { name: /Verify/i }).click();
```

---

## Writing Tests

### Basic Test Structure

```typescript
import { test, expect } from '@playwright/test';
import { generateTestUser } from '../helpers/test-data';
import { apiDeleteAccount } from '../helpers/api';

test.describe('My Feature', () => {
  let testUser: TestUser;

  test.afterEach(async () => {
    // Cleanup after each test
    if (testUser) {
      await apiDeleteAccount(testUser).catch(() => {});
    }
  });

  test('does something', async ({ page }) => {
    // Test code here
    await page.goto('/');
    // ...
  });
});
```

### Best Practices

1. **Use `test.afterEach` for cleanup**
   - Always delete test accounts
   - Clean up temp files

2. **Use specific selectors**
   ```typescript
   // Good
   await page.getByRole('button', { name: '📥 Import' }).click();

   // Avoid
   await page.click('button:nth-child(3)');
   ```

3. **Wait for elements properly**
   ```typescript
   // Good
   await page.waitForSelector('text=Success', { timeout: 10000 });

   // Avoid
   await page.waitForTimeout(5000); // Fixed wait
   ```

4. **Use modal-aware selectors**
   ```typescript
   // For elements inside modal dialog
   const importDialog = page.locator('.modal:has-text("Import Password Store")');
   const importButton = importDialog.getByRole('button', { name: '📥 Import' });
   await importButton.click();
   ```

---

## Troubleshooting

### Tests Fail with "address already in use"

Another process is using port 8080. Kill it:

```bash
fuser -k 8080/tcp
# or
lsof -ti:8080 | xargs kill -9
```

### Browser Not Found

Install Playwright browsers:

```bash
cd frontend
npx playwright install chromium
```

### Browser Installation Fails

```bash
# Install with dependencies (requires sudo)
npx playwright install --with-deps chromium

# Or without dependencies (if already installed)
npx playwright install chromium
```

### Tests Timeout

```bash
# Increase timeout for specific test
test('slow test', async ({ page }) => {
  test.setTimeout(120000); // 2 minutes
  // ...
});
```

### Server Not Starting

```bash
# Check if port 8080 is in use
lsof -i :8080

# Kill existing process
kill -9 <PID>

# Or use different port
PORT=8081 ./frontend/playwright-e2e-test.sh
```

### Flaky Tests

```bash
# Run multiple times to check stability
npx playwright test --repeat-each=5

# Run with retries
npx playwright test --retries=2
```

### Git Sync Tests Failing

1. Verify Gitea credentials are correct
2. Ensure the repository exists and is accessible
3. Check PAT has correct permissions (read/write repository)
4. Verify network connectivity to Gitea server

---

## CI/CD Integration

The `integration-test.yml` workflow runs E2E tests on:
- Push to `main`
- Pull requests to `main`

**Artifacts uploaded:**
- HTML report (7 days)
- Screenshots/videos (7 days)
- JSON results (7 days)

**View artifacts:**
1. Go to GitHub Actions
2. Select workflow run
3. Download artifacts
4. Open `playwright-html-report/index.html` in browser

---

## Security Notes

- **Never commit `.env` file** - it's gitignored by default
- **Use separate test repository** - don't use production data
- **Rotate PAT regularly** - especially if accidentally exposed
- **Use GitHub Secrets in CI** - never hardcode credentials in workflow files

---

## Test Coverage

### Current Coverage

- ✅ User registration flow
- ✅ Login/logout (with 2FA)
- ✅ Entry CRUD operations
- ✅ Export/import (account migration)
- ✅ Settings management
- ✅ Account deletion
- ✅ Git sync UI
- ✅ Git sync push/pull with real entries

### Future Tests

- [ ] Git sync conflict scenarios (requires manipulating remote repo directly)
- [ ] Batch entry operations
- [ ] Offline mode
- [ ] Cross-browser testing (Firefox, Safari)

---

## Resources

- [Playwright Documentation](https://playwright.dev)
- [Playwright Test Runner](https://playwright.dev/docs/test-intro)
- [Codegen Tool](https://playwright.dev/docs/codegen) - Record tests by interacting with browser
- [Trace Viewer](https://playwright.dev/docs/trace-viewer) - Debug tests with detailed traces

---

**Last Updated**: 2026-03-24  
**Test Count**: 34 tests total (26 core + 8 git-sync, all passing)
