/**
 * Minimal Chrome DevTools Protocol driver for the live-GUI check.
 *
 * Why a hand-written driver: the harness has no browser automation dependency,
 * and Node 26 ships a global WebSocket, so ~60 lines connect to a headless
 * browser, evaluate expressions in the page and capture screenshots. The
 * verification it exists for (does the panel/card actually render in a real
 * page?) cannot be answered by any Node-side test.
 *
 * Usage:
 *   node build/cdp.mjs navigate <url>
 *   node build/cdp.mjs evaluate <javascript-expression>
 *   node build/cdp.mjs screenshot <file.png>
 *   node build/cdp.mjs targets
 */
const [, , command, ...rest] = process.argv;
const CDP_BASE = process.env.CDP_BASE ?? 'http://127.0.0.1:9222';

/** One page target, connecting lazily and reusing the socket per call. */
async function pageSocket() {
  const response = await fetch(`${CDP_BASE}/json/list`);
  const targets = await response.json();
  const page = targets.find((target) => target.type === 'page');
  if (page === undefined) {
    throw new Error(`no page target; the browser must be started with --remote-debugging-port (saw ${targets.map((t) => t.type).join(', ')})`);
  }
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
    if (message.error !== undefined) waiter.reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send, page };
}

const { socket, send, page } = await pageSocket();
try {
  if (command === 'targets') {
    const response = await fetch(`${CDP_BASE}/json/list`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } else if (command === 'navigate') {
    await send('Page.enable');
    await send('Page.navigate', { url: rest[0] });
    // Wait for the load event, then settle the app's own boot.
    await new Promise((resolve) => setTimeout(resolve, 8000));
    console.log(`navigated: ${rest[0]}`);
    console.log(`title: ${JSON.stringify((await send('Runtime.evaluate', { expression: 'document.title' })).result.value)}`);
  } else if (command === 'evaluate') {
    const result = await send('Runtime.evaluate', {
      expression: rest.join(' '),
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      console.error(`evaluate threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      process.exit(1);
    }
    const value = result.result.value;
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
  } else if (command === 'screenshot') {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(rest[0], Buffer.from(shot.data, 'base64'));
    console.log(`screenshot written: ${rest[0]}`);
  } else {
    console.error('usage: node build/cdp.mjs <targets|navigate|evaluate|screenshot> [arg]');
    process.exit(2);
  }
} finally {
  socket.close();
}
