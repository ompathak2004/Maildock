import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  channel: 'chromium',
  ...(process.env.MAILDOCK_TEST_BROWSER
    ? { executablePath: process.env.MAILDOCK_TEST_BROWSER }
    : {}),
});
try {
  const page = await browser.newPage();
  const svg = await readFile('assets/icon.svg', 'utf8');
  await page.setContent(
    `<style>body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
  );
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true });
  }
} finally {
  await browser.close();
}
