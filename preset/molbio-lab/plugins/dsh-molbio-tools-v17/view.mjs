/**
 * dsh-molbio-tools/view.mjs
 *
 * Zero-dependency "auto-view" opener: hands a generated image file (SVG) to
 * the operating system's default application so the user sees it immediately,
 * mirroring the DSH gateway's host.openPath semantics — Invoke-Item on
 * Windows, `open` on macOS, xdg-open (or $BROWSER for browser-renderable
 * documents) on desktop Linux, and WSL path translation to the Windows
 * desktop. Best-effort by design: failures are swallowed and the caller
 * reports whether the hand-off succeeded. `MOLBIO_AUTO_VIEW=0` disables
 * auto-view entirely (tests and batch runs use it).
 */

import { spawn } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { extname } from 'node:path';

/** Documents a browser renders, opened with the default browser when one can be named. */
const BROWSER_DOCUMENTS = new Set(['.html', '.htm', '.xhtml', '.svg']);

function present(value) {
  return value !== undefined && value !== '';
}

/** Distinguish WSL from desktop Linux using its process and kernel markers. */
function isWsl(internals) {
  const env = internals.env ?? process.env;
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true;
  return (internals.osRelease ?? osRelease()).toLowerCase().includes('microsoft');
}

/**
 * Whether handing a path to the native opener can plausibly reach a visible
 * desktop on this host (mirrors the gateway's canOpenNativePath: macOS and
 * Windows always carry a desktop opener; Linux needs WSL or a display
 * server). Headless/container Linux answers false so nothing spawns into
 * the void.
 */
export function canAutoView(internals = {}) {
  const env = internals.env ?? process.env;
  if (env.MOLBIO_AUTO_VIEW === '0') return false;
  const platform = internals.platform ?? process.platform;
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform !== 'linux') return false;
  return isWsl(internals) || present(env.DISPLAY) || present(env.WAYLAND_DISPLAY);
}

/** PowerShell single-quoted literal (doubles embedded quotes). */
function powershellLiteral(path) {
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Run one shell-free native command fire-and-forget (capturing stdout only
 * when `capture` is set, for the wslpath translation round trip). An
 * injectable `internals.run` seam keeps the function unit-testable. Resolves
 * undefined on success; a failed spawn resolves { stdout: '' } in capture mode
 * or undefined otherwise — the caller decides what to report.
 */
function runCommand(cmd, args, internals, capture = false) {
  const run = internals.run;
  if (run !== undefined) return run(cmd, args);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, {
      detached: true,
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'ignore',
      windowsHide: true,
    });
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('error', () => finish(capture ? { stdout: '' } : undefined));
    if (capture) {
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('close', () => finish({ stdout }));
    } else {
      child.on('spawn', () => finish(undefined));
    }
    child.unref();
  });
}

/** Open one Windows-resolvable path through its registered desktop application. */
async function openWindowsPath(path, internals) {
  await runCommand('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item -LiteralPath ${powershellLiteral(path)}`], internals);
}

/** Translate a WSL path before handing it to the Windows desktop. */
async function openWslPath(path, internals) {
  const { stdout } = await runCommand('wslpath', ['-w', path], internals, true);
  const windowsPath = stdout.replace(/[\r\n]+$/, '');
  if (windowsPath === '') throw new Error('wslpath returned no Windows path');
  await openWindowsPath(windowsPath, internals);
}

/**
 * Open a browser-renderable document with the default browser when this
 * platform can name one: desktop Linux honors $BROWSER. Windows names no
 * browser without registry digging (its .svg association is the browser in
 * the ordinary case) and macOS `open` already routes .svg sensibly, so both
 * return false and let the default-application hand-off take over.
 */
async function openInBrowser(path, internals) {
  const env = internals.env ?? process.env;
  if ((internals.platform ?? process.platform) !== 'linux') return false;
  const browser = env.BROWSER;
  if (!present(browser)) return false;
  await runCommand(browser, [path], internals);
  return true;
}

/**
 * Open a generated file with the operating system's default application —
 * the default browser for documents it renders, when one can be named.
 * Returns true when the hand-off succeeded; never throws.
 */
export async function openDefaultViewer(path, internals = {}) {
  try {
    if (!canAutoView(internals)) return false;
    const platform = internals.platform ?? process.platform;
    const env = internals.env ?? process.env;
    const wsl = platform === 'linux' && isWsl(internals);
    const ext = extname(path).toLowerCase();
    if (!wsl && BROWSER_DOCUMENTS.has(ext) && await openInBrowser(path, internals)) return true;
    if (platform === 'darwin') {
      await runCommand('open', [path], internals);
      return true;
    }
    if (platform === 'win32') {
      await openWindowsPath(path, internals);
      return true;
    }
    if (platform === 'linux') {
      if (wsl) await openWslPath(path, internals);
      else await runCommand('xdg-open', [path], internals);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
