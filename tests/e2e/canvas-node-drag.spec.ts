import { expect, test, type Locator, type Page } from "@playwright/test";

const DEV_AUTH_EMAIL = process.env.AUTH_DEV_EMAIL || "demo@nodes.local";
const DEV_AUTH_PASSWORD = process.env.AUTH_DEV_PASSWORD || "dev-password";
const PLAYWRIGHT_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ??
  `http://localhost:${process.env.PLAYWRIGHT_PORT ?? "3100"}`;

async function fetchAppJson<T>(page: Page, input: string, init?: RequestInit) {
  const url = new URL(input, page.url()).toString();
  const { body, headers, ...rest } = init ?? {};
  const normalizedHeaders = headers
    ? Object.fromEntries(new Headers(headers).entries())
    : {};
  const response = await page.request.fetch(url, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...normalizedHeaders,
    },
    ...(body === undefined ? {} : { data: body }),
  });
  if (!response.ok()) {
    throw new Error(`Request failed for ${input}: ${response.status()}`);
  }
  return (await response.json()) as T;
}

async function resetAppData(page: Page) {
  for (const target of ["/api/projects", "/api/sessions", "/api/memory"]) {
    const response = await page.request.fetch(
      new URL(target, PLAYWRIGHT_BASE_URL).toString(),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ all: true }),
      },
    );
    expect([200, 204, 400, 404]).toContain(response.status());
  }

  await page.goto(PLAYWRIGHT_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function ensureSignedIn(page: Page) {
  await page.goto(PLAYWRIGHT_BASE_URL, { waitUntil: "domcontentloaded" });
  const composer = page.getByPlaceholder("Write a message...");
  if (await composer.isVisible().catch(() => false)) return;

  const newSessionButton = page.getByRole("button", { name: "New Session" });
  if (await newSessionButton.isVisible().catch(() => false)) return;

  const loginButton = page.getByRole("button", {
    name: "Sign in with local dev credentials",
  });
  await expect(loginButton).toBeVisible({ timeout: 15_000 });
  await page.locator("#dev-email").fill(DEV_AUTH_EMAIL);
  await page.locator("#dev-password").fill(DEV_AUTH_PASSWORD);
  await loginButton.click();
  await expect(composer).toBeVisible({ timeout: 15_000 });
}

async function createAndOpenSession(page: Page) {
  await ensureSignedIn(page);
  const created = await fetchAppJson<{ session: { id: string } }>(
    page,
    "/api/sessions",
    {
      method: "POST",
      body: JSON.stringify({ title: "Canvas drag verification" }),
    },
  );
  await page.goto(`/?sessionId=${created.session.id}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByPlaceholder("Write a message...")).toBeVisible({
    timeout: 15_000,
  });
  return created.session.id;
}

async function dismissWorkspaceGuide(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "Turn a question into a structured decision",
  });
  if (await dialog.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(dialog).toBeHidden();
  }
}

async function openCanvas(page: Page) {
  const splitButton = page.getByRole("button", {
    name: /^(Open|Exit) split workspace$/u,
  });
  await expect(splitButton).toBeVisible({ timeout: 15_000 });
  if ((await splitButton.getAttribute("aria-label")) === "Open split workspace") {
    await splitButton.click();
  }
  await expect(page.getByRole("region", { name: "Conversation canvas" })).toBeVisible({
    timeout: 15_000,
  });
}

async function readGraphPosition(node: Locator) {
  return node.evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
    return { x: matrix.m41, y: matrix.m42 };
  });
}

async function readGraphViewport(viewport: Locator) {
  return viewport.evaluate((element) => {
    const transform = getComputedStyle(element).transform;
    const matrix = new DOMMatrixReadOnly(transform === "none" ? undefined : transform);
    return { x: matrix.m41, y: matrix.m42, zoom: matrix.a };
  });
}

async function findEmptyPanePoint(pane: Locator) {
  return pane.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const blockedSelector = [
      ".react-flow__node",
      ".react-flow__edge",
      ".react-flow__panel",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
    ].join(",");

    for (let row = 1; row < 16; row += 1) {
      for (let column = 1; column < 16; column += 1) {
        const x = rect.left + (rect.width * column) / 16;
        const y = rect.top + (rect.height * row) / 16;
        const hit = document.elementFromPoint(x, y);
        if (hit && element.contains(hit) && !hit.closest(blockedSelector)) {
          return { x, y };
        }
      }
    }
    throw new Error("Could not find an uncovered Canvas pane point");
  });
}

async function useZoomControlUntil({
  control,
  viewport,
  target,
}: {
  control: Locator;
  viewport: Locator;
  target: (zoom: number) => boolean;
}) {
  let current = await readGraphViewport(viewport);
  for (let attempt = 0; attempt < 8 && !target(current.zoom); attempt += 1) {
    const previousZoom = current.zoom;
    let latestZoom = previousZoom;
    let stableSamples = 0;
    await control.click();
    await expect
      .poll(async () => {
        const next = await readGraphViewport(viewport);
        const moved = Math.abs(next.zoom - previousZoom) > 0.01;
        stableSamples =
          moved && Math.abs(next.zoom - latestZoom) < 0.001
            ? stableSamples + 1
            : 0;
        latestZoom = next.zoom;
        return stableSamples;
      }, { intervals: [50, 100, 100, 150], timeout: 3_000 })
      .toBeGreaterThanOrEqual(2);
    current = await readGraphViewport(viewport);
  }
  expect(target(current.zoom)).toBe(true);
  return current.zoom;
}

test.beforeEach(async ({ page }) => {
  await resetAppData(page);
});

test.skip("conversation nodes can be dragged and keep their position after reload", async ({
  page,
}) => {
  const sessionId = await createAndOpenSession(page);
  await dismissWorkspaceGuide(page);

  const composer = page.getByPlaceholder("Write a message...");
  await composer.fill("Reply briefly so the Canvas contains a real assistant node.");
  await composer.press("Enter");

  await openCanvas(page);

  const canvas = page.getByRole("region", { name: "Conversation canvas" });
  const conversationNodes = canvas.locator(".react-flow__node-threadNode");
  await expect
    .poll(async () => conversationNodes.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);

  const node = conversationNodes.last();
  await expect(node).toBeVisible({ timeout: 15_000 });

  const nodeId = await node.getAttribute("data-id");
  expect(nodeId).toBeTruthy();

  const before = await readGraphPosition(node);
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Conversation node has no bounding box");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 220, startY + 140, { steps: 20 });
  await page.mouse.up();

  await expect
    .poll(
      async () => {
        const position = await readGraphPosition(node);
        return (
          Math.abs(position.x - before.x) > 50 &&
          Math.abs(position.y - before.y) > 30
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  const moved = await readGraphPosition(node);
  const storageKey = `nodes.canvas-message-positions.v1:${sessionId}`;
  const storedPosition = await page.evaluate(
    ({ key, id }) => {
      const raw = window.localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, { x: number; y: number }>;
      return parsed[id] ?? null;
    },
    { key: storageKey, id: nodeId as string },
  );

  expect(storedPosition).not.toBeNull();
  expect(storedPosition?.x).toBeCloseTo(moved.x, 3);
  expect(storedPosition?.y).toBeCloseTo(moved.y, 3);

  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissWorkspaceGuide(page);
  await openCanvas(page);

  const reloadedNode = page
    .getByRole("region", { name: "Conversation canvas" })
    .locator(`.react-flow__node-threadNode[data-id="${nodeId}"]`);
  await expect(reloadedNode).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(
      async () => {
        const position = await readGraphPosition(reloadedNode);
        return (
          Math.abs(position.x - moved.x) < 0.01 &&
          Math.abs(position.y - moved.y) < 0.01
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);
});

test("keeps core Canvas interactions usable across selection, pan, zoom, and Chat focus", async ({
  page,
}) => {
  test.slow();
  await createAndOpenSession(page);
  await dismissWorkspaceGuide(page);

  const prompt = "Exercise the complete Canvas interaction path.";
  const composer = page.getByPlaceholder("Write a message...");
  await composer.fill(prompt);
  await composer.press("Enter");
  await openCanvas(page);

  const canvas = page.getByRole("region", { name: "Conversation canvas" });
  const graph = canvas.locator('[aria-label="Conversation graph"]');
  const pane = canvas.locator(".react-flow__pane");
  const viewport = canvas.locator(".react-flow__viewport");
  const minimap = canvas.locator(".react-flow__minimap");
  const zoomOut = canvas.getByRole("button", { name: "Zoom Out" });
  const zoomIn = canvas.getByRole("button", { name: "Zoom In" });
  const fitView = canvas.getByRole("button", { name: "Fit View" });
  const conversationNodes = canvas.locator(".react-flow__node-threadNode");

  await expect(graph).toBeVisible();
  await expect
    .poll(async () => conversationNodes.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  await expect(minimap).toBeVisible({ timeout: 10_000 });
  await expect(zoomOut).toBeEnabled();
  await expect(zoomIn).toBeEnabled();
  await expect(fitView).toBeEnabled();

  const lastConversationNode = conversationNodes.last();
  await expect(lastConversationNode).toBeVisible();
  const nodeId = await lastConversationNode.getAttribute("data-id");
  expect(nodeId).toBeTruthy();
  if (!nodeId) throw new Error("Conversation node is missing its data-id");
  const node = canvas.locator(`.react-flow__node-threadNode[data-id="${nodeId}"]`);

  const focusBadge = node.getByText("Focus", { exact: true });
  await node.click({ position: { x: 24, y: 24 } });
  await expect(focusBadge).toBeVisible();

  const panePoint = await findEmptyPanePoint(pane);
  await page.mouse.click(panePoint.x, panePoint.y);
  await expect(focusBadge).toBeHidden();

  const viewportBeforePan = await readGraphViewport(viewport);
  await page.mouse.move(panePoint.x, panePoint.y);
  await page.mouse.down();
  await page.mouse.move(panePoint.x + 140, panePoint.y + 80, { steps: 10 });
  await expect(canvas).toHaveAttribute("data-canvas-interacting", "true");
  await expect(minimap).toHaveCount(0);
  await page.mouse.up();

  await expect
    .poll(async () => {
      const current = await readGraphViewport(viewport);
      return Math.hypot(
        current.x - viewportBeforePan.x,
        current.y - viewportBeforePan.y,
      );
    })
    .toBeGreaterThan(40);
  await expect(canvas).toHaveAttribute("data-canvas-interacting", "false");
  await expect(minimap).toBeVisible();

  // Panning intentionally clears selection. Re-select the node and assert the
  // semantic React Flow selection state rather than a theme-dependent shadow.
  await node.click({ position: { x: 24, y: 24 } });
  await expect(focusBadge).toBeVisible();
  await expect(node).toHaveClass(/\bselected\b/u);

  const nodeDetailControl = node.getByRole("button", {
    name: "Delete message node",
  });
  await expect(nodeDetailControl).toBeVisible();
  await useZoomControlUntil({
    control: zoomOut,
    viewport,
    target: (zoom) => zoom < 0.65,
  });
  const lowZoomViewportStyle = await viewport.getAttribute("style");
  expect(lowZoomViewportStyle ?? "").toMatch(/scale\(0\.[3-6]/u);
  await expect(node).toHaveClass(/\bselected\b/u);
  await expect(nodeDetailControl).toBeVisible();

  await useZoomControlUntil({
    control: zoomIn,
    viewport,
    target: (zoom) => zoom > 0.75,
  });
  await expect(node).toHaveClass(/\bselected\b/u);
  await expect(nodeDetailControl).toBeVisible();

  const canvasModeButton = page.getByRole("button", { name: "Show canvas panel" });
  await canvasModeButton.click();
  await expect(canvasModeButton).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () =>
      composer.evaluate(
        (element) => element.closest('[aria-hidden="true"][inert]') !== null,
      ),
    )
    .toBe(true);
  await fitView.click();
  await expect(node).toBeVisible();
  await node.dblclick({ position: { x: 24, y: 24 } });

  await expect(page.getByRole("button", { name: "Exit split workspace" })).toBeVisible();
  await expect(composer).toBeVisible();
  await expect(page.locator(`[data-message-id="${nodeId}"]`)).toBeVisible();
});
