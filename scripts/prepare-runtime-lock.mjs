import fs from "node:fs";

const packagePath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

Object.assign(packageJson.dependencies, {
  "@ai-sdk/openai": "4.0.16",
  "@assistant-ui/react": "0.14.27",
  "@assistant-ui/react-ai-sdk": "1.3.41",
  "@assistant-ui/react-markdown": "0.14.6",
  ai: "7.0.31",
});

Object.assign(packageJson.overrides, {
  "@ai-sdk/gateway": "4.0.23",
  "@ai-sdk/mcp": "2.0.15",
  "@ai-sdk/provider-utils": "5.0.11",
  "@ai-sdk/react": "4.0.34",
  "@assistant-ui/core": "0.2.21",
  "@assistant-ui/store": "0.2.20",
  "@assistant-ui/tap": "0.9.4",
  "assistant-stream": "0.3.26",
});

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const testPath = "tests/e2e/smoke.spec.ts";
let source = fs.readFileSync(testPath, "utf8");

const oldCanvasResponse = `  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/chat") && response.request().method() === "POST",
  );
  void submitActionName;
`;
const newCanvasResponse = `  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/canvas-branch-runs") &&
      response.request().method() === "POST",
  );
  void submitActionName;
`;
if (!source.includes(oldCanvasResponse)) {
  throw new Error("Canvas branch response expectation was not found.");
}
source = source.replace(oldCanvasResponse, newCanvasResponse);

const oldLatencyTest = `test("sends a prompt and renders the mocked assistant reply", async ({ page }) => {
  await gotoChat(page);
  const reply = await sendPrompt(page, "Browser smoke prompt");
  const assistantMessage = page.locator("[data-message-id]").filter({
    has: page.getByText(reply, { exact: true }),
  }).first();
  await expect(assistantMessage.getByText(/Latency:/)).toBeVisible();
});
`;
const newLatencyTest = `test("sends a prompt and renders the mocked assistant reply", async ({ page }) => {
  await gotoChat(page);
  const reply = await sendPrompt(page, "Browser smoke prompt");
  await expect(threadMessage(page, reply)).toBeVisible();
});
`;
if (!source.includes(oldLatencyTest)) {
  throw new Error("Stale latency assertion was not found.");
}

fs.writeFileSync(testPath, source.replace(oldLatencyTest, newLatencyTest));
