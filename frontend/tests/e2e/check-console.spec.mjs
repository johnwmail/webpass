import { test, expect } from '@playwright/test';

test('check console errors', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[CONSOLE ERROR] ${msg.text()}`);
      errors.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
    console.log(err.stack?.split('\n').slice(0, 6).join('\n'));
    errors.push({ type: 'pageerror', message: err.message, stack: err.stack?.split('\n').slice(0, 6).join('\n') });
  });
  // Override baseURL to target production
  await page.goto('https://webpass.exe.xyz', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log(`\n=== TOTAL ERRORS: ${errors.length} ===`);
  if (errors.length > 0) {
    console.log(JSON.stringify(errors, null, 2));
  }
  // Take a screenshot to see what the page looks like
  await page.screenshot({ path: '/tmp/webpass-screenshot.png', fullPage: true });
  console.log('Screenshot saved to /tmp/webpass-screenshot.png');
});
