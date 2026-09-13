import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const REPO = path.resolve('redportal'); const THEMES_DIR = 'C:/Stuff/RedTesting/red-portal-DKR-LCL-main/assets/themes';
const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 1600, height: 900 } });
await c.route('https://redportal.dpdns.org/**', route => { const u = new URL(route.request().url());
  if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(REPO, 'index.html')) });
  if (u.pathname.startsWith('/assets/ui/')) return route.fulfill({ status: 200, contentType: u.pathname.endsWith('.css') ? 'text/css' : u.pathname.endsWith('.js') ? 'application/javascript' : 'application/json', body: fs.readFileSync(path.join(REPO, u.pathname)) });
  route.continue(); });
await c.route('https://assets.redportal.dpdns.org/assets/themes/*/**', route => { const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace('/assets/themes/', '')); const f = path.join(THEMES_DIR, rel); fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'image/png', body: fs.readFileSync(f) }) : route.continue(); });
const p = await c.newPage();
await p.goto('https://redportal.dpdns.org/', { waitUntil: 'load' }); await p.click('#intro-overlay').catch(()=>{}); await p.waitForTimeout(12000);
await p.evaluate(() => window.RPApp.homeWheel.selectKey('emulation')); await p.waitForTimeout(800); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
const r = await p.evaluate(async () => {
  const w = window.RPApp.listWheel; w.mode = 'free'; w.vel = 7;
  let frames = 0, long = 0, last = performance.now(), maxDt = 0;
  await new Promise(res => { const t0 = performance.now(); (function f(now) { frames++; const dt = now - last; last = now; if (dt > 34) long++; maxDt = Math.max(maxDt, dt); if (now - t0 < 2500) requestAnimationFrame(f); else res(); })(performance.now()); });
  w.vel = 7; // keep spinning for the mouse-steer sim too
  const visible = [...document.querySelectorAll('#listWheel .wh-item')].filter(n => !n.hidden).length;
  return { frames, fps: (frames / 2.5).toFixed(1), longFrames: long, maxDt: maxDt.toFixed(1), items: w.count, visible, nodes: document.querySelectorAll('*').length };
});
console.log(r);
await b.close();
