import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', msg => {
  if (msg.type() === 'error') {
    console.log(`[${msg.type()}] ${msg.text()}`);
  }
});
page.on('pageerror', err => {
  console.log(`[PAGE ERROR] ${err.message}`);
  console.log(err.stack?.split('\n').slice(0, 6).join('\n'));
});
await page.goto('https://webpass.exe.xyz', { waitUntil: 'networkidle', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));
await browser.close();
