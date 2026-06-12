import { test } from '@playwright/test';

test('check console errors', async ({ page }) => {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', err => {
    errors.push({ type: 'pageerror', message: err.message, stack: err.stack?.split('\n').slice(0, 6).join('\n') });
  });
  await page.goto('https://webpass.exe.xyz', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);
  console.log(JSON.stringify(errors, null, 2));
});
