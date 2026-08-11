import { expect, test } from "@playwright/test";

type Page = import("@playwright/test").Page;

const DEV_AUTH_EMAIL = process.env.AUTH_DEV_EMAIL || "demo@nodes.local";
const DEV_AUTH_PASSWORD = process.env.AUTH_DEV_PASSWORD || "dev-password";
const TEST_AUTH_USER_ID = process.env.E2E_AUTH_USER_ID || "e2e-user";
const ACTIVE_SESSION_KEY = `nodes.active-session-id.${TEST_AUTH_USER_ID}`;
const ACTIVE_PROJECT_KEY = `nodes.active-project-id.${TEST_AUTH_USER_ID}`;
const PLAYWRIGHT_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ??
  `http://localhost:${process.env.PLAYWRIGHT_PORT ?? "3100"}`;

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnNn1sAAAAASUVORK5CYII=",
  "base64",
);

type ReplyOptions = {
  history?: "last" | "full";
  provider?: string;
  model?: string;
  count?: number;
  contextCount?: number;
  contextTitles?: string[];
};

function normalizeSelectedModelValue(value: string) {
  const match = value.match(/^(openrouter|ollama):(.+)$/);
  if (!match) {
    return {
      model: value,
      provider: inferProviderFromModel(value),
    };
  }
  return {
    model: match[2],
    provider: match[1],
  };
}

function inferProviderFromModel(modelId: string) {
  if (modelId.includes("/")) return "openrouter";
  return "ollama";
}

function expectedReply(
  prompt: string,
  {
    history = "last",
    provider = "openrouter",
    model = "openrouter/free",
    count = 1,
    contextCount = 0,
    contextTitles = [],
  }: ReplyOptions = {},
) {
  const contextSuffix =
    contextCount > 0 ? ` context=${contextCount} contextTitles=${contextTitles.join("|")}` : "";
  return `E2E reply: ${prompt} [provider=${provider} model=${model} history=${history} count=${count}${contextSuffix}]`;
}

function threadMessage(page: Page, text: string) {
  return page.locator("[data-message-id]").filter({ hasText: text }).first();
}

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
  if (!response.ok) {
    throw new Error(`Request failed for ${input}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function resetAppData(page: Page) {
  const cleanupTargets = ["/api/projects", "/api/sessions", "/api/memory"];

  for (const target of cleanupTargets) {
    const url = new URL(target, PLAYWRIGHT_BASE_URL).toString();
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await page.request.fetch(url, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          data: JSON.stringify({ all: true }),
        });

        if (!response.ok() && response.status() !== 400 && response.status() !== 404) {
          throw new Error(`Cleanup failed for ${target}: ${response.status()}`);
        }

        break;
      } catch (error) {
        if (attempt === maxAttempts) {
          throw error;
        }
        await page.waitForTimeout(250 * attempt);
      }
    }
  }

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
}

async function getActiveSessionId(page: Page) {
  const currentUrl = page.url();
  if (currentUrl.startsWith("http")) {
    const sessionId = new URL(currentUrl).searchParams.get("sessionId");
    if (sessionId) {
      return sessionId;
    }
  }
  return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), ACTIVE_SESSION_KEY);
}

async function getActiveProjectId(page: Page) {
  return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), ACTIVE_PROJECT_KEY);
}

async function ensureSignedIn(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const composer = page.getByPlaceholder("Write a message...");
  if (await composer.isVisible().catch(() => false)) {
    return;
  }

  const newSessionButton = page.getByRole("button", { name: "New Session" });
  if (await newSessionButton.isVisible().catch(() => false)) {
    const created = await fetchAppJson<{ session: { id: string } }>(page, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    await page.goto(`/?sessionId=${created.session.id}`, { waitUntil: "domcontentloaded" });
    await expect(composer).toBeVisible({ timeout: 15_000 });
    return;
  }

  const loginButton = page.getByRole("button", { name: "Sign in with local dev credentials" });
  await expect(loginButton).toBeVisible({ timeout: 15_000 });
  const emailInput = page.locator("#dev-email");
  const passwordInput = page.locator("#dev-password");
  await emailInput.fill(DEV_AUTH_EMAIL);
  await passwordInput.fill(DEV_AUTH_PASSWORD);
  await expect(emailInput).toHaveValue(DEV_AUTH_EMAIL);
  await expect(passwordInput).toHaveValue(DEV_AUTH_PASSWORD);
  await loginButton.click();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await dismissWorkspaceGuide(page);
}

test.beforeEach(async ({ page }) => {
  await resetAppData(page);
});

async function gotoChat(page: Page, options?: { title?: string }) {
  await ensureSignedIn(page);
  const created = await fetchAppJson<{ session: { id: string } }>(page, "/api/sessions", {
    method: "POST",
    body: JSON.stringify(options?.title ? { title: options.title } : {}),
  });
  await page.goto(`/?sessionId=${created.session.id}`, { waitUntil: "domcontentloaded" });
  const composer = page.getByPlaceholder("Write a message...");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await dismissWorkspaceGuide(page);
}

async function createAndOpenSession(page: Page) {
  const created = await fetchAppJson<{ session: { id: string } }>(page, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({}),
  });
  await page.goto(`/?sessionId=${created.session.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder("Write a message...")).toBeVisible({ timeout: 15_000 });
  await dismissWorkspaceGuide(page);
  return created.session.id;
}

async function createAndOpenNamedSession(page: Page, title: string) {
  const created = await fetchAppJson<{ session: { id: string } }>(page, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  await page.goto(`/?sessionId=${created.session.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder("Write a message...")).toBeVisible({ timeout: 15_000 });
  await dismissWorkspaceGuide(page);
  return created.session.id;
}

async function dismissWorkspaceGuide(page: Page) {
  const guide = page.getByRole("dialog", {
    name: "Turn a question into a structured decision",
  });
  if (!(await guide.isVisible().catch(() => false))) return;

  await guide.getByRole("button", { name: "Close workspace guide" }).click();
  await expect(guide).toBeHidden();
}

async function sendPrompt(
  page: Page,
  prompt: string,
  options?: ReplyOptions,
) {
  await dismissWorkspaceGuide(page);
  const composer = page.getByPlaceholder("Write a message...");
  const rawSelectedModel =
    options?.model ??
    (await page.getByRole("combobox", { name: "Model" }).evaluate((element) => {
      if (element instanceof HTMLSelectElement) {
        return element.value;
      }
      return element.getAttribute("value") ?? "";
    }));
  const normalizedSelection = rawSelectedModel
    ? normalizeSelectedModelValue(rawSelectedModel)
    : null;
  const resolvedOptions: ReplyOptions = {
    ...options,
    model: normalizedSelection?.model || options?.model,
    provider:
      options?.provider ??
      (normalizedSelection?.provider ?? options?.provider ?? "openrouter"),
  };
  await composer.fill(prompt);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send" }).click();
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`Chat request failed with ${response.status()}: ${await response.text()}`);
  }

  await expect(threadMessage(page, prompt)).toBeVisible();
  if (options?.count !== undefined) {
    const reply = expectedReply(prompt, resolvedOptions);
    await expect(threadMessage(page, reply)).toBeVisible({ timeout: 15_000 });
    return reply;
  }

  const replyPrefix = `E2E reply: ${prompt} [`;
  const replyMessage = page.locator("[data-message-id]").filter({ hasText: replyPrefix }).first();
  await expect(replyMessage).toBeVisible({ timeout: 15_000 });
  const renderedReply = (await replyMessage.innerText())
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(replyPrefix));
  if (!renderedReply) throw new Error(`Assistant reply line not found for ${prompt}`);
  return renderedReply;
}


async function copyGraphJson(page: Page) {
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });

  await page.evaluate(() => {
    const clipboardState = window as unknown as {
      __nodesCopiedGraphJson?: string;
    };
    clipboardState.__nodesCopiedGraphJson = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          clipboardState.__nodesCopiedGraphJson = text;
        },
        readText: async () => clipboardState.__nodesCopiedGraphJson ?? "",
      },
    });
  });

  const blockLibrary = page.getByRole("complementary", { name: "Block library" });
  const collapseBlockLibrary = blockLibrary.getByRole("button", {
    name: "Collapse block library",
  });
  if (await collapseBlockLibrary.isVisible().catch(() => false)) {
    await collapseBlockLibrary.click();
    await expect(
      blockLibrary.getByRole("button", { name: "Expand block library" }),
    ).toBeVisible();
  }

  await page.getByRole("button", { name: "Fit View" }).click();
  const copyJsonButton = page.getByRole("button", { name: "Copy JSON" });
  await expect(copyJsonButton).toBeVisible();
  await copyJsonButton.evaluate((button: HTMLButtonElement) => button.click());
  const readCopiedGraphJson = () =>
    page.evaluate(
      () =>
        (window as unknown as { __nodesCopiedGraphJson?: string })
          .__nodesCopiedGraphJson ?? "",
    );
  await expect.poll(readCopiedGraphJson, { timeout: 5_000 }).toMatch(/^\s*\{/);
  const clipboardText = await readCopiedGraphJson();
  return JSON.parse(clipboardText) as {
    artifacts?: Array<{ id: string; title: string; type: string }>;
    contextLinks?: Array<{ artifactId: string; targetMessageId: string }>;
    nodes: Array<{ id: string; role: string; parentId: string | null; isBridge?: boolean }>;
    connectors: Array<{ parentId: string | null; childId: string; description?: string }>;
  };
}

async function listSessionIds(page: Page) {
  const data = await fetchAppJson<{
    sessions: Array<{ id: string }>;
  }>(page, "/api/sessions");
  return data.sessions.map((session) => session.id);
}

async function fetchSessionDocument(page: Page, sessionId: string) {
  return fetchAppJson<{
    session: {
      snapshot: {
        headId: string | null;
        messages: Array<{
          parentId: string | null;
          message: {
            id: string;
            role: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        }>;
      };
    };
  }>(page, `/api/sessions/${sessionId}`);
}

async function fetchPersistedSession(page: Page, sessionId: string) {
  return fetchAppJson<{
    session: {
      artifacts: Array<{ id: string; title: string; artifactType?: string }>;
      contextLinks: Array<{ artifactId: string; targetMessageId: string }>;
      snapshot: {
        messages: Array<{
          parentId: string | null;
          message: Record<string, unknown>;
        }>;
      };
    };
  }>(page, `/api/sessions/${sessionId}`);
}

async function listProjectIds(page: Page) {
  const data = await fetchAppJson<{
    projects: Array<{ id: string }>;
  }>(page, "/api/projects");
  return data.projects.map((project) => project.id);
}

async function createProjectFromSessions(
  page: Page,
  sessionIds: string[],
  title: string,
) {
  const created = await fetchAppJson<{ project: { id: string } }>(page, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ sessionIds, title }),
  });
  return created.project.id;
}

async function openProjectById(page: Page, projectId: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ storageKey, nextProjectId }) => {
      window.localStorage.setItem(storageKey, nextProjectId);
    },
    { storageKey: ACTIVE_PROJECT_KEY, nextProjectId: projectId },
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible({
    timeout: 15_000,
  });
}

async function editAssistantReply(
  page: Page,
  currentReply: string,
  editedPrompt: string,
) {
  const assistantMessage = threadMessage(page, currentReply);

  await assistantMessage.hover();
  await assistantMessage.getByRole("button", { name: "Branch" }).click();
  await assistantMessage.getByRole("button", { name: "Revise assistant reply" }).click();

  const editComposer = page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Cancel" }) })
    .filter({ has: page.getByRole("textbox") })
    .last();
  const editComposerInput = editComposer.getByRole("textbox").first();
  await expect(editComposerInput).toBeVisible();
  await editComposerInput.fill(editedPrompt);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  await editComposer.getByRole("button", { name: "Create branch", exact: true }).click();
  await responsePromise;

  await expect(threadMessage(page, editedPrompt)).toBeVisible();
}

async function editUserPrompt(
  page: Page,
  currentPrompt: string,
  editedPrompt: string,
  options?: ReplyOptions,
) {
  const userMessage = threadMessage(page, currentPrompt);

  await userMessage.hover();
  await userMessage.getByRole("button", { name: "Branch" }).click();

  const editComposer = page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Cancel" }) })
    .filter({ has: page.getByRole("textbox") })
    .last();
  const editComposerInput = editComposer.getByRole("textbox").first();
  await expect(editComposerInput).toBeVisible();
  await editComposerInput.fill(editedPrompt);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  await editComposer.getByRole("button", { name: "Create branch", exact: true }).click();
  await responsePromise;

  const editedReply = expectedReply(editedPrompt, options);
  await expect(threadMessage(page, editedPrompt)).toBeVisible();
  await expect(threadMessage(page, editedReply)).toBeVisible({
    timeout: 15_000,
  });
}

async function createBranchFromFlow(
  page: Page,
  {
    nodeId,
    actionName,
    submitActionName,
    prompt,
    options,
    submitAttempts = 1,
  }: {
    nodeId: string;
    actionName: string;
    submitActionName?: string;
    prompt: string;
    options?: ReplyOptions;
    submitAttempts?: number;
  },
) {
  const blockLibrary = page.getByRole("complementary", { name: "Block library" });
  const collapseBlockLibrary = blockLibrary.getByRole("button", {
    name: "Collapse block library",
  });
  if (await collapseBlockLibrary.isVisible().catch(() => false)) {
    await collapseBlockLibrary.click();
    await expect(
      blockLibrary.getByRole("button", { name: "Expand block library" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Fit View" }).click();

  const targetNode = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(targetNode).toBeVisible({ timeout: 15_000 });
  const resolvedActionName =
    actionName === "Add follow-up question" ? "Create follow-up message" : actionName;
  const actionButton = targetNode.getByRole("button", {
    name: resolvedActionName,
  });
  await expect(actionButton).toBeVisible();
  await actionButton.click({ force: true });
  const draftNode = page.locator('.react-flow__node[data-id="__CANVAS_PROMPT_DRAFT__"]');
  await expect(draftNode).toBeVisible({ timeout: 15_000 });
  const branchTextarea = draftNode.getByRole("textbox", { name: "Draft prompt" });
  await expect(branchTextarea).toBeVisible();
  await branchTextarea.fill(prompt);

  const contextSelect = draftNode.getByRole("combobox", { name: "Context required" });
  await contextSelect.selectOption(nodeId === "__ROOT__" ? "branch" : "parent");
  const sendButton = draftNode.getByRole("button", { name: "Send prompt node" });
  await expect(sendButton).toBeEnabled();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/canvas-branch-runs") &&
      response.request().method() === "POST",
  );
  void submitActionName;
  void options;
  if (submitAttempts === 1) {
    await sendButton.click();
  } else {
    await sendButton.evaluate((button: HTMLButtonElement, attempts) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        button.click();
      }
    }, submitAttempts);
  }
  const response = await responsePromise;
  expect(response.ok()).toBe(true);

  const reply = `Mock Canvas branch response: ${prompt}`;
  await expect(threadMessage(page, prompt)).toBeVisible();
  await expect(threadMessage(page, reply)).toBeVisible({ timeout: 15_000 });
  return reply;
}

test("preserves chat thread and canvas nodes when switching workspace modes", async ({ page }) => {
  await gotoChat(page);
  const prompt = "Mode switch seed";
  const reply = await sendPrompt(page, prompt);

  await page.getByRole("button", { name: "Show chat panel" }).click();
  await expect(threadMessage(page, prompt)).toBeVisible();

  await page.getByRole("button", { name: "Show canvas panel" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="__ROOT__"]')).toHaveCount(1);
  const graph = await copyGraphJson(page);
  expect(graph.nodes.map((node) => node.role)).toEqual(["user", "assistant"]);

  await page.getByRole("button", { name: "Show chat panel" }).click();
  await expect(threadMessage(page, prompt)).toBeVisible();
  await expect(threadMessage(page, reply)).toBeVisible();
});

test("preserves a session thread when switching to a project and back", async ({ page }) => {
  await gotoChat(page, { title: "Source Session" });
  const sessionId = await getActiveSessionId(page);
  expect(sessionId).toBeTruthy();
  if (!sessionId) return;

  const prompt = "Project switch persistence seed";
  const reply = await sendPrompt(page, prompt);

  await expect
    .poll(async () => {
      const persistedBeforeProject = await fetchPersistedSession(page, sessionId);
      return persistedBeforeProject.session.snapshot.messages.filter((entry) => {
        const role = (entry.message as { role?: unknown }).role;
        return role === "user" || role === "assistant";
      }).length;
    })
    .toBe(2);

  await page.getByRole("button", { name: "Select sessions" }).click();
  await page.getByRole("checkbox", { name: "Select session Source Session" }).check();
  await page.getByRole("button", { name: "From selected (1)" }).click();
  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible({
    timeout: 15_000,
  });

  const persistedBeforeReturn = await fetchPersistedSession(page, sessionId);
  expect(
    persistedBeforeReturn.session.snapshot.messages.filter((entry) => {
      const role = (entry.message as { role?: unknown }).role;
      return role === "user" || role === "assistant";
    }).length,
  ).toBe(2);

  await page.getByRole("button", { name: "Back to sessions" }).click();
  await expect(threadMessage(page, prompt)).toBeVisible({ timeout: 15_000 });
  await expect(threadMessage(page, reply)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Show canvas panel" }).click();
  const graph = await copyGraphJson(page);
  expect(graph.nodes.map((node) => node.role)).toEqual(["user", "assistant"]);

  const persistedSession = await fetchPersistedSession(page, sessionId);
  expect(
    persistedSession.session.snapshot.messages.filter((entry) => {
      const role = (entry.message as { role?: unknown }).role;
      return role === "user" || role === "assistant";
    }).length,
  ).toBe(2);

  expect(await getActiveProjectId(page)).toBeNull();
  expect(await getActiveSessionId(page)).toBe(sessionId);
});

async function createBranchFromChat(
  page: Page,
  {
    messageText,
    actionName,
    panelActionName,
    submitActionName,
    prompt,
    options,
  }: {
    messageText: string;
    actionName: string;
    panelActionName?: string;
    submitActionName?: string;
    prompt: string;
    options?: ReplyOptions;
  },
) {
  const message = threadMessage(page, messageText);

  await message.hover();
  await message.getByRole("button", { name: actionName }).click();
  if (panelActionName) {
    await message.getByRole("button", { name: panelActionName }).click();
  }

  const branchComposer = page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: "Cancel" }) })
    .filter({ has: page.getByRole("textbox") })
    .last();
  const branchTextarea = branchComposer.getByRole("textbox").last();
  await expect(branchTextarea).toBeVisible();
  await branchTextarea.fill(prompt);

  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  await branchComposer
    .getByRole("button", {
      name:
        submitActionName ??
        (panelActionName?.toLowerCase().includes("follow-up") ? "Add follow-up" : "Create branch"),
      exact: true,
    })
    .evaluate((button: HTMLButtonElement) => button.click());
  await responsePromise;

  const reply = expectedReply(prompt, options);
  await expect(threadMessage(page, prompt)).toBeVisible();
  await expect(threadMessage(page, reply)).toBeVisible({ timeout: 15_000 });
  return reply;
}

type FlowNodeBox = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

async function getFlowNodeBoxes(page: Page) {
  const mainFlowNodes = page.locator(".react-flow__viewport .react-flow__node");
  await expect(mainFlowNodes.first()).toBeVisible();
  return mainFlowNodes.evaluateAll<FlowNodeBox[]>((elements) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const id = element.getAttribute("data-id");
        if (!id || rect.width === 0 || rect.height === 0) return null;
        return {
          id,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter((value): value is FlowNodeBox => value !== null),
  );
}

function getOverlappingNodePairs(boxes: FlowNodeBox[], inset = 12) {
  const pairs: string[] = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const left = boxes[index];
    if (!left) continue;
    const leftBox = {
      x1: left.x + inset,
      y1: left.y + inset,
      x2: left.x + left.width - inset,
      y2: left.y + left.height - inset,
    };

    for (let compareIndex = index + 1; compareIndex < boxes.length; compareIndex += 1) {
      const right = boxes[compareIndex];
      if (!right) continue;
      const rightBox = {
        x1: right.x + inset,
        y1: right.y + inset,
        x2: right.x + right.width - inset,
        y2: right.y + right.height - inset,
      };

      const intersects =
        leftBox.x1 < rightBox.x2 &&
        leftBox.x2 > rightBox.x1 &&
        leftBox.y1 < rightBox.y2 &&
        leftBox.y2 > rightBox.y1;

      if (intersects) {
        pairs.push(`${left.id}<->${right.id}`);
      }
    }
  }

  return pairs;
}

test("loads the workspace without getting stuck on session bootstrap", async ({ page }) => {
  await ensureSignedIn(page);
  await expect(page.getByPlaceholder("Write a message...")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Loading sessions...")).toHaveCount(0);
});

test("sends a prompt and renders the mocked assistant reply", async ({ page }) => {
  await gotoChat(page);
  const reply = await sendPrompt(page, "Browser smoke prompt");
  await expect(threadMessage(page, reply)).toBeVisible();
});

test("copies graph JSON after a reply", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Graph smoke prompt");
  const graph = await copyGraphJson(page);

  await expect(graph.nodes).toHaveLength(2);
  await expect(graph.nodes.map((node) => node.role)).toEqual(["user", "assistant"]);
  await expect(graph.connectors).toHaveLength(1);
  await expect(graph.connectors[0]).toMatchObject({
    parentId: graph.nodes[0]?.id ?? null,
    childId: graph.nodes[1]?.id ?? "",
  });
});

test("respects the selected local model in the request metadata", async ({ page }) => {
  await gotoChat(page);

  await fetchAppJson(page, "/api/llm/settings", {
    method: "PUT",
    body: JSON.stringify({
      settings: {
        providers: {
          ollama: {
            enabled: true,
            models: ["gemma3:4b"],
          },
        },
      },
    }),
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
    "Ollama",
  );

  await page.getByRole("combobox", { name: "Model" }).selectOption("ollama:gemma3:4b");
  const reply = await sendPrompt(page, "Model selection prompt", {
    provider: "ollama",
    model: "gemma3:4b",
  });

  const assistantMessage = threadMessage(page, reply);
  await expect(assistantMessage).toContainText("Model: ollama · gemma3:4b");
});

test.skip("sends full history when Full mode is selected", async ({ page }) => {
  await gotoChat(page);

  await sendPrompt(page, "First history prompt");
  await sendPrompt(page, "Second history prompt", {
    history: "full",
    count: 3,
  });
});

test("runs the first prompt directly from an empty flow canvas", async ({ page }) => {
  await gotoChat(page);
  await page.getByRole("button", { name: "Show canvas panel" }).click();
  const createPromptButton = page.getByRole("button", { name: "Add Prompt block" });
  await expect(createPromptButton).toBeVisible({ timeout: 15_000 });

  await createPromptButton.click();
  const blockLibrary = page.getByRole("complementary", { name: "Block library" });
  const collapseBlockLibrary = blockLibrary.getByRole("button", {
    name: "Collapse block library",
  });
  if (await collapseBlockLibrary.isVisible().catch(() => false)) {
    await collapseBlockLibrary.click();
    await expect(
      blockLibrary.getByRole("button", { name: "Expand block library" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "Fit View" }).click();

  const promptNode = page
    .locator(".react-flow__node")
    .filter({ has: page.getByRole("textbox", { name: "Canvas prompt" }) })
    .last();
  await expect(promptNode).toBeVisible({ timeout: 15_000 });
  await promptNode.getByRole("textbox", { name: "Canvas prompt" }).fill("Canvas first prompt");

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/canvas-runs") &&
      response.request().method() === "POST",
  );
  await promptNode.getByRole("button", { name: "Run canvas prompt" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  await expect(
    page.locator(".react-flow__node").filter({
      hasText: "Mock canvas response: Canvas first prompt",
    }).last(),
  ).toBeVisible({ timeout: 15_000 });

  const activeSessionId = await getActiveSessionId(page);
  expect(activeSessionId).toBeTruthy();
  const persisted = await fetchAppJson<{
    session: {
      artifacts: Array<{
        artifactType: string;
        content: string;
        promptResult?: string | null;
        promptStatus?: string | null;
      }>;
    };
  }>(page, `/api/sessions/${activeSessionId}`);
  const promptArtifact = persisted.session.artifacts.find(
    (artifact) => artifact.artifactType === "prompt" && artifact.content === "Canvas first prompt",
  );
  expect(promptArtifact).toMatchObject({
    promptResult: "Mock canvas response: Canvas first prompt",
    promptStatus: "completed",
  });
});

test("creates an assistant branch when reloading a reply", async ({ page }) => {
  await gotoChat(page);

  const prompt = "Reload branch prompt";
  const reply = await sendPrompt(page, prompt);
  const assistantMessage = threadMessage(page, reply);

  await assistantMessage.hover();
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  await assistantMessage.getByRole("button", { name: "Refresh" }).click();
  await responsePromise;

  const graph = await copyGraphJson(page);
  const assistantNodes = graph.nodes.filter((node) => node.role === "assistant");
  const siblingConnectors = graph.connectors.filter((connector) => connector.description === "siblings");

  await expect(assistantNodes).toHaveLength(2);
  await expect(siblingConnectors).toHaveLength(1);
});

test("persists edit branching across reloads", async ({ page }) => {
  await gotoChat(page);

  const originalPrompt = "Original branch prompt";
  const editedPrompt = "Edited branch prompt";
  const initialReply = await sendPrompt(page, originalPrompt);
  await editAssistantReply(page, initialReply, editedPrompt);

  const graphBeforeReload = await copyGraphJson(page);
  const assistantNodesBeforeReload = graphBeforeReload.nodes.filter((node) => node.role === "assistant");
  const connectorKeysBeforeReload = graphBeforeReload.connectors
    .map(
      (connector) =>
        `${connector.description ?? "parent-child"}:${connector.parentId ?? "null"}:${connector.childId}`,
    )
    .sort();
  const nodeIdsBeforeReload = graphBeforeReload.nodes.map((node) => node.id).sort();
  const editedAssistantNodeBeforeReload = graphBeforeReload.nodes.find(
    (node) => node.role === "assistant" && node.parentId === graphBeforeReload.nodes[0]?.id,
  );

  await expect(graphBeforeReload.nodes.length).toBeGreaterThan(2);
  await expect(assistantNodesBeforeReload.length).toBeGreaterThan(1);
  await expect(editedAssistantNodeBeforeReload).toBeDefined();

  const activeSessionId = await getActiveSessionId(page);
  expect(activeSessionId).toBeTruthy();
  if (!activeSessionId) return;

  await expect
    .poll(async () => {
      const persistedSession = await fetchSessionDocument(page, activeSessionId);
      return persistedSession.session.snapshot.messages.filter(
        (entry) => entry.message.role === "assistant",
      ).length;
    })
    .toBe(assistantNodesBeforeReload.length);

  const persistedSession = await fetchSessionDocument(page, activeSessionId);
  const persistedMessages = persistedSession.session.snapshot.messages;
  const persistedMessageIds = persistedMessages.map((entry) => entry.message.id).sort();
  const graphMessageIds = graphBeforeReload.nodes
    .filter((node) => node.id !== "__ROOT__")
    .map((node) => node.id)
    .sort();
  const editedUserMessage = persistedMessages.find(
    (entry) =>
      entry.message.role === "user" &&
      entry.message.content?.some(
        (part) => part.type === "text" && part.text === editedPrompt,
      ),
  );

  expect(persistedSession.session.snapshot.headId).toBeTruthy();
  expect(persistedMessageIds).toEqual(graphMessageIds);
  expect(editedUserMessage).toBeDefined();
});

test("creates a new root branch from the flow canvas", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Flow root base prompt");

  await createBranchFromFlow(page, {
    nodeId: "__ROOT__",
    actionName: "Create root branch",
    prompt: "Flow-created root branch",
  });

  const graph = await copyGraphJson(page);
  const rootUserNodes = graph.nodes.filter((node) => node.role === "user" && node.parentId === null);
  expect(rootUserNodes).toHaveLength(2);
});

test("creates a new root branch from the chat thread", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Chat root base prompt");

  await createBranchFromChat(page, {
    messageText: "Chat root base prompt",
    actionName: "Branch",
    prompt: "Chat-created root branch",
  });

  const graph = await copyGraphJson(page);
  const rootUserNodes = graph.nodes.filter((node) => node.role === "user" && node.parentId === null);
  expect(rootUserNodes).toHaveLength(2);
});

test("creates a sibling user branch from a flow user node", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Flow user sibling root");
  await sendPrompt(page, "Flow user sibling original");

  const graphBeforeBranch = await copyGraphJson(page);
  const laterUserNodeId = graphBeforeBranch.nodes.find(
    (node) => node.role === "user" && node.parentId !== null,
  )?.id;

  expect(laterUserNodeId).toBeTruthy();
  if (!laterUserNodeId) return;

  const originalNode = graphBeforeBranch.nodes.find((node) => node.id === laterUserNodeId);
  expect(originalNode).toBeDefined();
  if (!originalNode) return;
  const nodeIdsBeforeBranch = new Set(graphBeforeBranch.nodes.map((node) => node.id));
  const branchRunRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/api/canvas-branch-runs")
    ) {
      branchRunRequests.push(request.url());
    }
  });

  await createBranchFromFlow(page, {
    nodeId: laterUserNodeId,
    actionName: "Create sibling branch",
    prompt: "Flow user sibling alternative",
    submitAttempts: 3,
  });

  await expect(
    page.locator('.react-flow__node[data-id="__CANVAS_PROMPT_DRAFT__"]'),
  ).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(750);

  const graphAfterBranch = await copyGraphJson(page);
  const newConversationNodes = graphAfterBranch.nodes.filter(
    (node) => !nodeIdsBeforeBranch.has(node.id) && !node.isBridge,
  );
  const newUserNodes = newConversationNodes.filter((node) => node.role === "user");
  const newAssistantNodes = newConversationNodes.filter((node) => node.role === "assistant");

  expect(branchRunRequests).toHaveLength(1);
  expect(newConversationNodes).toHaveLength(2);
  expect(newUserNodes).toHaveLength(1);
  expect(newAssistantNodes).toHaveLength(1);
  expect(newUserNodes[0]?.parentId).toBe(originalNode.parentId);
  expect(newAssistantNodes[0]?.parentId).toBe(newUserNodes[0]?.id);
  expect(
    graphAfterBranch.nodes.filter(
      (node) => node.role === "assistant" && node.parentId === newUserNodes[0]?.id,
    ),
  ).toHaveLength(1);
});

test("rolls back a failed sibling branch before retrying it", async ({ page }) => {
  test.setTimeout(90_000);
  await gotoChat(page);
  await sendPrompt(page, "Failed sibling rollback root");
  await sendPrompt(page, "Failed sibling rollback original");

  const graphBeforeBranch = await copyGraphJson(page);
  const laterUserNodeId = graphBeforeBranch.nodes.find(
    (node) => node.role === "user" && node.parentId !== null,
  )?.id;
  const activeSessionId = await getActiveSessionId(page);
  expect(laterUserNodeId).toBeTruthy();
  expect(activeSessionId).toBeTruthy();
  if (!laterUserNodeId || !activeSessionId) return;

  const beforeNodeIds = graphBeforeBranch.nodes
    .filter((node) => node.id !== "__ROOT__" && !node.isBridge)
    .map((node) => node.id)
    .sort();
  await expect
    .poll(async () => {
      const persisted = await fetchSessionDocument(page, activeSessionId);
      return persisted.session.snapshot.messages.map((entry) => entry.message.id).sort();
    })
    .toEqual(beforeNodeIds);

  let failedRequests = 0;
  await page.route("**/api/canvas-branch-runs", async (route) => {
    failedRequests += 1;
    await route.fulfill({
      status: 503,
      body: JSON.stringify({
        error: {
          message:
            "The model provider is unavailable right now. Try again in a moment.",
        },
      }),
      contentType: "application/json",
    });
  });

  const blockLibrary = page.getByRole("complementary", { name: "Block library" });
  const collapseBlockLibrary = blockLibrary.getByRole("button", {
    name: "Collapse block library",
  });
  if (await collapseBlockLibrary.isVisible().catch(() => false)) {
    await collapseBlockLibrary.click();
  }
  await page.getByRole("button", { name: "Fit View" }).click();

  const targetNode = page.locator(`.react-flow__node[data-id="${laterUserNodeId}"]`);
  await expect(targetNode).toBeVisible({ timeout: 15_000 });
  const branchButton = targetNode.getByRole("button", {
    name: "Create sibling branch",
  });
  await expect(branchButton).toBeVisible();
  await branchButton.click({ force: true });

  const draftNode = page.locator('.react-flow__node[data-id="__CANVAS_PROMPT_DRAFT__"]');
  const draftPrompt = "Failed sibling rollback alternative";
  await expect(draftNode).toBeVisible({ timeout: 15_000 });
  await draftNode.getByRole("textbox", { name: "Draft prompt" }).fill(draftPrompt);
  await draftNode.getByRole("combobox", { name: "Context required" }).selectOption("parent");
  const sendButton = draftNode.getByRole("button", { name: "Send prompt node" });

  const failedResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/canvas-branch-runs") &&
      response.request().method() === "POST",
  );
  await sendButton.click();
  const failedResponse = await failedResponsePromise;
  expect(failedResponse.status()).toBe(503);
  await page.unroute("**/api/canvas-branch-runs");

  await expect(draftNode).toBeVisible({ timeout: 15_000 });
  await expect(draftNode.getByRole("textbox", { name: "Draft prompt" })).toHaveValue(draftPrompt);
  await expect(draftNode).toContainText(/unavailable|failed/i);
  await expect(sendButton).toBeEnabled();
  expect(failedRequests).toBe(1);

  const visibleConversationNodeIds = await page
    .locator(".react-flow__node-threadNode")
    .evaluateAll((nodes) =>
      nodes
        .map((node) => (node as HTMLElement).dataset.id ?? "")
        .filter((id) => id && id !== "__ROOT__")
        .sort(),
    );
  expect(visibleConversationNodeIds).toEqual(beforeNodeIds);
  await expect
    .poll(async () => {
      const persisted = await fetchSessionDocument(page, activeSessionId);
      return persisted.session.snapshot.messages.map((entry) => entry.message.id).sort();
    })
    .toEqual(beforeNodeIds);

  const retryResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/canvas-branch-runs") &&
      response.request().method() === "POST",
  );
  await sendButton.click();
  const retryResponse = await retryResponsePromise;
  expect(retryResponse.ok()).toBe(true);
  await expect(draftNode).toHaveCount(0, { timeout: 15_000 });

  const graphAfterRetry = await copyGraphJson(page);
  const retryNodes = graphAfterRetry.nodes.filter(
    (node) => !beforeNodeIds.includes(node.id) && node.id !== "__ROOT__" && !node.isBridge,
  );
  expect(retryNodes.filter((node) => node.role === "user")).toHaveLength(1);
  expect(retryNodes.filter((node) => node.role === "assistant")).toHaveLength(1);
  expect(retryNodes).toHaveLength(2);
});

test("creates a sibling user branch from a chat user node", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Chat user sibling root");
  await sendPrompt(page, "Chat user sibling original");

  await createBranchFromChat(page, {
    messageText: "Chat user sibling original",
    actionName: "Branch",
    prompt: "Chat user sibling alternative",
  });

  const graph = await copyGraphJson(page);
  const userSiblingConnectors = graph.connectors.filter((connector) => {
    if (connector.description !== "siblings" || connector.parentId === null) return false;
    const childNode = graph.nodes.find((node) => node.id === connector.childId);
    return childNode?.role === "user";
  });

  expect(userSiblingConnectors.length).toBeGreaterThan(0);
});

test("creates a follow-up user branch from a flow assistant node", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Flow assistant follow-up seed");

  const graphBeforeBranch = await copyGraphJson(page);
  const assistantNodeId = graphBeforeBranch.nodes.find((node) => node.role === "assistant")?.id;
  expect(assistantNodeId).toBeTruthy();
  if (!assistantNodeId) return;

  await createBranchFromFlow(page, {
    nodeId: assistantNodeId,
    actionName: "Add follow-up question",
    prompt: "Flow assistant follow-up prompt",
  });

  const graphAfterBranch = await copyGraphJson(page);
  const assistantChildren = graphAfterBranch.nodes.filter(
    (node) => node.role === "user" && node.parentId === assistantNodeId,
  );
  expect(assistantChildren.length).toBeGreaterThan(0);
});

test("creates a follow-up user branch from a chat assistant node", async ({ page }) => {
  await gotoChat(page);
  const assistantReply = await sendPrompt(page, "Chat assistant follow-up seed");

  await createBranchFromChat(page, {
    messageText: assistantReply,
    actionName: "Branch",
    panelActionName: "Add follow-up question",
    prompt: "Chat assistant follow-up prompt",
  });

  const graph = await copyGraphJson(page);
  const assistantNodeId = graph.nodes.find(
    (node) => node.role === "assistant" && node.parentId !== null,
  )?.id;
  const assistantChildren = graph.nodes.filter(
    (node) => node.role === "user" && node.parentId === assistantNodeId,
  );

  expect(assistantNodeId).toBeTruthy();
  expect(assistantChildren.length).toBeGreaterThan(0);
});

test("renders distinct root-user branches without overlap", async ({ page }) => {
  await gotoChat(page);

  const originalPrompt = "Root branch original prompt";
  const editedPrompt = "Root branch edited prompt";
  await sendPrompt(page, originalPrompt);
  await editUserPrompt(page, originalPrompt, editedPrompt);

  await expect(page.locator('.react-flow__node[data-id="__ROOT__"]')).toBeVisible();

  const graph = await copyGraphJson(page);
  const rootUserNodes = graph.nodes.filter((node) => node.role === "user" && node.parentId === null);
  const siblingRootConnectors = graph.connectors.filter(
    (connector) => connector.description === "siblings" && connector.parentId === null,
  );

  expect(rootUserNodes).toHaveLength(2);
  expect(siblingRootConnectors.length).toBeGreaterThan(0);

  const boxes = await getFlowNodeBoxes(page);
  const overlapPairs = getOverlappingNodePairs(boxes);
  expect(overlapPairs).toEqual([]);
});

test("renders distinct later-user branches without overlap", async ({ page }) => {
  await gotoChat(page);

  await sendPrompt(page, "Thread root prompt");
  await sendPrompt(page, "Later user original prompt");
  await editUserPrompt(page, "Later user original prompt", "Later user edited prompt");

  const graph = await copyGraphJson(page);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const assistantIdsWithUserChildren = graph.nodes
    .filter((node) => node.role === "assistant")
    .map((assistantNode) => ({
      assistantId: assistantNode.id,
      userChildren: graph.nodes.filter(
        (candidate) => candidate.role === "user" && candidate.parentId === assistantNode.id,
      ),
    }))
    .filter((entry) => entry.userChildren.length >= 2);

  expect(assistantIdsWithUserChildren).toHaveLength(1);
  expect(assistantIdsWithUserChildren[0]?.userChildren).toHaveLength(2);

  const laterUserSiblingConnectors = graph.connectors.filter((connector) => {
    if (connector.description !== "siblings" || connector.parentId === null) return false;
    const childNode = nodesById.get(connector.childId);
    return childNode?.role === "user";
  });

  expect(laterUserSiblingConnectors.length).toBeGreaterThan(0);

  const overlapPairs = getOverlappingNodePairs(await getFlowNodeBoxes(page));
  expect(overlapPairs).toEqual([]);
});

test("cuts a graph link from the flow renderer", async ({ page }) => {
  await gotoChat(page);
  await sendPrompt(page, "Flow cut prompt");

  const graphBeforeCut = await copyGraphJson(page);
  const parentChildCountBeforeCut = graphBeforeCut.connectors.filter(
    (connector) => connector.description === "parent-child",
  ).length;
  expect(parentChildCountBeforeCut).toBeGreaterThan(0);

  const rootNode = page.locator('.react-flow__node[data-id="__ROOT__"]');
  await rootNode
    .getByRole("button", { name: "Edit links" })
    .evaluate((button: HTMLButtonElement) => button.click());
  const cutLinkButton = page.getByRole("button", { name: "Cut link" }).first();
  await expect(cutLinkButton).toBeVisible();
  await cutLinkButton.click();

  const graphAfterCut = await copyGraphJson(page);
  expect(
    graphAfterCut.connectors.filter((connector) => connector.description === "parent-child").length,
  ).toBe(parentChildCountBeforeCut - 1);
});

test("deletes a session durably across reload", async ({ page }) => {
  test.setTimeout(60_000);

  await gotoChat(page);
  await sendPrompt(page, "Delete persistence prompt");

  const beforeDelete = await listSessionIds(page);
  const activeSessionId = await getActiveSessionId(page);
  expect(activeSessionId).toBeTruthy();
  if (!activeSessionId) return;
  expect(beforeDelete).toContain(activeSessionId);

  await page
    .locator('[data-active="true"]')
    .filter({ has: page.getByRole("button", { name: "Delete session" }) })
    .first()
    .getByRole("button", { name: "Delete session" })
    .click();

  await expect
    .poll(async () => {
      const sessionIds = await listSessionIds(page);
      return sessionIds.includes(activeSessionId);
    })
    .toBe(false);

  const verificationResponse = await page.request.get("/api/sessions");
  expect(verificationResponse.ok()).toBeTruthy();
  const verificationData = (await verificationResponse.json()) as {
    sessions: Array<{ id: string }>;
  };
  expect(verificationData.sessions.map((session) => session.id)).not.toContain(activeSessionId);

  await page.close();
});

test("creates a project from multiple saved sessions and opens the aggregated canvas", async ({ page }) => {
  const firstSessionId = await createAndOpenNamedSession(page, "Project session one");
  await sendPrompt(page, "Project session one");

  const secondSessionId = await createAndOpenNamedSession(page, "Project session two");
  await sendPrompt(page, "Project session two");
  const projectId = await createProjectFromSessions(
    page,
    [firstSessionId, secondSessionId],
    "2 Session Project",
  );
  await openProjectById(page, projectId);

  await expect(page.getByRole("button", { name: "Back to sessions" })).toBeVisible();
  await expect(
    page.getByText("Projects aggregate multiple saved sessions into one persistent canvas."),
  ).toBeVisible();
  const projectSetupNode = page
    .locator(".react-flow__node")
    .filter({ has: page.getByRole("heading", { name: "Project Setup", exact: true }) })
    .first();
  await expect(projectSetupNode).toBeVisible();
  await expect(projectSetupNode).toContainText("2 sessions");

  await page.getByRole("button", { name: "Arena" }).last().click();
  await expect(page.getByRole("heading", { name: "Project Arena" })).toBeVisible();
  await expect(page.locator("p").filter({ hasText: "Arena Synthesis" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Open Nodes" }).click();
  await page.getByLabel("Typed node title").fill("Arena memo");
  await page.getByRole("button", { name: "Pick winner" }).click();
  await page.getByRole("button", { name: "Save arena synthesis" }).click();
  await expect(page.getByText("Typed node saved from Arena synthesis.")).toBeVisible();
  await page.getByRole("button", { name: "Open Arena" }).click();
  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByText("Arena comparison across 2 selected branches.")).toBeVisible();
  await expect(page.getByText("Compare 2 branches side by side and promote a lead direction into global context.")).toBeVisible();
  await page.getByRole("button", { name: "Create merge node" }).click();
  await expect(page.getByText(/merge node$/i).first()).toBeVisible();

  const persistedProject = await fetchAppJson<{
    project: { memoryIds: string[] };
  }>(page, `/api/projects/${projectId}`);
  const persistedMemory = await fetchAppJson<{
    items: Array<{
      id: string;
      sourceKeys: string[];
      sourceProjectId: string | null;
      sourceSessionId: string | null;
      sourceKind: string | null;
      title: string;
      type: string;
    }>;
  }>(page, "/api/memory");
  const arenaMemo = persistedMemory.items.find((item) => item.title === "Arena memo");
  const arenaMergeNode = persistedMemory.items.find(
    (item) => item.type === "merge" && item.sourceProjectId === projectId,
  );
  expect(arenaMemo).toBeDefined();
  expect(arenaMergeNode).toBeDefined();
  expect(arenaMemo).toMatchObject({
    sourceProjectId: projectId,
    sourceKind: "session",
    type: "summary",
  });
  expect(arenaMergeNode).toMatchObject({
    sourceKind: "branch",
    sourceProjectId: projectId,
    type: "merge",
  });
  expect(arenaMemo!.sourceKeys.length).toBeGreaterThan(0);
  expect(arenaMergeNode!.sourceKeys.length).toBe(2);
  expect(persistedProject.project.memoryIds).toContain(arenaMemo!.id);
  expect(persistedProject.project.memoryIds).toContain(arenaMergeNode!.id);

  await page.getByRole("button", { name: "Canvas" }).last().click();
  await expect(projectSetupNode).toBeVisible();
});

test("creates a typed node from canvas focus inside a project", async ({ page }) => {
  test.setTimeout(60_000);
  const firstSessionId = await createAndOpenNamedSession(page, "Typed node session one");
  await sendPrompt(page, "Typed node session one");

  const secondSessionId = await createAndOpenNamedSession(page, "Typed node session two");
  await sendPrompt(page, "Typed node session two");
  const projectId = await createProjectFromSessions(
    page,
    [firstSessionId, secondSessionId],
    "Typed node project",
  );
  await openProjectById(page, projectId);

  const projectSetupNode = page
    .locator(".react-flow__node")
    .filter({ has: page.getByRole("heading", { name: "Project Setup", exact: true }) })
    .first();
  await expect(projectSetupNode).toBeVisible();
  await projectSetupNode.click();

  await page.getByRole("button", { name: "Open Nodes" }).click();
  await page.getByLabel("Typed node type").selectOption("decision");
  await page.getByRole("button", { name: "Use canvas focus" }).click();
  await page.getByRole("button", { name: "Create typed node", exact: true }).click();

  await expect(page.getByText("Decision node created and attached.")).toBeVisible();
  const persistedProject = await fetchAppJson<{
    project: { memoryIds: string[] };
  }>(page, `/api/projects/${projectId}`);
  const persistedMemory = await fetchAppJson<{
    items: Array<{
      id: string;
      sourceKeys: string[];
      sourceProjectId: string | null;
      sourceSessionId: string | null;
      sourceKind: string | null;
      title: string;
      type: string;
    }>;
  }>(page, "/api/memory");
  const decisionNode = persistedMemory.items.find(
    (item) => item.type === "decision" && item.sourceProjectId === projectId,
  );
  expect(decisionNode).toBeDefined();
  expect(decisionNode).toMatchObject({
    sourceKind: null,
    sourceProjectId: projectId,
    sourceSessionId: firstSessionId,
    type: "decision",
  });
  expect(decisionNode!.sourceKeys).toEqual([]);
  expect(persistedProject.project.memoryIds).toContain(decisionNode!.id);
});

test("deletes a project durably across reload", async ({ page }) => {
  test.setTimeout(60_000);
  const firstSessionId = await createAndOpenNamedSession(page, "Project delete one");
  await sendPrompt(page, "Project delete one");
  const secondSessionId = await createAndOpenNamedSession(page, "Project delete two");
  await sendPrompt(page, "Project delete two");
  const projectId = await createProjectFromSessions(
    page,
    [firstSessionId, secondSessionId],
    "Project delete set",
  );
  await openProjectById(page, projectId);

  const beforeDelete = await listProjectIds(page);
  const activeProjectId = projectId || await getActiveProjectId(page);
  expect(activeProjectId).toBeTruthy();
  if (!activeProjectId) return;
  expect(beforeDelete).toContain(activeProjectId);

  await fetchAppJson(page, "/api/projects", {
    method: "DELETE",
    body: JSON.stringify({ projectIds: [activeProjectId] }),
  }).catch((error) => {
    if (error instanceof Error && error.message.endsWith(": 404")) {
      return null;
    }
    throw error;
  });

  const afterDelete = await listProjectIds(page);
  expect(afterDelete).not.toContain(activeProjectId);
  const verificationResponse = await page.request.get("/api/projects");
  expect(verificationResponse.ok()).toBeTruthy();
  const verificationData = (await verificationResponse.json()) as {
    projects: Array<{ id: string }>;
  };
  expect(verificationData.projects.map((project) => project.id)).not.toContain(activeProjectId);
});

test("shows a visible fallback message when the provider request fails", async ({ page }) => {
  await page.route("**/api/chat", async (route) => {
    await route.fulfill({
      status: 503,
      body: "LLM backend unavailable",
      contentType: "text/plain",
    });
  });

  await gotoChat(page);
  const composer = page.getByPlaceholder("Write a message...");
  await composer.fill("Provider failure prompt");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(threadMessage(page, "Provider failure prompt")).toBeVisible();
  await expect(page.getByTestId("composer-error")).toContainText(
    /Assistant request failed\. Check the selected model or provider and try again\.|LLM backend unavailable/i,
    { timeout: 15_000 },
  );
  await expect(composer).toBeVisible();
});

test("creates and persists a semantic text artifact from the block library", async ({ page }) => {
  test.setTimeout(60_000);
  await gotoChat(page);
  await sendPrompt(page, "Artifact context seed");

  const activeSessionId = await getActiveSessionId(page);
  expect(activeSessionId).toBeTruthy();
  if (!activeSessionId) return;

  await page.getByRole("button", { name: "Add Text block" }).click();
  await page.getByRole("button", { name: "Fit View" }).click();
  await expect(page.locator(".react-flow__node-artifactNode").last()).toBeVisible();

  const graph = await copyGraphJson(page);
  expect(
    graph.artifacts?.some(
      (artifact) => artifact.title === "Text Context 1" && artifact.type === "text",
    ),
  ).toBe(true);

  const persistedSession = await fetchPersistedSession(page, activeSessionId);
  expect(
    persistedSession.session.artifacts.some(
      (artifact) => artifact.title === "Text Context 1" && artifact.artifactType === "text",
    ),
  ).toBe(true);
});

test("uploads and persists an image artifact from the canvas", async ({ page }) => {
  test.setTimeout(60_000);
  await gotoChat(page);
  await sendPrompt(page, "Image artifact seed");

  const activeSessionId = await getActiveSessionId(page);
  expect(activeSessionId).toBeTruthy();
  if (!activeSessionId) return;

  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/sessions/${activeSessionId}/artifacts`) &&
      response.request().method() === "POST",
  );

  await page.getByTestId("artifact-image-upload-input").setInputFiles({
      name: "diagram.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });

  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.ok()).toBe(true);
  await expect
    .poll(async () => {
      const persisted = await fetchPersistedSession(page, activeSessionId);
      return persisted.session.artifacts.some(
        (artifact) => artifact.title === "diagram" && artifact.artifactType === "image",
      );
    })
    .toBe(true);

  const graph = await copyGraphJson(page);
  expect(
    graph.artifacts?.some(
      (artifact) => artifact.title === "diagram" && artifact.type === "image",
    ),
  ).toBe(true);
});

test("marks the selected Canvas node in the graph", async ({ page }) => {
  await gotoChat(page);
  const reply = await sendPrompt(page, "Canvas guide seed");

  const graph = await copyGraphJson(page);
  const assistantNodeId = graph.nodes.find((node) => node.role === "assistant")?.id;
  expect(assistantNodeId).toBeTruthy();
  if (!assistantNodeId) return;

  const assistantNode = page.locator(`.react-flow__node[data-id="${assistantNodeId}"]`);
  await expect(assistantNode).toBeVisible();
  await assistantNode.click({ position: { x: 24, y: 24 } });
  await expect(assistantNode.getByText("Focus", { exact: true })).toBeVisible();
  await expect(assistantNode).toContainText(reply);
});
