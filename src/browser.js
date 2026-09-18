import { chromium } from "playwright";
import path from "node:path";

const CHATGPT_URL = "https://chatgpt.com/";
const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";

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
    this.bridgeHistory = [];
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

  async openLoginIfNeeded() {
    await this.start();

    const auth = await this.getAuthState();

    if (!auth.authenticated) {
      await this.page.goto(CHATGPT_LOGIN_URL, { waitUntil: "domcontentloaded" });
      await this.page.bringToFront().catch(() => {});
      return { authenticated: false, url: this.page.url() };
    }

    if (!this.page.url().startsWith(CHATGPT_URL)) {
      await this.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    }

    await this.page.bringToFront().catch(() => {});
    return { authenticated: true, url: this.page.url() };
  }

  isConversationPage() {
    try {
      const url = new URL(this.page?.url() || CHATGPT_URL);
      return /^\/c\//.test(url.pathname);
    } catch {
      return false;
    }
  }

  async getAuthState() {
    await this.start();

    try {
      const state = await this.page.evaluate(async () => {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
          cache: "no-store"
        });

        const text = await response.text();
        let data = {};

        try {
          data = JSON.parse(text);
        } catch {}

        return {
          ok: response.ok,
          status: response.status,
          user: data?.user || null,
          expires: data?.expires || null
        };
      });

      return {
        authenticated: Boolean(state?.user),
        user: state?.user || null,
        expires: state?.expires || null,
        sessionEndpointStatus: state?.status ?? null
      };
    } catch {
      return {
        authenticated: false,
        user: null,
        expires: null,
        sessionEndpointStatus: null
      };
    }
  }

  async getStatus() {
    await this.start();

    const [composer, auth] = await Promise.all([
      this.findComposer({ timeout: 3000 }).catch(() => null),
      this.getAuthState()
    ]);

    return {
      ready: Boolean(composer) && auth.authenticated,
      authenticated: auth.authenticated,
      user: auth.user
        ? {
            name: auth.user.name || null,
            email: auth.user.email || null
          }
        : null,
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

  sameMessage(a, b) {
    return String(a?.role || "") === String(b?.role || "") &&
      this.messageText(a).trim() === this.messageText(b).trim();
  }

  seedHistory(messages = []) {
    this.bridgeHistory = messages
      .filter((message) => this.messageText(message).trim())
      .map((message) => ({
        role: String(message.role || "user"),
        content: this.messageText(message)
      }));
  }

  recordMessage(role, content) {
    const message = { role, content: String(content || "") };
    if (!message.content.trim()) return;

    const last = this.bridgeHistory[this.bridgeHistory.length - 1];
    if (!this.sameMessage(last, message)) {
      this.bridgeHistory.push(message);
    }
  }

  assistantResultToHistoryText(result) {
    const text = String(result?.text || "").trim();
    if (text) return text;

    if (Array.isArray(result?.files) && result.files.length) {
      const names = result.files
        .map((file) => file.name || file.file_id || file.url)
        .filter(Boolean)
        .join(", ");
      return names ? `Generated files: ${names}` : "Generated file attachment.";
    }

    return "";
  }

  buildRolloverPrompt(messages = []) {
    const historySource = this.bridgeHistory.length ? this.bridgeHistory : messages;
    const history = this.buildPrompt(historySource);
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

  async extractAssistantTurnData(turnLocator) {
    return await turnLocator.evaluate((node) => {
      const absoluteUrl = (value) => {
        try {
          return new URL(value, location.origin).toString();
        } catch {
          return null;
        }
      };

      const guessMimeType = (name, url, tagName) => {
        const full = `${name || ""} ${url || ""}`.toLowerCase();

        if (tagName === "img" || /\.(png|jpg|jpeg|gif|webp|bmp|svg)(\?|$)/i.test(full)) {
          if (full.includes(".png")) return "image/png";
          if (full.includes(".jpg") || full.includes(".jpeg")) return "image/jpeg";
          if (full.includes(".gif")) return "image/gif";
          if (full.includes(".webp")) return "image/webp";
          if (full.includes(".svg")) return "image/svg+xml";
          return "image/*";
        }

        if (tagName === "video" || tagName === "source" || /\.(mp4|webm|mov|mkv|avi)(\?|$)/i.test(full)) {
          if (full.includes(".mp4")) return "video/mp4";
          if (full.includes(".webm")) return "video/webm";
          if (full.includes(".mov")) return "video/quicktime";
          if (full.includes(".mkv")) return "video/x-matroska";
          if (full.includes(".avi")) return "video/x-msvideo";
          return "video/*";
        }

        if (/\.zip(\?|$)/i.test(full)) return "application/zip";
        if (/\.pdf(\?|$)/i.test(full)) return "application/pdf";
        if (/\.txt(\?|$)/i.test(full)) return "text/plain";
        if (/\.html?(\?|$)/i.test(full)) return "text/html";
        if (/\.css(\?|$)/i.test(full)) return "text/css";
        if (/\.js(\?|$)/i.test(full)) return "text/javascript";
        if (/\.json(\?|$)/i.test(full)) return "application/json";
        if (/\.py(\?|$)/i.test(full)) return "text/x-python";

        return null;
      };

      const guessKind = (mimeType, tagName) => {
        if (mimeType?.startsWith("image/") || tagName === "img") return "image";
        if (mimeType?.startsWith("video/") || tagName === "video" || tagName === "source") return "video";
        if (mimeType?.startsWith("text/")) return "text";
        if (mimeType === "application/zip") return "archive";
        if (mimeType === "application/pdf") return "document";
        return "file";
      };

      const pickName = (el, url) => {
        const direct =
          el.getAttribute("download") ||
          el.getAttribute("data-filename") ||
          el.getAttribute("aria-label");

        if (direct && direct.trim()) return direct.trim();

        try {
          const parsed = new URL(url);
          const queryName = parsed.searchParams.get("filename") || parsed.searchParams.get("name");
          if (queryName) return queryName;

          const fileId = parsed.searchParams.get("id");
          if (fileId) return fileId;

          const last = parsed.pathname.split("/").pop();
          if (last && !/content$/i.test(last)) return decodeURIComponent(last);
        } catch {}

        const text = (el.textContent || "").trim();
        if (text && text.length <= 180) return text;

        return null;
      };

      const elements = node.querySelectorAll("a[href], img[src], video[src], source[src]");
      const files = [];
      const seen = new Set();

      for (const el of elements) {
        const tagName = el.tagName.toLowerCase();
        const rawUrl = el.getAttribute("href") || el.getAttribute("src");
        if (!rawUrl) continue;

        const url = absoluteUrl(rawUrl);
        if (!url) continue;

        const interesting =
          url.includes("/backend-api/estuary/content") ||
          url.includes("file_") ||
          url.startsWith("blob:");

        if (!interesting || seen.has(url)) continue;
        seen.add(url);

        let fileId = null;
        try {
          fileId = new URL(url).searchParams.get("id");
        } catch {}

        const name = pickName(el, url);
        const mimeType = guessMimeType(name, url, tagName);

        files.push({
          name,
          mime_type: mimeType,
          kind: guessKind(mimeType, tagName),
          file_id: fileId,
          url
        });
      }

      return {
        text: (node.innerText || "").trim(),
        files
      };
    });
  }

  async sendPrompt(prompt) {
    const auth = await this.getAuthState();

    if (!auth.authenticated) {
      const error = new Error(
        "ChatGPT is not authenticated in the Playwright browser. Open /login and sign in there before using /v1."
      );
      error.code = "not_authenticated";
      throw error;
    }

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
    let lastResult = { text: "", files: [] };
    let lastSnapshot = "";
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
        const result = await this.extractAssistantTurnData(latest).catch(() => ({
          text: "",
          files: []
        }));

        const snapshot = JSON.stringify(result);

        if ((result.text || result.files.length) && snapshot !== lastSnapshot) {
          lastResult = result;
          lastSnapshot = snapshot;
          stableSince = Date.now();
        }

        const stopVisible = await this.page
          .locator('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Parar"]')
          .first()
          .isVisible()
          .catch(() => false);

        if ((lastResult.text || lastResult.files.length) && !stopVisible && Date.now() - stableSince > 1200) {
          return lastResult;
        }
      }

      await sleep(350);
    }

    if (lastResult.text || lastResult.files.length) return lastResult;
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
        this.seedHistory(messages);
      } else if (!hadConversation || this.bridgeHistory.length === 0) {
        this.seedHistory(messages);
      }

      const shouldSendFullContext = forceNewChat || !hadConversation;
      const prompt = shouldSendFullContext
        ? this.buildPrompt(messages)
        : this.buildLatestPrompt(messages);

      if (!prompt.trim()) throw new Error("No text input was provided.");

      if (!shouldSendFullContext) {
        this.recordMessage("user", prompt);
      }

      try {
        const result = await this.sendPrompt(prompt);
        this.recordMessage("assistant", this.assistantResultToHistoryText(result));
        return result;
      } catch (error) {
        if (error?.code !== "conversation_limit" || !autoRollover) {
          throw error;
        }

        this.rollovers += 1;
        await this.newChat();

        const rolloverPrompt = this.buildRolloverPrompt(messages);
        const result = await this.sendPrompt(rolloverPrompt);
        this.recordMessage("assistant", this.assistantResultToHistoryText(result));
        return result;
      }
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
