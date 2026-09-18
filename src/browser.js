import { chromium } from "playwright";
import path from "node:path";

const CHATGPT_URL = "https://chatgpt.com/";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ConversationLimitError extends Error {
  constructor(message = "The current ChatGPT conversation reached its conversation-specific limit.") {
    super(message);
    this.name = "ConversationLimitError";
    this.code = "conversation_limit";
  }
}

export class ChatGPTWebSession {
  constructor(options = {}) {
    this.profileDir = path.resolve(options.profileDir || ".data/chatgpt-profile");
    this.headless = options.headless ?? false;
    this.timeoutMs = Number(options.timeoutMs || 180000);
    this.context = null;
    this.page = null;
    this.queue = Promise.resolve();
    this.rollovers = 0;
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

  isConversationPage() {
    try {
      const url = new URL(this.page?.url() || CHATGPT_URL);
      return /^\/c\//.test(url.pathname);
    } catch {
      return false;
    }
  }

  async getStatus() {
    await this.start();
    const composer = await this.findComposer({ timeout: 3000 }).catch(() => null);
    return {
      ready: Boolean(composer),
      url: this.page.url(),
      conversationActive: this.isConversationPage(),
      rollovers: this.rollovers,
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

  messageText(message) {
    if (!message) return "";

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text" || part?.type === "input_text")
        .map((part) => part.text || "")
        .join("\n");
    }

    return String(message.content ?? "");
  }

  buildPrompt(messages = []) {
    return messages.map((message) => {
      const role = String(message.role || "user").toUpperCase();
      return `[${role}]\n${this.messageText(message)}`;
    }).join("\n\n");
  }

  buildLatestPrompt(messages = []) {
    const meaningful = [...messages]
      .reverse()
      .find((message) => this.messageText(message).trim());

    if (!meaningful) return "";
    return this.messageText(meaningful);
  }

  buildRolloverPrompt(messages = []) {
    const history = this.buildPrompt(messages);
    return [
      "Continue the same conversation in this new normal ChatGPT chat.",
      "The previous chat reached its conversation-specific limit.",
      "Use the conversation history below as context and answer the final user request without mentioning this handoff unless relevant.",
      "",
      history
    ].join("\n");
  }

  async getConversationLimitMessage() {
    const bodyText = (await this.page.locator("body").innerText().catch(() => "")).toLowerCase();

    const conversationLimitPhrases = [
      "maximum length for this conversation",
      "conversation has reached its maximum length",
      "this conversation is too long",
      "maximum conversation length",
      "start a new chat to continue",
      "comprimento máximo desta conversa",
      "limite máximo desta conversa",
      "esta conversa atingiu o limite",
      "esta conversa chegou ao limite",
      "inicie uma nova conversa para continuar",
      "comece uma nova conversa para continuar"
    ];

    const matched = conversationLimitPhrases.find((phrase) => bodyText.includes(phrase));
    return matched || null;
  }

  async sendPrompt(prompt) {
    const limitBeforeSend = await this.getConversationLimitMessage();
    if (limitBeforeSend) {
      throw new ConversationLimitError(limitBeforeSend);
    }

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
      const conversationLimit = await this.getConversationLimitMessage();
      if (conversationLimit) {
        throw new ConversationLimitError(conversationLimit);
      }

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
  }

  async complete(messages, options = {}) {
    const task = async () => {
      await this.start();

      const forceNewChat = options.newChat === true;
      const autoRollover = options.autoRollover !== false;
      const hadConversation = this.isConversationPage();

      if (forceNewChat) {
        await this.newChat();
      }

      const shouldSendFullContext = forceNewChat || !hadConversation;
      const prompt = shouldSendFullContext
        ? this.buildPrompt(messages)
        : this.buildLatestPrompt(messages);

      if (!prompt.trim()) throw new Error("No text input was provided.");

      try {
        return await this.sendPrompt(prompt);
      } catch (error) {
        if (error?.code !== "conversation_limit" || !autoRollover) {
          throw error;
        }

        this.rollovers += 1;
        await this.newChat();

        const rolloverPrompt = this.buildRolloverPrompt(messages);
        return await this.sendPrompt(rolloverPrompt);
      }
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
