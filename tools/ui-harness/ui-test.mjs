// Drives the redesigned UI in headless Chromium and screenshots each state.
// usage: node ui-test.mjs [baseUrl] [outDir] [--mobile] [--live]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const BASE = args[0] || 'http://127.0.0.1:8811/';
const OUT = args[1] || path.resolve('shots');
const MOBILE = flags.has('--mobile');
const THEMES_DIR = 'C:/Stuff/RedTesting/red-portal-DKR-LCL-main/assets/themes';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: MOBILE ? { width: 412, height: 860 } : { width: 1600, height: 900 },
  deviceScaleFactor: 1,
  hasTouch: MOBILE,
  isMobile: MOBILE,
});
// theme layers are not on R2 yet: serve them from the sync folder
await context.route('https://assets.redportal.dpdns.org/assets/themes/**', route => {
  const u = new URL(route.request().url());
  const rel = decodeURIComponent(u.pathname.replace('/assets/themes/', ''));
  const file = path.join(THEMES_DIR, rel);
  if (fs.existsSync(file)) {
    const ext = path.extname(file).toLowerCase();
    route.fulfill({ status: 200, contentType: ext === '.gif' ? 'image/gif' : 'image/png', body: fs.readFileSync(file) });
  } else route.fulfill({ status: 404, body: 'no' });
});

const page = await context.newPage();
const errors = [];
const failed = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('requestfailed', r => failed.push(r.url() + ' ' + (r.failure() || {}).errorText));
page.on('response', r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });

let n = 0;
const shot = async name => { await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) }); };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
// skip the intro
await page.waitForSelector('#intro-overlay', { timeout: 3000 }).catch(() => {});
await page.click('#intro-overlay').catch(() => {});
await page.waitForTimeout(1600);
await shot('home');

const state = async () => page.evaluate(() => ({
  view: window.RPApp.view, sel: window.RPApp.homeWheel.selected && window.RPApp.homeWheel.selected.key,
  list: window.RPApp.listWheel && window.RPApp.listWheel.selected && window.RPApp.listWheel.selected.label,
  layers: document.querySelectorAll('.px-layer').length, hasLayers: document.body.classList.contains('has-layers'),
}));
console.log('home', await state());

// keyboard: down x2, screenshot mid-animation and settled
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(90);
await shot('home-mid-anim');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(700);
await shot('home-down2');
console.log('after 2 down', await state());

// mouse steering: park pointer low in the wheel column, move a bit
if (!MOBILE) {
  await page.mouse.move(1350, 760);
  await page.waitForTimeout(80);
  await page.mouse.move(1352, 790);
  await page.waitForTimeout(500);
  await shot('home-steer');
  console.log('after steer', await state());
  await page.mouse.move(1350, 450);
  await page.waitForTimeout(600);
}

// go to games via wheel + enter
await page.evaluate(() => window.RPApp.homeWheel.selectKey('games'));
await page.waitForTimeout(700);
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
await shot('zoom-into-games');
await page.waitForTimeout(1200);
await shot('games-list');
console.log('games', await state());

await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(900);
await shot('games-down3');
console.log('games down3', await state());

// search
await page.keyboard.type('bal');
await page.waitForTimeout(600);
await shot('games-search');
console.log('search', await state());
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// launch: Enter should open a new tab
const [popup] = await Promise.all([
  context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
  page.keyboard.press('Enter'),
]);
console.log('launch popup url:', popup ? popup.url().slice(0, 60) : 'NONE');
if (popup) { await popup.waitForTimeout(1500); await popup.close(); }

// back to home via Escape
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);
await shot('back-home');
console.log('after esc', await state());

// panel view: Requests
await page.evaluate(() => window.RPApp.homeWheel.selectKey('form'));
await page.waitForTimeout(700);
await page.keyboard.press('Enter');
await page.waitForTimeout(1300);
await shot('panel-requests');
console.log('panel', await state());
await page.goBack();
await page.waitForTimeout(1300);
await shot('history-back');
console.log('after history back', await state());

// emulation list
await page.evaluate(() => window.RPApp.homeWheel.selectKey('emulation'));
await page.waitForTimeout(700);
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await shot('emulation-list');
console.log('emulation', await state());
await page.keyboard.press('Escape');
await page.waitForTimeout(1200);

// theme switch
await page.evaluate(() => window.RedPortal.applyTheme('Geometry Dash'));
await page.waitForTimeout(2500);
await shot('theme-geometrydash');
console.log('theme', await state());
await page.evaluate(() => window.RedPortal.applyTheme('rain'));
await page.waitForTimeout(2500);
await shot('theme-rain');
await page.evaluate(() => window.RedPortal.applyTheme('default'));
await page.waitForTimeout(1500);

console.log('\nconsole errors:', errors.length); errors.forEach(e => console.log('  ', e.slice(0, 200)));
console.log('failed/4xx requests:', failed.length); failed.slice(0, 30).forEach(e => console.log('  ', e.slice(0, 160)));
await browser.close();
