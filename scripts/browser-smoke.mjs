import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { spawn } from "node:child_process";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

async function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  throw new Error("Chrome was not found. Set CHROME_PATH to run the browser smoke test.");
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function removeTemporaryProfile(path) {
  if (!path.startsWith(normalizedTempRoot)) {
    throw new Error(`Refusing unexpected temporary profile path: ${path}`);
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      for (const listener of this.events.get(message.method) ?? []) listener(message.params);
    });
  }

  on(method, listener) {
    const listeners = this.events.get(method) ?? [];
    listeners.push(listener);
    this.events.set(method, listeners);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForValue(client, expression, timeoutMs = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
    }
    if (response.result.value) return response.result.value;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out evaluating: ${expression}`);
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? "Browser evaluation failed.");
  }
  return response.result.value;
}

const chromePath = await findChrome();
const appPort = await availablePort();
const appUrl = `http://127.0.0.1:${appPort}`;
const generatedData = JSON.parse(await readFile("data/generated/app-data.json", "utf8"));
const expectedQb1Ppg = Number(
  generatedData.historicalPpg[generatedData.defaultScoringFormat].QB[0].toFixed(1),
);
const expectedStandardQb1Ppg = Number(generatedData.historicalPpg.standard.QB[0].toFixed(1));
const profilePath = await mkdtemp(join(tmpdir(), "lineup-calculator-smoke-"));
const normalizedTempRoot = `${tmpdir()}${sep}`;
if (!profilePath.startsWith(normalizedTempRoot)) {
  throw new Error(`Refusing unexpected temporary profile path: ${profilePath}`);
}

const appServer = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: process.cwd(),
  env: { ...process.env, LINEUP_CALCULATOR_PORT: String(appPort) },
  stdio: ["ignore", "pipe", "pipe"],
});

let chrome;
let client;

try {
  await waitForHttp(appUrl);

  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    `${appUrl}/#rankings`,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const browserWebSocketUrl = await (async () => {
    const activePortFile = join(profilePath, "DevToolsActivePort");
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      try {
        const [port, browserPath] = (await readFile(activePortFile, "utf8")).trim().split(/\r?\n/);
        if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`;
      } catch {
        // Chrome may still be creating its profile.
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    throw new Error("Timed out waiting for Chrome debugging endpoint.");
  })();

  const endpoint = new URL(browserWebSocketUrl);
  const targetsResponse = await fetch(`http://${endpoint.host}/json/list`);
  const targets = await targetsResponse.json();
  const pageTarget = targets.find((target) => target.type === "page");
  if (!pageTarget) throw new Error("Chrome did not expose a page target.");

  client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.open();
  const exceptions = [];
  const requestedUrls = [];
  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    exceptions.push(exceptionDetails.exception?.description ?? exceptionDetails.text);
  });
  client.on("Network.requestWillBeSent", ({ request }) => {
    requestedUrls.push(request.url);
  });
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await client.send("Page.navigate", { url: `${appUrl}/#rankings` });
  await waitForValue(client, "document.readyState === 'complete' && Boolean(document.querySelector('#rankGrid .rank-column'))");

  const measure = () => evaluate(client, `(() => ({
    innerWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    activeTab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab,
    visiblePanel: document.querySelector('[role="tabpanel"]:not([hidden])')?.id
  }))()`);

  const rankingsMobile = await measure();
  if (rankingsMobile.innerWidth !== 375 || rankingsMobile.documentWidth > 375 || rankingsMobile.bodyWidth > 375) {
    throw new Error(`Rankings overflow at 375px: ${JSON.stringify(rankingsMobile)}`);
  }

  await evaluate(client, "document.querySelector('[data-action=\"pool-add\"][data-position=\"QB\"]').click()");
  await waitForValue(client, "document.querySelectorAll('[data-position=\"QB\"] .rank-item').length === 1");
  await evaluate(client, "location.hash = '#lineup'");
  await waitForValue(client, "document.querySelector('#panel-lineup').hidden === false");

  const lineupMobile = await measure();
  if (lineupMobile.documentWidth > 375 || lineupMobile.bodyWidth > 375) {
    throw new Error(`Lineup overflow at 375px: ${JSON.stringify(lineupMobile)}`);
  }

  await evaluate(client, `(() => {
    const select = document.querySelector('[data-action="slot-player"]');
    select.value = select.options[1].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const totalPpg = await waitForValue(client, "Number(document.querySelector('#totalPpg').textContent)");
  if (totalPpg !== expectedQb1Ppg) {
    throw new Error(`Expected interactive PPG total of ${expectedQb1Ppg}; received ${totalPpg}.`);
  }

  await evaluate(client, "location.hash = '#settings'");
  await waitForValue(client, "document.querySelector('#panel-settings').hidden === false");
  const settingsMobile = await measure();
  if (settingsMobile.documentWidth > 375 || settingsMobile.bodyWidth > 375) {
    throw new Error(`Settings overflow at 375px: ${JSON.stringify(settingsMobile)}`);
  }
  const hasSourceDisclosure = await evaluate(
    client,
    "document.querySelector('#datasetDetails').textContent.includes('nflverse')"
      + " && document.querySelector('#datasetDetails').textContent.includes('Sleeper')"
      + " && document.querySelectorAll('#datasetLinks a').length >= 4",
  );
  if (!hasSourceDisclosure) throw new Error("Dataset source disclosure is missing from Settings.");

  await evaluate(client, `(() => {
    const select = document.querySelector('#scoringFormatSelect');
    select.value = 'standard';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    location.hash = '#lineup';
    return true;
  })()`);
  await waitForValue(client, "document.querySelector('#panel-lineup').hidden === false");
  const standardTotal = Number(await evaluate(client, "document.querySelector('#totalPpg').textContent"));
  if (standardTotal !== expectedStandardQb1Ppg) {
    throw new Error(
      `Expected Standard-scoring PPG total of ${expectedStandardQb1Ppg}; received ${standardTotal}.`,
    );
  }

  if (exceptions.length) throw new Error(`Browser exceptions: ${exceptions.join(" | ")}`);
  const externalRequests = requestedUrls.filter((url) => (
    /^https?:/.test(url) && !url.startsWith(appUrl)
  ));
  if (externalRequests.length) {
    throw new Error(`Browser made unexpected external requests: ${externalRequests.join(", ")}`);
  }

  process.stdout.write(
    "Browser smoke test passed: 375px rankings/lineup/settings, PPR and Standard calculations, "
      + "source disclosure, local-only requests, and zero runtime exceptions.\n",
  );
} finally {
  try {
    await client?.send("Browser.close");
  } catch {
    // The browser may already be shutting down.
  }
  client?.close();
  chrome?.kill();
  appServer.kill();
  await removeTemporaryProfile(profilePath);
}
