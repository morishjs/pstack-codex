import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Opt-in Mevops integration check. No route mocks, auth bypass or synthetic action log.
export async function runRecoveryEval({ workspace, baseUrl, date, outDir, email, password }) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Live recovery verification requires a local HTTP UI URL');
  if (!email || !password) throw new Error('Existing test credentials must be supplied through MEVOPS_TEST_EMAIL/PASSWORD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) throw new Error('Specify an existing reservation date as YYYY-MM-DD');
  if (fs.existsSync(outDir)) throw new Error('Use a new evidence directory');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const require = createRequire(path.resolve(workspace, 'apps/web/package.json'));
  const { chromium, expect } = require('@playwright/test');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const report = { live: true, surface: 'real-local-browser', baseUrl: url.origin, date, checks: [], passed: false };
  const failures = [];
  page.on('response', response => { if (response.status() >= 400) failures.push({ url: response.url().split('?')[0], status: response.status() }); });
  try {
    await page.goto(new URL('/login', url).href);
    await page.getByPlaceholder('example@email.com').fill(email);
    await page.getByPlaceholder('비밀번호', { exact: true }).fill(password);
    const staff = page.waitForResponse(r => r.url().includes('/v2/staffs/firebase/') && r.status() === 200);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.waitForURL(u => u.pathname === '/reservation', { timeout: 60000 });
    await staff;
    await expect(page.getByRole('link', { name: '예약현황', exact: true })).toBeVisible();
    report.checks.push({ name: 'real-test-login-and-authenticated-api', passed: true });
    await page.goto(new URL('/reservation?date=' + date, url).href);
    const cards = page.locator('[data-reservation-event-body]');
    await expect(cards.first()).toBeAttached({ timeout: 30000 });
    const normalSize = page.getByRole('button', { name: '기본크기', exact: true });
    if (await normalSize.count()) await normalSize.click();
    let card;
    for (let index = 0; index < await cards.count(); index++) {
      const candidate = cards.nth(index);
      const box = await candidate.locator('..').boundingBox();
      if (box && box.width > 20 && box.height > 20 && box.x > 250 && box.x + box.width < 1580 && box.y > 260 && box.y + box.height < 960) { card = candidate; break; }
    }
    if (!card) throw new Error('No existing visible reservation card; choose a date with existing local data');
    await card.click();
    const detailHeading = page.getByRole('heading', { name: /^(예약 정보|내원 현황)$/ });
    await expect(detailHeading).toBeVisible();
    const expectedHeading = await detailHeading.textContent();
    report.expectedDetailHeading = expectedHeading;
    const closeDetails = () => detailHeading.locator('..').locator('button').last().click();
    await closeDetails();
    await expect(detailHeading).toBeHidden();
    for (const edge of ['right', 'bottom']) {
      const box = await card.locator('..').boundingBox();
      report.lastClick = { edge, box };
      await page.mouse.click(edge === 'right' ? box.x + box.width - 1 : box.x + box.width / 2,
        edge === 'bottom' ? box.y + box.height - 0.5 : box.y + box.height / 2);
      await expect(page.getByRole('heading', { name: expectedHeading, exact: true })).toBeVisible({ timeout: 10000 });
      report.checks.push({ name: edge + '-edge-single-click-opens-dialog', passed: true });
      // Evidence stays local; obscure form values and reservation body text.
      await page.screenshot({ path: path.join(outDir, edge + '-edge.png'),
        mask: [page.locator('[data-reservation-event-body]'), page.locator('input, textarea')], maskColor: '#e2e8f0' });
      await closeDetails();
      await expect(detailHeading).toBeHidden();
    }
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    report.failedRequests = failures;
    report.visibleHeadings = await page.getByRole('heading').allTextContents();
    await page.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    await browser.close();
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const value = key => {
    const index = args.indexOf(key);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing ' + key);
    return args[index + 1];
  };
  try {
    if (!args.includes('--live')) throw new Error('Opt in with --live --workspace ABS --base-url http://localhost:PORT --date YYYY-MM-DD --out ABS');
    const report = await runRecoveryEval({ workspace: value('--workspace'), baseUrl: value('--base-url'), date: value('--date'), outDir: value('--out'),
      email: process.env.MEVOPS_TEST_EMAIL, password: process.env.MEVOPS_TEST_PASSWORD });
    console.log(JSON.stringify(report));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
