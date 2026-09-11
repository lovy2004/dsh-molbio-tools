/**
 * Drive the live GUI through Chrome DevTools Protocol: type a prompt into the
 * composer, send it, wait for the turn to settle, then report what the
 * transcript shows. Used by the live card verification — nothing else in this
 * repository can answer "does the card render in a real page?".
 *
 * Usage: node build/cdp-drive.mjs "<prompt>" [--timeout-ms N] [--screenshot file.png]
 */
import { writeFileSync } from 'node:fs';

const CDP_BASE = process.env.CDP_BASE ?? 'http://127.0.0.1:9222';
const args = process.argv.slice(2);
const prompt = args[0];
if (prompt === undefined) {
  console.error('usage: node build/cdp-drive.mjs "<prompt>" [--timeout-ms N] [--screenshot file.png]');
  process.exit(2);
}
const flagValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const timeoutMs = Number(flagValue('--timeout-ms', '240000'));
const screenshotPath = flagValue('--screenshot', undefined);

const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
const page = targets.find((target) => target.type === 'page');
if (page === undefined) throw new Error('no page target');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  const waiter = pending.get(message.id);
  if (waiter === undefined) return;
  pending.delete(message.id);
  if (message.error !== undefined) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

try {
  await send('Page.enable');
  // 1. Type into the composer the way a user does. The composer is a
  //    contenteditable div, so `textContent = ...` does NOT reach React: the
  //    value must arrive through the browser's editing pipeline, which
  //    `document.execCommand('insertText')` drives (and which fires the input
  //    event React listens for).
  const typed = await evaluate(`(() => {
    const box = [...document.querySelectorAll('*')].find((el) => el.isContentEditable);
    if (box === undefined) return 'no composer found';
    box.focus();
    const text = ${JSON.stringify(prompt)};
    const inserted = document.execCommand('insertText', false, text);
    return 'execCommand=' + inserted + ' textLen=' + box.textContent.length + ' cls=' + (box.className || '').toString().slice(0, 20);
  })()`);
  console.log(`composer: ${typed}`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  // 2. Send: the composer's own submit control, or Enter on the box.
  const sent = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const submit = buttons.find((b) => /send|发送/i.test(b.getAttribute('aria-label') ?? '') || /send|发送/i.test(b.title ?? ''));
    if (submit !== undefined) {
      const disabled = submit.disabled === true || submit.getAttribute('aria-disabled') === 'true';
      if (disabled) return 'submit disabled (the composer text did not register)';
      submit.click();
      return 'clicked ' + (submit.getAttribute('aria-label') ?? submit.title);
    }
    const box = [...document.querySelectorAll('*')].find((el) => el.isContentEditable);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'pressed Enter';
  })()`);
  console.log(`send: ${sent}`);
  if (String(sent).includes('disabled')) {
    console.error('the prompt never reached the composer; aborting rather than waiting for nothing');
    process.exit(1);
  }

  // 3. Poll the transcript until it stops growing (the turn settled).
  const deadline = Date.now() + timeoutMs;
  let lastLength = -1;
  let stable = 0;
  let text = '';
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    text = await evaluate('document.body.innerText');
    if (text.length === lastLength) stable++;
    else stable = 0;
    lastLength = text.length;
    const busy = await evaluate(`document.body.innerText.includes('停止') || document.body.innerText.includes('Stop')`);
    if (stable >= 3 && busy === false) break;
  }

  console.log('--- transcript (tail) ---');
  console.log(text.slice(-2500));
  const signals = await evaluate(`JSON.stringify({
    failedPlugins: document.body.innerText.includes('Failed to load plugins'),
    hasMapCard: document.body.innerText.includes('pCARD') || document.body.innerText.includes('bp · circular'),
    hasMolbioTool: document.body.innerText.includes('molbio_plasmid_map'),
    svgCount: document.querySelectorAll('svg').length,
    svgWithViewBox: [...document.querySelectorAll('svg')].filter((s) => s.getAttribute('viewBox') === '0 0 840 840').length,
  })`);
  console.log(`signals: ${signals}`);

  if (screenshotPath !== undefined) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    console.log(`screenshot: ${screenshotPath}`);
  }
} finally {
  socket.close();
}
