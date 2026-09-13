// Serves the LOCAL index.html + assets/ui/* + theme layers over the real
// production origin; every other request (api, games, icons) hits production.
import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const REPO = path.resolve('redportal');
const THEMES_DIR = 'C:/Stuff/RedTesting/red-portal-DKR-LCL-main/assets/themes';
const MOBILE = process.argv.includes('--mobile');
const b = await chromium.launch();
const c = await b.newContext(MOBILE ? { viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true } : { viewport: { width: 1600, height: 900 } });
await c.route('https://redportal.dpdns.org/**', route => {
  const u = new URL(route.request().url());
  if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(REPO, 'index.html')) });
  if (u.pathname.startsWith('/assets/ui/')) {
    const f = path.join(REPO, u.pathname);
    const ct = f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'application/javascript' : 'application/json';
    return route.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(f) });
  }
  route.continue();
});
await c.route('https://assets.redportal.dpdns.org/assets/themes/*/**', route => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace('/assets/themes/', ''));
  const f = path.join(THEMES_DIR, rel);
  fs.existsSync(f) ? route.fulfill({ status: 200, contentType: f.endsWith('.gif') ? 'image/gif' : 'image/png', body: fs.readFileSync(f) }) : route.continue();
});
const p = await c.newPage();
const errs = [], failed = [];
p.on('pageerror', e => errs.push(e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 140)); });
p.on('response', r => { if (r.status() >= 400 && !/assets\/icons\//.test(r.url())) failed.push(r.status() + ' ' + r.url().slice(0, 100)); });
await p.goto('https://redportal.dpdns.org/', { waitUntil: 'load' });
await p.click('#intro-overlay').catch(() => {});
await p.waitForTimeout(6000);
const st = () => p.evaluate(() => ({ view: window.RPApp.view, home: window.RPApp.homeWheel.selected.key, list: window.RPApp.listWheel && window.RPApp.listWheel.selected && window.RPApp.listWheel.selected.label, count: window.RPApp.listWheel && window.RPApp.listWheel.count, grids: Object.fromEntries(Object.entries(window.RedPortal.grids()).map(([k, v]) => [k, v.length])), layers: document.querySelectorAll('.px-set.is-in .px-layer').length }));
console.log('home', await st());
await p.screenshot({ path: `shots/40-prod-home${MOBILE ? '-m' : ''}.png` });
await p.waitForTimeout(6000);
for (const key of ['emulation', 'Testing', 'apps']) {
  await p.evaluate(k => window.RPApp.homeWheel.selectKey(k), key); await p.waitForTimeout(800);
  await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(700);
  console.log(key, await st());
  await p.screenshot({ path: `shots/41-prod-${key}${MOBILE ? '-m' : ''}.png` });
  await p.keyboard.press('Escape'); await p.waitForTimeout(1300);
}
console.log('errors:', errs); console.log('failed (non-icon):', failed);
await b.close();
