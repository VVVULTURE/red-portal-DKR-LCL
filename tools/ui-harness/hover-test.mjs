import { chromium } from 'playwright';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1600, height: 900 } }); const p = await c.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://127.0.0.1:8811/', { waitUntil: 'load' }); await p.waitForTimeout(4200);
const sel = () => p.evaluate(() => window.RPApp.homeWheel.selected.key);
console.log('start', await sel());
// hover the item just below the front (inside the dead band) -> selects it
const apps = await p.evaluate(() => { const b = [...document.querySelectorAll('#homeWheel .wh-item')].find(x => x.textContent.includes('Apps')); const r = b.getBoundingClientRect(); return [r.x + 30, r.y + r.height / 2]; });
await p.mouse.move(apps[0] - 5, apps[1]); await p.mouse.move(apps[0], apps[1]); await p.waitForTimeout(900);
console.log('after hover Apps', await sel());
// click the front item -> activates
const fr = await p.evaluate(() => { const r = document.querySelector('#homeWheel .wh-item.is-front').getBoundingClientRect(); return [r.x + 30, r.y + r.height / 2]; });
await p.mouse.move(fr[0], fr[1]); await p.waitForTimeout(100); await p.mouse.click(fr[0], fr[1]);
await p.waitForTimeout(1500);
console.log('after click front', await p.evaluate(() => window.RPApp.view));
await p.keyboard.press('Escape'); await p.waitForTimeout(1300);
// steer: move to the bottom of the wheel column and keep nudging for 1.2s
const zone = await p.evaluate(() => { const r = document.querySelector('#homeWheel .wh-zone').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
let y = zone[1] + zone[3] * 0.92; const x = zone[0] + zone[2] * 0.5;
const t0 = Date.now(); let i = 0;
while (Date.now() - t0 < 1200) { await p.mouse.move(x + (i++ % 2), y); await p.waitForTimeout(40); }
await p.waitForTimeout(200);
const during = await p.evaluate(() => ({ mode: window.RPApp.homeWheel.mode, pos: window.RPApp.homeWheel.pos.toFixed(2) }));
await p.waitForTimeout(1400);
console.log('steer: during', during, 'after', await p.evaluate(() => ({ mode: window.RPApp.homeWheel.mode, sel: window.RPApp.homeWheel.selected.key, pos: window.RPApp.homeWheel.pos.toFixed(2) })));
// scroll wheel
await p.mouse.move(x, zone[1] + zone[3] * 0.5);
await p.mouse.wheel(0, 150); await p.waitForTimeout(800);
console.log('after scroll +150', await sel());
console.log('errors', errs);
await b.close();
