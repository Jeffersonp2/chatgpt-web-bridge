import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";
import { ChatGPTWebSession } from "../src/browser.js";

test("stream polling interval is bounded for the browser UI", () => {
  assert.equal(new ChatGPTWebSession().streamPollMs, 200);
  assert.equal(new ChatGPTWebSession({ streamPollMs: 10 }).streamPollMs, 100);
  assert.equal(new ChatGPTWebSession({ streamPollMs: 5000 }).streamPollMs, 1000);
});

test("tab recovery creates a chat tab instead of reusing the keeper tab", async () => {
  const session = new ChatGPTWebSession();
  const keeper = { isClosed: () => false, url: () => "about:blank" };
  let currentUrl = "about:blank";
  const recovered = {
    isClosed: () => false,
    url: () => currentUrl,
    goto: async (url) => { currentUrl = url; }
  };
  session.context = {
    pages: () => [keeper],
    newPage: async () => recovered
  };
  session.keeperPage = keeper;
  session.configurePage = () => {};
  session.schedulePageRecovery();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(session.page, recovered);
  assert.notEqual(session.page, session.keeperPage);
  assert.equal(currentUrl, "https://chatgpt.com/");
  session.stopping = true;
});

test("final file collection tolerates a tab closing after a download", async () => {
  const session = new ChatGPTWebSession();
  session.page = null;
  const result = await session.collectTurnResult(
    { evaluate: async () => { throw new Error("Target closed"); } },
    new Set(),
    { files: () => [], urls: () => new Set() },
    { clickDownloads: true }
  );
  assert.deepEqual(result, { text: "", files: [] });
});

test("assistant selector recognizes both UI variants without double counting", async (t) => {
  const bundled = fs.existsSync(chromium.executablePath());
  const systemChrome = process.platform === "win32" &&
    fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  if (!bundled && !systemChrome) return t.skip("Playwright browser not installed");
  const browser = await chromium.launch({ headless: true, ...(bundled ? {} : { channel: "chrome" }) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <div data-testid="conversation-turn-1" data-turn="assistant">
      <div data-message-author-role="assistant"><div class="markdown">Primeira</div></div>
    </div>
    <div data-message-author-role="assistant"><div class="prose">Segunda</div></div>
  `);
  const session = new ChatGPTWebSession();
  session.page = page;
  const turns = session.assistantTurnLocator();
  assert.equal(await turns.count(), 2);
  assert.equal((await session.extractAssistantTurnData(turns.nth(0))).text, "Primeira");
  assert.equal((await session.extractAssistantTurnData(turns.nth(1))).text, "Segunda");
});

test("Chromium keeps a separate tab after repeated downloads and chat closure", async (t) => {
  const bundled = fs.existsSync(chromium.executablePath());
  const systemChrome = process.platform === "win32" &&
    fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  if (!bundled && !systemChrome) return t.skip("Playwright browser not installed");
  const browser = await chromium.launch({ headless: true, ...(bundled ? {} : { channel: "chrome" }) });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<main>Chat</main>" }));
  const keeper = await context.newPage();
  const active = await context.newPage();
  await active.setContent('<a id="file" download="sample.txt" href="data:text/plain,hello">Download</a>');
  const session = new ChatGPTWebSession();
  session.context = context;
  session.keeperPage = keeper;
  session.page = active;
  session.configurePage(keeper);
  session.configurePage(active);
  for (let i = 0; i < 3; i++) {
    const download = active.waitForEvent("download");
    await active.locator("#file").click();
    assert.equal((await download).suggestedFilename(), "sample.txt");
    assert.equal(active.isClosed(), false);
  }
  await active.close();
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(keeper.isClosed(), false);
  assert.ok(session.page && session.page !== keeper && !session.page.isClosed());
  session.stopping = true;
  await context.close();
});
