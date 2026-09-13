import { chromium } from 'playwright';
const b = await chromium.launch();

// 1. layers unavailable -> flat wallpaper fallback
if (process.argv[2] !== 'part3') {
  const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
  await c.route('https://assets.redportal.dpdns.org/assets/themes/*/**', r => r.fulfill({ status: 404, body: '' }));
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8811/', { waitUntil: 'load' }); await p.waitForTimeout(3500);
  console.log('fallback:', await p.evaluate(() => ({ hasLayers: document.body.classList.contains('has-layers'), flat: document.getElementById('theme-bg').className, bg: document.getElementById('theme-bg').style.backgroundImage.slice(0, 60) })), errs);
  await c.close();
}
// 2. reduced motion: intro skipped, UI ready, wheel snaps
if (process.argv[2] !== 'part3') {
  const c = await b.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8811/', { waitUntil: 'load' }); await p.waitForTimeout(1200);
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(50);
  console.log('reduced:', await p.evaluate(() => ({ ready: document.body.classList.contains('ui-ready'), intro: !!document.getElementById('intro-overlay'), sel: window.RPApp.homeWheel.selected.key, pos: window.RPApp.homeWheel.pos, motes: document.querySelectorAll('.px-mote').length })), errs);
  await c.close();
}
// 3. Red Proxy reveal chord -> wheel item -> activate -> panel; side panel theme click; sfx toggle
{
  const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await c.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8811/', { waitUntil: 'load' }); await p.click('#intro-overlay').catch(()=>{}); await p.waitForTimeout(1500);
  const count0 = await p.evaluate(() => window.RPApp.homeWheel.count);
  await p.keyboard.press('Control+Alt+Shift+KeyR'); await p.waitForTimeout(300);
  const count1 = await p.evaluate(() => window.RPApp.homeWheel.count);
  await p.evaluate(() => window.RPApp.homeWheel.selectKey('navRedProxy')); await p.waitForTimeout(700);
  await p.keyboard.press('Enter'); await p.waitForTimeout(1400);
  console.log('redproxy:', { count0, count1 }, await p.evaluate(() => ({ view: window.RPApp.view, active: document.querySelector('.section.active').id, addrEnabled: !document.getElementById('rp-address').disabled, rpOpen: document.body.classList.contains('rp-open') })));
  await p.screenshot({ path: 'shots/31-redproxy-panel.png' });
  await p.keyboard.press('Escape'); await p.waitForTimeout(1300);
  // settings panel: pick a theme by clicking
  await p.click('#sidePanelArrowBtn'); await p.waitForTimeout(400);
  await p.click('.sp-theme-option[data-theme-id="Portal"]'); await p.waitForTimeout(2500);
  console.log('theme click:', await p.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), layers: document.querySelectorAll('.px-set.is-in .px-layer').length, sets: document.querySelectorAll('.px-set').length, stored: localStorage.getItem('rp_theme') })));
  await p.click('#btnSfxToggle'); await p.waitForTimeout(200);
  console.log('sfx:', await p.evaluate(() => ({ enabled: window.RPSfx.enabled, stored: localStorage.getItem('rp_sfx'), label: document.querySelector('#btnSfxToggle span').textContent })));
  await p.screenshot({ path: 'shots/32-theme-portal.png' });
  // executor panel still works: run html -> popup
  await p.keyboard.press('Escape'); await p.waitForTimeout(500);
  await p.evaluate(() => window.RPApp.homeWheel.selectKey('executor')); await p.waitForTimeout(700);
  await p.keyboard.press('Enter'); await p.waitForTimeout(1300);
  await p.fill('#htmlInput', '<h1>hi</h1>');
  const [pop] = await Promise.all([c.waitForEvent('page', { timeout: 5000 }).catch(() => null), p.click('#btnRunHtml')]);
  console.log('executor popup:', pop ? pop.url().slice(0, 30) : 'NONE', 'status:', await p.textContent('#execTypedStatus'));
  console.log('errors', errs);
  await c.close();
}
await b.close();
