import { chromium } from "playwright";
import path from "node:path";

const CHATGPT_URL = "https://chatgpt.com/";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChatGPTWebSession {
  constructor(options = {}) {
    this.profileDir = path.resolve(options.profileDir || ".data/chatgpt-profile");
    this.headless = options.headless ?? false;
    this.timeoutMs = Number(options.timeoutMs || 180000);
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
  }

  async start() {
    if (this.context) return;

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 980 },
      args: ["--disable-blink-features=AutomationControlled"]
    });

    const pages = this.context.pages();
    this.page = pages[0] || await this.context.newPage();
    this.page.setDefaultTimeout(30000);

    if (!this.page.url().startsWith("https://chatgpt.com")) {
      await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    }
  }

  async stop() {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }

  async getStatus() {
    await this.start();
    const composer = await this.findComposer({ timeout: 3000 }).catch(() => null);
    return {
      ready: Boolean(composer),
      url: this.page.url(),
      profileDir: this.profileDir
    };
  }

  async findComposer({ timeout = 30000 } = {}) {
    const selectors = [
      "#prompt-textarea",
      '[data-testid="prompt-textarea"]',
      'div[contenteditable="true"][role="textbox"]'
    ];

    for (const selector of selectors) {
      const locator = this.page.locator(selector).first();
      try {
        await locator.waitFor({ state: "visible", timeout });
        return locator;
      } catch {}
    }

    throw new Error(
      "ChatGPT composer not found. Open the browser window, sign in to ChatGPT, then retry."
    );
  }

  async newChat() {
    await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    await this.findComposer();
  }

  buildPrompt(messages = []) {
    return messages.map((message) => {
      const role = String(message.role || "user").toUpperCase();
      const content = Array.isArray(message.content)
        ? message.content
            .filter((part) => part?.type === "text" || part?.type === "input_text")
            .map((part) => part.text || "")
            .join("\n")
        : String(message.content ?? "");
      return `[${role}]\n${content}`;
    }).join("\n\n");
  }

  async complete(messages, options = {}) {
    const task = async () => {
      await this.start();

      if (options.newChat !== false) {
        await this.newChat();
      }

      const prompt = this.buildPrompt(messages);
      if (!prompt.trim()) throw new Error("No text input was provided.");

      const before = await this.page.locator('[data-message-author-role="assistant"]').count();
      const composer = await this.findComposer();

      await composer.click();
      await composer.fill(prompt).catch(async () => {
        await composer.pressSequentially(prompt, { delay: 1 });
      });
      await composer.press("Enter");

      const startedAt = Date.now();
      let lastText = "";
      let stableSince = Date.now();

      while (Date.now() - startedAt < this.timeoutMs) {
        const assistantMessages = this.page.locator('[data-message-author-role="assistant"]');
        const count = await assistantMessages.count();

        if (count > before) {
          const latest = assistantMessages.nth(count - 1);
          const text = (await latest.innerText().catch(() => "")).trim();

          if (text && text !== lastText) {
            lastText = text;
            stableSince = Date.now();
          }

          const stopVisible = await this.page
            .locator('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Parar"]')
            .first()
            .isVisible()
            .catch(() => false);

          if (lastText && !stopVisible && Date.now() - stableSince > 1200) {
            return lastText;
          }
        }

        await sleep(350);
      }

      if (lastText) return lastText;
      throw new Error("Timed out waiting for a ChatGPT response.");
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
