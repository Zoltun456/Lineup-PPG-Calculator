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

async function pointerDrag(client, geometry, previewSelector) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: geometry.startX,
    y: geometry.startY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: geometry.startX + 8,
    y: geometry.startY + 8,
    button: "left",
    buttons: 1,
  });
  await waitForValue(
    client,
    `Boolean(document.querySelector(${JSON.stringify(previewSelector)}))`
      + " && document.body.classList.contains('is-pointer-dragging')",
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: geometry.endX,
    y: geometry.endY,
    button: "left",
    buttons: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: geometry.endX,
    y: geometry.endY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function touchDrag(client, geometry, previewSelector) {
  const touchPoint = (x, y) => ({
    x,
    y,
    id: 1,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [touchPoint(geometry.startX, geometry.startY)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touchPoint(geometry.startX + 8, geometry.startY + 8)],
  });
  await waitForValue(
    client,
    `Boolean(document.querySelector(${JSON.stringify(previewSelector)}))`
      + " && document.body.classList.contains('is-pointer-dragging')",
  );
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [touchPoint(geometry.endX, geometry.endY)],
  });
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
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
  await evaluate(client, "document.querySelector('[data-action=\"pool-add\"][data-position=\"QB\"]').click()");
  await waitForValue(client, "document.querySelectorAll('[data-position=\"QB\"] .rank-item').length === 2");
  await waitForValue(
    client,
    "document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity)"
      + ".every((animation) => animation.playState !== 'running')",
  );
  const rankDragGeometry = await evaluate(client, `(() => {
    const items = [...document.querySelectorAll('[data-position="QB"] .rank-item')];
    items[0].scrollIntoView({ block: 'center' });
    const handleRect = items[0].querySelector('.rank-drag-handle').getBoundingClientRect();
    const targetRect = items[1].getBoundingClientRect();
    return {
      startX: handleRect.left + handleRect.width / 2,
      startY: handleRect.top + handleRect.height / 2,
      endX: handleRect.left + handleRect.width / 2,
      endY: targetRect.bottom - 2,
      movedName: items[0].querySelector('.player-name').textContent,
      targetName: items[1].querySelector('.player-name').textContent
    };
  })()`);
  await pointerDrag(client, rankDragGeometry, ".drag-preview.rank-item");
  await waitForValue(
    client,
    `document.querySelector('[data-position="QB"] .rank-item .player-name')?.textContent === ${JSON.stringify(rankDragGeometry.targetName)}`,
  );
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const hoverPoint = await evaluate(client, `(() => {
    scrollTo(0, 0);
    const rect = document.querySelector('[data-position="QB"] .rank-item').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: hoverPoint.x,
    y: hoverPoint.y,
  });
  const listOverflow = await evaluate(client, `(() => (
    [...document.querySelectorAll('.rank-list, .pool-list')].map((list) => {
      const style = getComputedStyle(list);
      const horizontalScrollbarHeight = list.offsetHeight
        - list.clientHeight
        - parseFloat(style.borderTopWidth)
        - parseFloat(style.borderBottomWidth);
      return {
        overflowX: style.overflowX,
        horizontalScrollbarHeight,
        label: list.getAttribute('aria-label')
      };
    })
  ))()`);
  const scrollingList = listOverflow.find((list) => (
    list.overflowX !== "hidden" || list.horizontalScrollbarHeight > 2
  ));
  if (scrollingList) {
    throw new Error(`Hover created horizontal list scrolling: ${JSON.stringify(scrollingList)}`);
  }
  const statusPlacement = await evaluate(client, `(() => {
    const panel = document.querySelector('#panel-rankings');
    const heading = panel.querySelector('.card-heading');
    const title = heading.querySelector('h2');
    const toolbar = heading.querySelector('.toolbar');
    const status = document.querySelector('#status');
    const headingRect = heading.getBoundingClientRect();
    const titleRange = document.createRange();
    titleRange.selectNodeContents(title);
    const titleRect = titleRange.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    const visibleLayout = {
      headingHeight: headingRect.height,
      panelTop: panel.getBoundingClientRect().top,
      documentHeight: document.documentElement.scrollHeight
    };
    status.hidden = true;
    const hiddenLayout = {
      headingHeight: heading.getBoundingClientRect().height,
      panelTop: panel.getBoundingClientRect().top,
      documentHeight: document.documentElement.scrollHeight
    };
    status.hidden = false;
    return {
      parentIsHeading: status.parentElement === heading,
      position: getComputedStyle(status).position,
      rightOfTitle: statusRect.left >= titleRect.right + 8,
      beforeToolbar: statusRect.right <= toolbarRect.left - 8,
      verticallyContained: statusRect.top >= headingRect.top && statusRect.bottom <= headingRect.bottom,
      horizontalBounds: {
        titleRight: titleRect.right,
        statusLeft: statusRect.left,
        statusRight: statusRect.right,
        toolbarLeft: toolbarRect.left
      },
      layoutShift: {
        headingHeight: Math.abs(visibleLayout.headingHeight - hiddenLayout.headingHeight),
        panelTop: Math.abs(visibleLayout.panelTop - hiddenLayout.panelTop),
        documentHeight: Math.abs(visibleLayout.documentHeight - hiddenLayout.documentHeight)
      }
    };
  })()`);
  if (
    !statusPlacement.parentIsHeading
    || statusPlacement.position !== "absolute"
    || !statusPlacement.rightOfTitle
    || !statusPlacement.beforeToolbar
    || !statusPlacement.verticallyContained
    || Object.values(statusPlacement.layoutShift).some((difference) => difference > 0.5)
  ) {
    throw new Error(`Status toast placement failed: ${JSON.stringify(statusPlacement)}`);
  }
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 375,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(client, "location.hash = '#lineup'");
  await waitForValue(client, "document.querySelector('#panel-lineup').hidden === false");

  const lineupMobile = await measure();
  if (lineupMobile.documentWidth > 375 || lineupMobile.bodyWidth > 375) {
    throw new Error(`Lineup overflow at 375px: ${JSON.stringify(lineupMobile)}`);
  }

  const dragGeometry = await evaluate(client, `(() => {
    const rows = [...document.querySelectorAll('#lineupRows .lineup-row')];
    rows[1].scrollIntoView({ block: 'center' });
    const handleRect = rows[1].querySelector('.slot-drag-handle').getBoundingClientRect();
    const targetRect = rows[2].getBoundingClientRect();
    return {
      startX: handleRect.left + handleRect.width / 2,
      startY: handleRect.top + handleRect.height / 2,
      endX: handleRect.left + handleRect.width / 2,
      endY: targetRect.bottom - 4,
      movedSlotId: rows[1].dataset.slotId,
      targetSlotId: rows[2].dataset.slotId
    };
  })()`);
  await touchDrag(client, dragGeometry, ".drag-preview.lineup-row");
  await waitForValue(
    client,
    `document.querySelectorAll('#lineupRows .lineup-row')[2]?.dataset.slotId === ${JSON.stringify(dragGeometry.movedSlotId)}`,
  );
  const motionFeatures = await evaluate(client, `(() => {
    const buttonStyle = getComputedStyle(document.querySelector('#addSlotButton'));
    const row = document.querySelector('#lineupRows .lineup-row');
    const handleStyle = getComputedStyle(row.querySelector('.slot-drag-handle'));
    return {
      buttonTransitions: buttonStyle.transitionDuration !== '0s',
      rowHasStableMotionIdentity: row.style.viewTransitionName.startsWith('slot-'),
      touchDragEnabled: handleStyle.touchAction === 'none',
      dragPreviewCleanedUp: !document.body.classList.contains('is-pointer-dragging')
    };
  })()`);
  if (Object.values(motionFeatures).some((value) => !value)) {
    throw new Error(`Motion interaction checks failed: ${JSON.stringify(motionFeatures)}`);
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

  await evaluate(client, "document.getElementById('settingsButton').click()");
  await waitForValue(client, "document.getElementById('settingsDialog').open === true");
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
    document.getElementById('settingsCloseButton').click();
    return true;
  })()`);
  await waitForValue(client, "document.getElementById('settingsDialog').open === false");
  await evaluate(client, "location.hash = '#lineup'");
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
    "Browser smoke test passed: 375px rankings/lineup/settings, full-row mouse and touch drag, "
      + "motion feedback, non-shifting header toast, hover overflow regression, PPR and Standard calculations, "
      + "source disclosure, local-only requests, "
      + "and zero runtime exceptions.\n",
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
