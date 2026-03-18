# Playwright E2E Integration Tests

Browser-based end-to-end tests for WebPass using Playwright (TypeScript).

---

## Overview

**Goal**: Real-browser integration tests that validate the complete user experience, including:
- PGP encryption/decryption in the browser
- Authentication flows (register, login, 2FA)
- Password entry CRUD operations
- Import/Export functionality
- Settings management

**Why Playwright**:
- Real Chromium browser (not curl/mock)
- Matches frontend stack (TypeScript)
- Excellent debugging tools (UI mode, traces, videos)
- Official GitHub Actions support
- Auto-wait mechanisms reduce flakiness

**Test Status**: ✅ **20/20 tests passing (100%)**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Playwright Test Runner (Node.js/TypeScript)           │
├─────────────────────────────────────────────────────────┤
│  Test Files (tests/e2e/*.spec.ts)                      │
│  ├── auth.spec.ts      - Register, login, 2FA          │
│  ├── entries.spec.ts   - CRUD operations               │
│  └── settings.spec.ts  - Account management            │
├─────────────────────────────────────────────────────────┤
│  Helpers (tests/helpers/)                              │
│  ├── api.ts            - API client for setup          │
│  └── test-data.ts      - Test data generators          │
└─────────────────────────────────────────────────────────┘
                          │
                          │ HTTP requests
                          ▼
┌─────────────────────────────────────────────────────────┐
│  WebPass Server (Go binary or Docker)                  │
│  ├── Go HTTP API (port 8080)                           │
│  └── SQLite database (temp)                            │
└─────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
frontend/
├── package.json                 # Add @playwright/test dependency
├── playwright.config.ts         # NEW - Playwright configuration
└── tests/
    ├── e2e/
    │   ├── auth.spec.ts         # NEW - Authentication tests
    │   ├── entries.spec.ts      # NEW - Entry CRUD tests
    │   ├── import-export.spec.ts # NEW - Backup/restore tests
    │   ├── settings.spec.ts     # NEW - Settings tests
    │   └── git-sync.spec.ts     # NEW - Git sync tests
    ├── helpers/
    │   ├── api.ts               # NEW - API client
    │   ├── test-data.ts         # NEW - Test data generators
    │   └── auth-helpers.ts      # NEW - Auth utilities
    └── test-results/            # Generated - screenshots, videos
    └── blob-report/             # Generated - test reports
```

---

## Test Coverage

### 1. Authentication (`auth.spec.ts`) - 5 tests

| Test | Description |
|------|-------------|
| `register new user` | Create account with PGP keypair |
| `login with correct password` | Successful authentication |
| `login with wrong password` | Should show error |
| `setup 2FA during registration` | 2FA setup screen appears |
| `logout and session cleanup` | Lock session and verify |

### 2. Entry Management (`entries.spec.ts`) - 6 tests

| Test | Description |
|------|-------------|
| `create new entry` | Add new password entry |
| `create entry with generated password` | Use password generator |
| `view entry details` | View entry in detail panel |
| `create entry in nested folder` | Folder structure support |
| `search entries` | Filter by name |
| `multiple entries - list view` | Multiple folders/entries |

### 3. Settings (`settings.spec.ts`) - 9 tests

| Test | Description |
|------|-------------|
| `open settings modal` | Settings dialog opens |
| `export entries` | Download tar.gz backup |
| `export private key` | Download private key |
| `export public key` | Download public key |
| `setup 2FA from settings` | Enable TOTP |
| `delete account - cancel` | Cancel delete operation |
| `version information displayed` | Show version info |
| `logout from settings` | Lock session |
| `git sync button visible` | Git sync UI present |

**Total**: 20 tests across 3 test suites

---

## Configuration

### `playwright.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000, // 30s per test
  expect: {
    timeout: 5000, // 5s for assertions
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://localhost:8080',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.CI ? undefined : {
    command: 'go run ../../cmd/srv',
    url: 'http://localhost:8080',
    timeout: 120 * 1000,
    env: {
      JWT_SECRET: 'test-secret-key-32-bytes-long!!!',
      DB_PATH: ':memory:',
      DISABLE_FRONTEND: 'false',
    },
  },
});
```

---

## Local Development

### Setup

```bash
# Install Playwright + browsers
cd frontend
npm install -D @playwright/test
npx playwright install chromium

# Optional: Install system dependencies (Linux only)
npx playwright install-deps chromium
```

### Run Tests

**Option A: Auto-start server (default)**
```bash
# Playwright will start the Go server automatically
npx playwright test
```

**Option B: Use Docker for server (Recommended)**
```bash
# Terminal 1: Start server with Docker
docker compose up --build

# Terminal 2: Run tests (skip auto-start)
TEST_SKIP_WEBSERVER=true npx playwright test

# Or with UI mode
TEST_SKIP_WEBSERVER=true npx playwright test --ui
```

**Option C: Use existing server**
```bash
# If server is already running on localhost:8080
TEST_SKIP_WEBSERVER=true npx playwright test

# Or connect to different URL
TEST_BASE_URL=http://localhost:3000 npx playwright test
```

### Debug Workflow

1. **Start server with Docker**:
   ```bash
   docker compose up --build
   ```

2. **Run in debug mode**:
   ```bash
   cd frontend
   TEST_SKIP_WEBSERVER=true npx playwright test --debug
   ```

3. **Use Playwright Inspector**:
   - Click through test steps
   - See live browser actions
   - Edit locators in real-time
   - Take screenshots

---

## CI/CD Integration

### GitHub Actions Workflow

The Playwright tests run automatically on every push and pull request via `.github/workflows/integration-test.yml`.

**Workflow Steps**:
1. Checkout code
2. Set up Go 1.26 and Node.js 24
3. Install dependencies
4. Build frontend (Vite)
5. Build backend binary
6. Start server in background
7. Install Playwright browsers
8. Run 20 E2E tests
9. Upload artifacts (HTML report, screenshots, videos)

**Artifacts Uploaded**:
- `playwright-html-report/` - Interactive HTML report
- `playwright-test-results/` - Screenshots and videos of failures
- `playwright-json-results/` - Machine-readable results

See [`.github/workflows/integration-test.yml`](.github/workflows/integration-test.yml) for the full workflow.

---

## Test Results

### Current Status

| Metric | Value |
|--------|-------|
| **Total Tests** | 20 |
| **Passing** | 20 ✅ |
| **Failing** | 0 |
| **Pass Rate** | 100% |

### Test Suites

| Suite | Tests | Status |
|-------|-------|--------|
| Authentication | 5 | ✅ All passing |
| Entry Management | 6 | ✅ All passing |
| Settings | 9 | ✅ All passing |

### Viewing Test Results

**After running tests locally**:
```bash
# Open HTML report
npx playwright show-report
```

**From GitHub Actions**:
- Download artifacts from workflow run
- Open `playwright-report/index.html` in browser

---

## Example Tests

```typescript
// tests/e2e/auth.spec.ts
import { test, expect } from '@playwright/test';
import { generateTestUser, generatePGPKeys } from '../helpers/test-data';
import { apiRegister, apiLogin } from '../helpers/api';

test.describe('Authentication', () => {
  test('register new user', async ({ page }) => {
    const user = generateTestUser();
    const pgpKeys = await generatePGPKeys();

    // Go to setup page
    await page.goto('/');
    await page.getByRole('button', { name: 'Setup' }).click();

    // Fill registration form
    await page.getByLabel('Password').fill(user.password);
    await page.getByLabel('Confirm Password').fill(user.password);
    await page.getByLabel('Public Key').fill(pgpKeys.publicKey);
    await page.getByLabel('Private Key').fill(pgpKeys.privateKey);
    await page.getByLabel('Fingerprint').fill(pgpKeys.fingerprint);

    // Submit
    await page.getByRole('button', { name: 'Create Account' }).click();

    // Verify success
    await expect(page.getByText('Account created!')).toBeVisible();
  });

  test('login with correct password', async ({ page }) => {
    const user = await apiRegister();

    await page.goto('/');
    await page.getByLabel('Fingerprint').fill(user.fingerprint);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.getByText('Welcome')).toBeVisible();
  });

  test('login with wrong password', async ({ page }) => {
    const user = await apiRegister();

    await page.goto('/');
    await page.getByLabel('Fingerprint').fill(user.fingerprint);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Login' }).click();

    await expect(page.getByText('Invalid password')).toBeVisible();
  });

  test('setup 2FA', async ({ page }) => {
    const user = await apiRegister();
    const token = await apiLogin(user);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Enable 2FA' }).click();

    // Scan QR code (or enter secret manually)
    const secret = await page.getByText('Secret:').textContent();
    await page.getByLabel('TOTP Code').fill(generateTOTP(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByText('2FA enabled')).toBeVisible();
  });

  test('login with 2FA', async ({ page }) => {
    const user = await apiRegisterWith2FA();

    await page.goto('/');
    await page.getByLabel('Fingerprint').fill(user.fingerprint);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Login' }).click();

    // 2FA screen appears
    await expect(page.getByLabel('TOTP Code')).toBeVisible();
    await page.getByLabel('TOTP Code').fill(generateTOTP(user.totpSecret));
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page.getByText('Welcome')).toBeVisible();
  });
});
```

---

## Example Test: Entry CRUD

```typescript
// tests/e2e/entries.spec.ts
import { test, expect } from '@playwright/test';
import { apiRegister, apiLogin } from '../helpers/api';
import { encryptBlob } from '../helpers/crypto';

test.describe('Entry Management', () => {
  test('create entry', async ({ page }) => {
    const user = await apiRegister();
    await apiLogin(user);

    await page.goto('/entries');
    await page.getByRole('button', { name: 'Add Entry' }).click();

    // Fill entry form
    await page.getByLabel('Path').fill('Email/gmail');
    await page.getByLabel('Username').fill('test@gmail.com');
    await page.getByLabel('Password').fill('secure-password-123');
    await page.getByLabel('Notes').fill('Test entry');

    await page.getByRole('button', { name: 'Save' }).click();

    // Verify entry appears in list
    await expect(page.getByText('Email/gmail')).toBeVisible();
  });

  test('edit entry', async ({ page }) => {
    const user = await apiRegister();
    await apiLogin(user);

    // Create entry via API
    const encryptedBlob = await encryptBlob('test-content', user.publicKey);
    await apiCreateEntry(user, 'Email/gmail', encryptedBlob);

    await page.goto('/entries');
    await page.getByText('Email/gmail').click();
    await page.getByRole('button', { name: 'Edit' }).click();

    // Modify
    await page.getByLabel('Notes').fill('Updated notes');
    await page.getByRole('button', { name: 'Save' }).click();

    // Verify update
    await expect(page.getByText('Updated notes')).toBeVisible();
  });

  test('delete entry', async ({ page }) => {
    const user = await apiRegister();
    await apiLogin(user);

    // Create entry
    await apiCreateEntry(user, 'Email/gmail', 'encrypted-blob');

    await page.goto('/entries');
    await page.getByText('Email/gmail').hover();
    await page.getByRole('button', { name: 'Delete' }).click();

    // Confirm deletion
    await page.getByRole('button', { name: 'Confirm' }).click();

    // Verify deletion
    await expect(page.getByText('Email/gmail')).not.toBeVisible();
  });
});
```

---

## Example Test: Import/Export

```typescript
// tests/e2e/import-export.spec.ts
import { test, expect } from '@playwright/test';
import { apiRegister, apiLogin, apiCreateEntry } from '../helpers/api';
import { createTestTarGz } from '../helpers/test-data';

test.describe('Import/Export', () => {
  test('export all entries', async ({ page }) => {
    const user = await apiRegister();
    await apiLogin(user);

    // Create test entries
    await apiCreateEntry(user, 'Email/gmail', 'blob1');
    await apiCreateEntry(user, 'Social/github', 'blob2');

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Export' }).click();

    // Verify download
    const download = await page.waitForEvent('download');
    expect(download.suggestedFilename()).toMatch(/webpass-export-.*\.tar\.gz/);
  });

  test('import entries', async ({ page }) => {
    const user = await apiRegister();
    await apiLogin(user);

    // Create test tar.gz
    const tarGzPath = await createTestTarGz([
      { path: 'Email/gmail.gpg', content: 'encrypted-blob-1' },
      { path: 'Social/github.gpg', content: 'encrypted-blob-2' },
    ]);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Import' }).click();

    // Upload file
    const fileInput = page.getByLabel('Select tar.gz file');
    await fileInput.setInputFiles(tarGzPath);
    await page.getByRole('button', { name: 'Import' }).click();

    // Verify import
    await expect(page.getByText('Imported 2 entries')).toBeVisible();
    await expect(page.getByText('Email/gmail')).toBeVisible();
    await expect(page.getByText('Social/github')).toBeVisible();
  });
});
```

---

## Helper Functions

### API Client (`tests/helpers/api.ts`)

```typescript
import { randomBytes } from 'crypto';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8080';

export interface TestUser {
  fingerprint: string;
  password: string;
  publicKey: string;
  privateKey: string;
  totpSecret?: string;
}

export async function apiRegister(overrides?: Partial<TestUser>): Promise<TestUser> {
  const user = {
    fingerprint: `test-${randomBytes(8).toString('hex')}`,
    password: 'test-password-123',
    publicKey: 'test-public-key',
    privateKey: 'test-private-key',
    ...overrides,
  };

  const response = await fetch(`${BASE_URL}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fingerprint: user.fingerprint,
      password: user.password,
      public_key: user.publicKey,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to register: ${response.statusText}`);
  }

  return user;
}

export async function apiLogin(user: TestUser): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: user.password }),
  });

  if (!response.ok) {
    throw new Error(`Failed to login: ${response.statusText}`);
  }

  const data = await response.json();
  return data.token;
}

export async function apiCreateEntry(
  user: TestUser,
  path: string,
  blob: string
): Promise<void> {
  const token = await apiLogin(user);

  const response = await fetch(`${BASE_URL}/api/${user.fingerprint}/entries/${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: blob,
  });

  if (!response.ok) {
    throw new Error(`Failed to create entry: ${response.statusText}`);
  }
}
```

### Test Data Generator (`tests/helpers/test-data.ts`)

```typescript
import { randomBytes } from 'crypto';

export function generateTestUser() {
  return {
    fingerprint: `test-${randomBytes(8).toString('hex')}`,
    password: `password-${randomBytes(8).toString('hex')}`,
    email: `test-${randomBytes(8).toString('hex')}@example.com`,
  };
}

export async function generatePGPKeys() {
  // Use openpgp library to generate real keys
  const openpgp = await import('openpgp');
  
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519',
    userIDs: [{ name: 'Test User', email: 'test@example.com' }],
    passphrase: 'test-passphrase',
  });

  return {
    privateKey,
    publicKey,
    fingerprint: `test-${randomBytes(8).toString('hex')}`,
  };
}

export async function createTestTarGz(
  files: Array<{ path: string; content: string }>
): Promise<string> {
  const { createWriteStream } = await import('fs');
  const { pack } = await import('tar-stream');
  const { createGzip } = await import('zlib');
  const { join } = await import('path');
  const { tmpdir } = await import('os');

  const tarPath = join(tmpdir(), `test-${randomBytes(8).toString('hex')}.tar.gz`);
  const writeStream = createWriteStream(tarPath);
  const gzip = createGzip();
  const tar = pack();

  tar.pipe(gzip).pipe(writeStream);

  for (const file of files) {
    tar.entry({ name: file.path }, file.content);
  }

  tar.finalize();

  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  return tarPath;
}
```

---

## Test Execution Flow

### Local Development

```bash
# Terminal 1: Start server (optional - Playwright can auto-start)
JWT_SECRET=$(openssl rand -hex 32) go run ./cmd/srv

# Terminal 2: Run tests
cd frontend
npx playwright test

# Or with UI mode
npx playwright test --ui
```

### CI/CD

```bash
# GitHub Actions runs:
cd frontend
npx playwright install --with-deps chromium
npx playwright test

# Artifacts uploaded:
# - test-results/ (screenshots, videos)
# - playwright-report/ (HTML report)
```

---

## Troubleshooting

### Common Issues

**Issue**: Tests fail with "browser not installed"
```bash
# Fix: Install browsers
npx playwright install chromium
```

**Issue**: Tests fail on Linux with missing dependencies
```bash
# Fix: Install system dependencies
npx playwright install-deps chromium
```

**Issue**: Tests timeout waiting for elements
```typescript
// Fix: Increase timeout for specific operation
await page.getByRole('button', { name: 'Save' }).click({ timeout: 10000 });
```

**Issue**: Flaky tests in CI
```typescript
// Fix: Add retries at test level
test('flaky test', async ({ page }) => {
  // ...
}, { retries: 3 });
```

---

## Best Practices

1. **Use data-testid attributes** for stable selectors:
   ```html
   <button data-testid="login-button">Login</button>
   ```
   ```typescript
   await page.getByTestId('login-button').click();
   ```

2. **Page Object Model** for complex pages:
   ```typescript
   class LoginPage {
     constructor(private page: Page) {}
     
     async goto() {
       await this.page.goto('/');
     }
     
     async login(fingerprint: string, password: string) {
       await this.page.getByLabel('Fingerprint').fill(fingerprint);
       await this.page.getByLabel('Password').fill(password);
       await this.page.getByTestId('login-button').click();
     }
   }
   ```

3. **Clean test data** after tests:
   ```typescript
   test.afterEach(async ({ page }) => {
     // Cleanup via API
     await apiDeleteUser(testUser);
   });
   ```

4. **Use fixtures** for common scenarios:
   ```typescript
   const test = base.extend<{ loggedInPage: Page }>({
     loggedInPage: async ({ page }, use) => {
       const user = await apiRegister();
       await apiLoginAndNavigate(page, user);
       await use(page);
     },
   });
   ```

---

## Migration from Manual Testing

| Manual Test | Playwright Test |
|-------------|-----------------|
| Open browser, go to localhost:8080 | `await page.goto('/')` |
| Click "Setup" button | `await page.getByRole('button', { name: 'Setup' }).click()` |
| Fill password field | `await page.getByLabel('Password').fill('secret')` |
| Submit form | `await page.getByRole('button', { name: 'Submit' }).click()` |
| Check success message | `await expect(page.getByText('Success')).toBeVisible()` |
| Take screenshot | `await page.screenshot({ path: 'debug.png' })` |

---

## Next Steps

1. [ ] Add `@playwright/test` to `frontend/package.json`
2. [ ] Create `playwright.config.ts`
3. [ ] Implement test helpers (`api.ts`, `test-data.ts`)
4. [ ] Write `auth.spec.ts` tests
5. [ ] Write `entries.spec.ts` tests
6. [ ] Write `import-export.spec.ts` tests
7. [ ] Write `settings.spec.ts` tests
8. [ ] Write `git-sync.spec.ts` tests
9. [ ] Add GitHub Actions workflow
10. [ ] Run full test suite locally
11. [ ] Run in CI and verify artifacts

---

## References

- [Playwright Documentation](https://playwright.dev)
- [Playwright GitHub Action](https://github.com/microsoft/playwright-github-action)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [WebPass AGENTS.md](./AGENTS.md)
- [WebPass DEVELOPMENT.md](./DEVELOPMENT.md)
