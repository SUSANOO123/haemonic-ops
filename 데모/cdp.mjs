// 화면 시험용 작은 도구 — 헤드리스 크롬을 띄워 화면을 누르고 캡처한다 (Node 24 내장 WebSocket). 앱에서는 쓰지 않는다.
// 쓰는 법: python3 데모/build_demo.py 로 dist 를 만들고 `python3 -m http.server 8765` 로 띄운 뒤, 시험 스크립트에서 import { launch } from '.../데모/cdp.mjs'
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export async function launch({ width = 1024, height = 768, profile, mobile = false, port = 9333 } = {}) {
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${port}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json`); targets = await r.json(); break; } catch (e) { await new Promise((r) => setTimeout(r, 250)); } }
  if (!targets) throw new Error('chrome did not start');
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } else if (d.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = { send, sleep,
    async goto(url, wait = 2500) { await send('Page.navigate', { url }); await sleep(wait); },
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description); return r.result.value; },
    async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.from(r.data, 'base64')); return file; },
    async close() { try { ws.close(); } catch (e) {} proc.kill(); } };
  return api;
}
