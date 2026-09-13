import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const THEMES_DIR = 'C:/Stuff/RedTesting/red-portal-DKR-LCL-main/assets/themes';
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true });
await c.route('https://assets.redportal.dpdns.org/assets/themes/**', route => {
  const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace('/assets/themes/', ''));
  const f = path.join(THEMES_DIR, rel);
  fs.existsSync(f) ? route.fulfill({ status: 200, contentType: f.endsWith('.gif') ? 'image/gif' : 'image/png', body: fs.readFileSync(f) }) : route.fulfill({ status: 404, body: '' });
});
const p = await c.newPage();
const errors = [];
p.on('pageerror', e => errors.push(e.message));
await p.goto('http://127.0.0.1:8811/', { waitUntil: 'load' });
await p.waitForTimeout(4200);
const sel = () => p.evaluate(() => ({ home: window.RPApp.homeWheel.selected.key, view: window.RPApp.view.view, list: window.RPApp.listWheel && window.RPApp.listWheel.selected && window.RPApp.listWheel.selected.label }));
console.log('start', await sel());
// tap the item just below the front (APPS)
const below = await p.evaluate(() => { const b = [...document.querySelectorAll('#homeWheel .wh-item')].find(x => x.textContent.includes('Apps')); const r = b.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; });
await p.touchscreen.tap(below[0], below[1]);
await p.waitForTimeout(800);
console.log('after tap Apps', await sel());
// swipe up (finger moves up => later items come up)
await p.evaluate(async () => {
  const z = document.querySelector('#homeWheel .wh-zone');
  const r = z.getBoundingClientRect();
  const x = r.x + r.width * 0.6; let y = r.y + r.height * 0.75;
  const ev = (type, y, extra) => z.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, ...extra }));
  ev('pointerdown', y);
  for (let i = 0; i < 8; i++) { y -= 22; ev('pointermove', y); await new Promise(r => setTimeout(r, 16)); }
  ev('pointerup', y);
});
await p.waitForTimeout(1500);
console.log('after swipe up', await sel());
await p.screenshot({ path: 'shots-m/20-after-swipe.png' });
// tap the front item -> activate (tab)
await p.evaluate(() => window.RPApp.homeWheel.selectKey('games'));
await p.waitForTimeout(800);
const front = await p.evaluate(() => { const b = document.querySelector('#homeWheel .wh-item.is-front'); const r = b.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; });
await p.touchscreen.tap(front[0], front[1]);
await p.waitForTimeout(1500);
console.log('after tap front', await sel());
await p.screenshot({ path: 'shots-m/21-games-list.png' });
// in the list: tap the front game -> should open a new tab
const front2 = await p.evaluate(() => { const b = document.querySelector('#listWheel .wh-item.is-front'); const r = b.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; });
const [popup] = await Promise.all([c.waitForEvent('page', { timeout: 8000 }).catch(() => null), p.touchscreen.tap(front2[0], front2[1])]);
console.log('popup:', popup ? popup.url().slice(0, 40) : 'NONE');
// arrow button hold
await p.touchscreen.tap(30, await p.evaluate(() => document.getElementById('listDown').getBoundingClientRect().y + 20));
await p.waitForTimeout(700);
console.log('after arrow tap', await sel());
console.log('errors', errors);
await b.close();
