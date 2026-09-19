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
    this.lastConversationUrl = null;
    this.startPromise = null;
    this.relaunchTimer = null;
    this.pageRecoveryTimer = null;
    this.configuredPages = new WeakSet();
    this.keeperPage = null;
    this.stopping = false;
  }

  configurePage(page) {
    if (!page || this.configuredPages.has(page)) return;

    this.configuredPages.add(page);
    page.setDefaultTimeout(30000);

    page.on("close", () => {
      const wasActivePage = this.page === page;
      const wasKeeperPage = this.keeperPage === page;

      if (wasActivePage) {
        this.page = null;
      }

      if (wasKeeperPage) {
        this.keeperPage = null;
      }

      if (this.stopping) return;

      if (wasKeeperPage) {
        console.warn("[bridge] Keeper tab closed.");

        setTimeout(async () => {
          if (
            this.stopping ||
            this.keeperPage ||
            !this.context ||
            this.context !== page.context()
          ) {
            return;
          }

          try {
            const livePages = this.context.pages().filter((candidate) => !candidate.isClosed());
            if (!livePages.length && !this.page) {
              return;
            }

            await this.ensureKeeperPage();
            console.log("[bridge] Keeper tab recreated.");
          } catch {}
        }, 750);

        return;
      }

      if (wasActivePage) {
        console.warn("[bridge] Active ChatGPT tab closed. Recovering tab...");
        this.schedulePageRecovery();
      } else {
        console.warn("[bridge] Secondary browser tab closed.");
      }
    });
  }

  async ensureKeeperPage() {
    if (this.stopping || !this.context) return null;

    if (this.keeperPage && !this.keeperPage.isClosed()) {
      return this.keeperPage;
    }

    const keeper = await this.context.newPage();
    this.keeperPage = keeper;
    this.configurePage(keeper);

    await keeper.goto("about:blank").catch(() => {});
    return keeper;
  }

  schedulePageRecovery() {
    if (this.stopping || this.pageRecoveryTimer) return;

    this.pageRecoveryTimer = setTimeout(async () => {
      this.pageRecoveryTimer = null;
      if (this.stopping || this.page) return;

      const context = this.context;
      if (!context) {
        this.scheduleBrowserRecovery();
        return;
      }

      try {
        const pages = context.pages().filter((page) => !page.isClosed());
        const existing =
          pages.find((page) => page.url().startsWith("https://chatgpt.com")) ||
          pages[0];

        const recoveredPage = existing || await context.newPage();
        this.configurePage(recoveredPage);
        this.page = recoveredPage;

        const recoveryUrl = this.lastConversationUrl || CHATGPT_URL;
        if (!recoveredPage.url().startsWith("https://chatgpt.com")) {
          await recoveredPage.goto(recoveryUrl, { waitUntil: "domcontentloaded" });
        }

        console.log("[bridge] ChatGPT tab recovered without restarting Chromium.");
      } catch (error) {
        console.warn("[bridge] Tab recovery failed:", error.message);
        this.context = null;
        this.page = null;
        this.scheduleBrowserRecovery();
      }
    }, 500);
  }

  scheduleBrowserRecovery() {
    if (this.stopping || this.relaunchTimer) return;

    this.relaunchTimer = setTimeout(() => {
      this.relaunchTimer = null;

      this.start().catch((error) => {
        console.error("Could not automatically recover ChatGPT browser:", error.message);
        this.scheduleBrowserRecovery();
      });
    }, 1200);
  }

  async start() {
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = (async () => {
      this.stopping = false;

      if (this.context) {
        try {
          const pages = this.context.pages().filter((page) => !page.isClosed());

          if (!this.keeperPage || this.keeperPage.isClosed()) {
            const blankPage = pages.find((page) => page.url() === "about:blank" && page !== this.page);
            if (blankPage) {
              this.keeperPage = blankPage;
              this.configurePage(blankPage);
            } else {
              await this.ensureKeeperPage();
            }
          }

          if (!this.page || this.page.isClosed()) {
            this.page =
              pages.find((page) =>
                page !== this.keeperPage &&
                page.url().startsWith("https://chatgpt.com")
              ) ||
              await this.context.newPage();

            this.configurePage(this.page);
          }

          if (this.page && !this.page.isClosed()) {
            return;
          }
        } catch {
          this.context = null;
          this.page = null;
        }
      }

      let lastError = null;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const context = await chromium.launchPersistentContext(this.profileDir, {
            headless: this.headless,
            acceptDownloads: true,
            viewport: { width: 1440, height: 980 },
            args: ["--disable-blink-features=AutomationControlled"]
          });

          this.context = context;

          context.on("page", (page) => {
            this.configurePage(page);
          });

          context.on("close", () => {
            if (this.context === context) {
              this.context = null;
              this.page = null;
              this.keeperPage = null;
            }

            if (this.pageRecoveryTimer) {
              clearTimeout(this.pageRecoveryTimer);
              this.pageRecoveryTimer = null;
            }

            if (!this.stopping) {
              console.warn("[bridge] Chromium context closed. Relaunching...");
              this.scheduleBrowserRecovery();
            }
          });

          for (const existingPage of context.pages()) {
            this.configurePage(existingPage);
          }

          const pages = context.pages().filter((page) => !page.isClosed());
          const initialBlank = pages.find((page) => page.url() === "about:blank");

          if (initialBlank) {
            this.keeperPage = initialBlank;
            this.configurePage(initialBlank);
          } else {
            await this.ensureKeeperPage();
          }

          this.page =
            pages.find((page) =>
              page !== this.keeperPage &&
              page.url().startsWith("https://chatgpt.com")
            ) ||
            await context.newPage();

          this.configurePage(this.page);

          if (!this.page.url().startsWith("https://chatgpt.com")) {
            await this.page.goto(
              this.lastConversationUrl || CHATGPT_URL,
              { waitUntil: "domcontentloaded" }
            );
          }

          await this.page.bringToFront().catch(() => {});
          return;
        } catch (error) {
          lastError = error;
          this.context = null;
          this.page = null;

          if (attempt < 3) {
            await sleep(1200);
          }
        }
      }

      throw lastError || new Error("Could not start ChatGPT browser.");
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop() {
    this.stopping = true;

    if (this.relaunchTimer) {
      clearTimeout(this.relaunchTimer);
      this.relaunchTimer = null;
    }

    if (this.pageRecoveryTimer) {
      clearTimeout(this.pageRecoveryTimer);
      this.pageRecoveryTimer = null;
    }

    const context = this.context;
    this.context = null;
    this.page = null;
    this.keeperPage = null;

    await context?.close().catch(() => {});
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
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="Mensagem"]'
    ];

    const tryFind = async (totalTimeout) => {
      const perSelector = Math.max(700, Math.floor(totalTimeout / selectors.length));

      for (const selector of selectors) {
        const locator = this.page.locator(selector).first();
        try {
          await locator.waitFor({ state: "visible", timeout: perSelector });

          if (this.isConversationPage()) {
            this.lastConversationUrl = this.page.url();
          }

          return locator;
        } catch {}
      }

      return null;
    };

    let composer = await tryFind(timeout);
    if (composer) return composer;

    // File previews/modals can temporarily hide the composer. Close overlays first.
    await this.page.keyboard.press("Escape").catch(() => {});
    await sleep(300);
    await this.page.keyboard.press("Escape").catch(() => {});
    await sleep(500);

    composer = await tryFind(4000);
    if (composer) return composer;

    // If an earlier file click navigated away from the chat, restore the last known chat.
    const recoveryUrl = this.lastConversationUrl || CHATGPT_URL;
    if (this.page.url() !== recoveryUrl) {
      await this.page.goto(recoveryUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(700);
      composer = await tryFind(6000);
      if (composer) return composer;
    }

    throw new Error(
      "ChatGPT composer not found after automatic recovery. Open the browser window and confirm the ChatGPT chat is available."
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

  extensionFromMime(mimeType = "") {
    const map = {
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
      "audio/mp4": "m4a",
      "audio/x-m4a": "m4a",
      "audio/ogg": "ogg",
      "audio/webm": "webm",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
      "application/pdf": "pdf",
      "text/plain": "txt",
      "application/json": "json"
    };

    return map[String(mimeType || "").toLowerCase()] || "bin";
  }

  decodeAttachmentData(value, mimeHint = null) {
    if (!value || typeof value !== "string") return null;

    const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    let mimeType = mimeHint || null;
    let encoded = value;

    if (dataUrl) {
      mimeType = dataUrl[1] || mimeType;
      encoded = dataUrl[3] || "";
      if (!dataUrl[2]) {
        return {
          mimeType: mimeType || "application/octet-stream",
          buffer: Buffer.from(decodeURIComponent(encoded), "utf8")
        };
      }
    }

    const normalized = encoded.replace(/\s+/g, "");
    if (!normalized) return null;

    try {
      return {
        mimeType: mimeType || "application/octet-stream",
        buffer: Buffer.from(normalized, "base64")
      };
    } catch {
      return null;
    }
  }

  attachmentFromPart(part, index = 0) {
    if (!part || typeof part !== "object") return null;

    if (part.type === "input_audio" || part.type === "audio") {
      const audio = part.input_audio || part.audio || part;
      const format = String(audio.format || "wav").replace(/^\./, "").toLowerCase();
      const mimeByFormat = {
        wav: "audio/wav",
        mp3: "audio/mpeg",
        m4a: "audio/mp4",
        mp4: "audio/mp4",
        ogg: "audio/ogg",
        webm: "audio/webm"
      };
      const decoded = this.decodeAttachmentData(
        audio.data || audio.base64 || audio.url,
        audio.mime_type || audio.mimeType || mimeByFormat[format] || "audio/wav"
      );
      if (!decoded) return null;

      return {
        name: audio.filename || audio.name || `audio-${index + 1}.${format}`,
        mimeType: decoded.mimeType,
        buffer: decoded.buffer,
        kind: "audio"
      };
    }

    if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
      const image = part.image_url || part.image || part;
      const value = typeof image === "string"
        ? image
        : (image.url || image.data || image.base64 || part.image_url);

      if (typeof value !== "string" || !value.startsWith("data:")) {
        return null;
      }

      const decoded = this.decodeAttachmentData(
        value,
        image.mime_type || image.mimeType || "image/png"
      );
      if (!decoded) return null;

      const extension = this.extensionFromMime(decoded.mimeType);
      return {
        name: image.filename || image.name || `image-${index + 1}.${extension}`,
        mimeType: decoded.mimeType,
        buffer: decoded.buffer,
        kind: "image"
      };
    }

    if (
      part.type === "file" ||
      part.type === "input_file" ||
      part.type === "attachment"
    ) {
      const file = part.file || part.input_file || part.attachment || part;
      const decoded = this.decodeAttachmentData(
        file.data || file.base64 || file.file_data || file.url,
        file.mime_type || file.mimeType || "application/octet-stream"
      );
      if (!decoded) return null;

      const extension = this.extensionFromMime(decoded.mimeType);
      return {
        name: file.filename || file.name || `file-${index + 1}.${extension}`,
        mimeType: decoded.mimeType,
        buffer: decoded.buffer,
        kind: "file"
      };
    }

    return null;
  }

  messageAttachments(message) {
    if (!message) return [];

    const candidates = [];

    if (Array.isArray(message.content)) {
      candidates.push(...message.content);
    }

    if (Array.isArray(message.attachments)) {
      candidates.push(...message.attachments.map((attachment) => ({
        type: "attachment",
        attachment
      })));
    }

    return candidates
      .map((part, index) => this.attachmentFromPart(part, index))
      .filter(Boolean);
  }

  latestMessageAttachments(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const attachments = this.messageAttachments(messages[index]);
      if (attachments.length) return attachments;
    }

    return [];
  }

  defaultAttachmentPrompt(attachments = []) {
    const kinds = new Set(attachments.map((attachment) => attachment.kind));

    if (kinds.has("audio")) {
      return "Ouça o áudio anexado. Se ele contiver uma instrução ou comando, execute-o; caso contrário, responda normalmente ao conteúdo do áudio.";
    }

    if (kinds.has("image")) {
      return "Use a imagem anexada como entrada do usuário e responda ao conteúdo dela.";
    }

    return "Use o arquivo anexado como entrada do usuário e responda ao conteúdo dele.";
  }

  async attachFiles(attachments = []) {
    if (!attachments.length) return;

    const page = this.page;
    if (!page || page.isClosed()) {
      throw new Error("ChatGPT page is not available for file upload.");
    }

    const payloads = attachments.map((attachment) => ({
      name: attachment.name,
      mimeType: attachment.mimeType || "application/octet-stream",
      buffer: attachment.buffer
    }));

    const tryInputs = async () => {
      const inputs = page.locator('input[type="file"]');
      const count = await inputs.count();

      for (let index = count - 1; index >= 0; index -= 1) {
        try {
          await inputs.nth(index).setInputFiles(payloads, { timeout: 5000 });
          return true;
        } catch {}
      }

      return false;
    };

    if (await tryInputs()) {
      await sleep(1200);
      return;
    }

    const attachSelectors = [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="attach"]',
      'button[aria-label*="Anexar"]',
      'button[aria-label*="Adicionar"]',
      'button[aria-label*="Upload"]'
    ];

    for (const selector of attachSelectors) {
      const button = page.locator(selector).first();
      if (!await button.isVisible().catch(() => false)) continue;

      await button.click().catch(() => {});
      await sleep(500);

      if (await tryInputs()) {
        await sleep(1200);
        return;
      }
    }

    throw new Error("Could not find ChatGPT file upload control for the supplied attachment.");
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
      .find((message) =>
        this.messageText(message).trim() ||
        this.messageAttachments(message).length
      );

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

  fileIdFromUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get("id") || (
        parsed.href.match(/file_[a-zA-Z0-9]+/)?.[0] ?? null
      );
    } catch {
      return String(url || "").match(/file_[a-zA-Z0-9]+/)?.[0] ?? null;
    }
  }

  mimeTypeFromName(name = "", url = "", hint = "") {
    const full = `${name} ${url} ${hint}`.toLowerCase();

    if (/\.png(?:\?|$)/.test(full)) return "image/png";
    if (/\.jpe?g(?:\?|$)/.test(full)) return "image/jpeg";
    if (/\.gif(?:\?|$)/.test(full)) return "image/gif";
    if (/\.webp(?:\?|$)/.test(full)) return "image/webp";
    if (/\.svg(?:\?|$)/.test(full)) return "image/svg+xml";
    if (/\.bmp(?:\?|$)/.test(full)) return "image/bmp";

    if (/\.mp4(?:\?|$)/.test(full)) return "video/mp4";
    if (/\.webm(?:\?|$)/.test(full)) return "video/webm";
    if (/\.mov(?:\?|$)/.test(full)) return "video/quicktime";
    if (/\.mkv(?:\?|$)/.test(full)) return "video/x-matroska";
    if (/\.avi(?:\?|$)/.test(full)) return "video/x-msvideo";

    if (/\.zip(?:\?|$)/.test(full)) return "application/zip";
    if (/\.rar(?:\?|$)/.test(full)) return "application/vnd.rar";
    if (/\.7z(?:\?|$)/.test(full)) return "application/x-7z-compressed";
    if (/\.pdf(?:\?|$)/.test(full)) return "application/pdf";
    if (/\.json(?:\?|$)/.test(full)) return "application/json";
    if (/\.csv(?:\?|$)/.test(full)) return "text/csv";
    if (/\.txt(?:\?|$)/.test(full)) return "text/plain";
    if (/\.html?(?:\?|$)/.test(full)) return "text/html";
    if (/\.css(?:\?|$)/.test(full)) return "text/css";
    if (/\.m?js(?:\?|$)/.test(full)) return "text/javascript";
    if (/\.py(?:\?|$)/.test(full)) return "text/x-python";
    if (/\.bat(?:\?|$)/.test(full)) return "text/x-msdos-batch";
    if (/\.xlsx?(?:\?|$)/.test(full)) {
      return full.includes(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.ms-excel";
    }
    if (/\.docx(?:\?|$)/.test(full)) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (/\.doc(?:\?|$)/.test(full)) return "application/msword";
    if (/\.pptx(?:\?|$)/.test(full)) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }

    if (hint === "pdf") return "application/pdf";
    if (hint === "text") return "text/plain";
    if (hint === "html") return "text/html";
    if (hint === "xls") return "application/vnd.ms-excel";
    if (hint === "code") return "text/plain";

    return null;
  }

  kindFromMime(mimeType, name = "", hint = "") {
    if (mimeType?.startsWith("image/")) return "image";
    if (mimeType?.startsWith("video/")) return "video";
    if (mimeType === "application/zip" || mimeType === "application/vnd.rar" || mimeType === "application/x-7z-compressed") {
      return "archive";
    }
    if (mimeType === "application/pdf" || /\.(docx?|xlsx?|pptx?)$/i.test(name)) return "document";
    if (mimeType?.startsWith("text/") || hint === "code" || /\.(py|js|mjs|html?|css|json|bat)$/i.test(name)) {
      return "code";
    }
    return "file";
  }

  candidateFromUrl(url, meta = {}) {
    if (!url) return null;

    const fileId = meta.file_id || this.fileIdFromUrl(url);
    const name = meta.name || fileId || null;
    const mimeType = meta.mime_type || this.mimeTypeFromName(name || "", url, meta.icon_key || "");
    const kind = meta.kind || this.kindFromMime(mimeType, name || "", meta.icon_key || "");

    return {
      name,
      mime_type: mimeType,
      kind,
      file_id: fileId,
      url,
      ...(meta.source ? { source: meta.source } : {})
    };
  }

  mergeFiles(...groups) {
    const result = [];
    const seen = new Map();

    const urlScore = (url, kind) => {
      const value = String(url || "").toLowerCase();
      if (!value) return 0;
      if (value.includes("/backend-api/estuary/content")) {
        return kind === "image" || kind === "video" ? 100 : 85;
      }
      if (value.includes("/backend-api/files/download/file_")) return 95;
      if (value.includes("/backend-api/files/file_")) return 60;
      if (value.includes("oaiusercontent.com")) return 80;
      return 10;
    };

    const richness = (file) => [
      file.url ? 1 : 0,
      file.file_id ? 1 : 0,
      file.name ? 1 : 0,
      file.mime_type ? 1 : 0,
      file.kind && file.kind !== "file" ? 1 : 0
    ].reduce((sum, value) => sum + value, 0);

    const normalize = (raw) => {
      if (!raw) return null;

      if (raw.url) return this.candidateFromUrl(raw.url, raw);

      const mimeType = raw.mime_type || this.mimeTypeFromName(
        raw.name || "",
        "",
        raw.icon_key || ""
      );

      return {
        name: raw.name || null,
        mime_type: mimeType,
        kind: raw.kind || this.kindFromMime(
          mimeType,
          raw.name || "",
          raw.icon_key || ""
        ),
        file_id: raw.file_id || null,
        url: null,
        ...(raw.source ? { source: raw.source } : {})
      };
    };

    const mergePair = (existing, incoming) => {
      const existingUrlScore = urlScore(existing.url, existing.kind);
      const incomingUrlScore = urlScore(incoming.url, incoming.kind);
      const bestUrl = incomingUrlScore > existingUrlScore
        ? incoming.url
        : (existing.url || incoming.url);

      const bestSource = incomingUrlScore > existingUrlScore
        ? incoming.source
        : (existing.source || incoming.source);

      const preferredKind =
        existing.kind && existing.kind !== "file"
          ? existing.kind
          : incoming.kind;

      const preferredMime =
        existing.mime_type && existing.mime_type !== "application/json"
          ? existing.mime_type
          : incoming.mime_type;

      const better = richness(incoming) > richness(existing) ? incoming : existing;
      const other = better === incoming ? existing : incoming;

      return {
        ...other,
        ...better,
        name: (
          existing.name && !/^file_[a-z0-9]+$/i.test(existing.name)
            ? existing.name
            : null
        ) || (
          incoming.name && !/^file_[a-z0-9]+$/i.test(incoming.name)
            ? incoming.name
            : null
        ) || existing.name || incoming.name || null,
        mime_type: preferredMime || existing.mime_type || incoming.mime_type || null,
        kind: preferredKind || existing.kind || incoming.kind || "file",
        file_id: existing.file_id || incoming.file_id || null,
        url: bestUrl || null,
        ...(bestSource ? { source: bestSource } : {})
      };
    };

    for (const group of groups) {
      for (const raw of Array.isArray(group) ? group : []) {
        const file = normalize(raw);
        if (!file) continue;

        // Prefer file_id as the identity so estuary/download/simple URLs for the same file
        // collapse into one API entry.
        const key = file.file_id
          ? `id:${file.file_id}`
          : file.url
            ? `url:${file.url}`
            : file.name
              ? `name:${String(file.name).toLowerCase()}`
              : null;

        if (!key) continue;

        const existingIndex = seen.get(key);
        if (existingIndex === undefined) {
          seen.set(key, result.length);
          result.push(file);
        } else {
          result[existingIndex] = mergePair(result[existingIndex], file);
        }
      }
    }

    // If a metadata-only artifact has the same name as a linked result, keep the linked one.
    const linkedNames = new Set(
      result
        .filter((file) => file.url && file.name)
        .map((file) => String(file.name).toLowerCase())
    );

    return result.filter((file) =>
      file.url || !file.name || !linkedNames.has(String(file.name).toLowerCase())
    );
  }

  isLikelyFileUrl(url) {
    const value = String(url || "").toLowerCase();

    // Keep only URLs that look like ChatGPT-generated/user files. Do not treat normal
    // application assets (.js, .css, favicon, sentinel frames, etc.) as generated files.
    return value.includes("/backend-api/estuary/content") ||
      value.includes("/backend-api/files/download/file_") ||
      value.includes("/backend-api/files/file_") ||
      (value.includes("oaiusercontent.com") && /\.(png|jpe?g|gif|webp|mp4|webm|mov|zip|rar|7z|pdf|txt|csv|json|html?|css|m?js|py|bat|xlsx?|docx?|pptx?)(?:\?|$)/i.test(value));
  }

  async snapshotMediaUrls() {
    return new Set(await this.page.locator("img[src], video[src], source[src]").evaluateAll((elements) =>
      elements
        .map((el) => el.src || el.getAttribute("src"))
        .filter(Boolean)
    ).catch(() => []));
  }

  assistantTurnLocator() {
    // Current ChatGPT image/file responses are rendered at the conversation-turn level and may
    // not contain a nested data-message-author-role="assistant" element.
    return this.page.locator(
      '[data-testid^="conversation-turn-"][data-turn="assistant"]'
    );
  }

  createNetworkCapture() {
    const captured = new Map();
    const capturePage = this.page;

    if (!capturePage || capturePage.isClosed()) {
      throw new Error("ChatGPT page closed before network capture could start.");
    }

    const add = (url, meta = {}, force = false) => {
      if (!url || (!force && !this.isLikelyFileUrl(url))) return;

      const current = captured.get(url) || {};
      captured.set(url, {
        ...current,
        ...meta,
        url,
        name: meta.name || current.name || null,
        mime_type: meta.mime_type || current.mime_type || null,
        source: meta.source || current.source || "network"
      });
    };

    const onRequest = (request) => {
      add(request.url(), {
        source: "network-request",
        resource_type: request.resourceType()
      });
    };

    const onResponse = async (response) => {
      try {
        const headers = await response.allHeaders();
        const contentType = headers["content-type"]?.split(";")[0]?.trim() || null;
        const disposition = headers["content-disposition"] || "";
        const filenameMatch =
          /filename\*=UTF-8''([^;]+)/i.exec(disposition) ||
          /filename="?([^";]+)"?/i.exec(disposition);

        const filename = filenameMatch
          ? decodeURIComponent(filenameMatch[1])
          : null;

        add(response.url(), {
          source: "network-response",
          mime_type: contentType,
          name: filename
        }, /attachment/i.test(disposition));
      } catch {}
    };

    capturePage.on("request", onRequest);
    capturePage.on("response", onResponse);

    return {
      files: () => [...captured.values()].map((entry) => this.candidateFromUrl(entry.url, entry)),
      urls: () => new Set(captured.keys()),
      stop: () => {
        try {
          capturePage.off("request", onRequest);
          capturePage.off("response", onResponse);
        } catch {}
      }
    };
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

      const files = [];
      const seen = new Set();

      for (const el of node.querySelectorAll("a[href], img[src], video[src], source[src]")) {
        const rawUrl = el.href || el.src || el.getAttribute("href") || el.getAttribute("src");
        const url = absoluteUrl(rawUrl);
        if (!url) continue;

        const interesting =
          url.includes("/backend-api/estuary/content") ||
          url.includes("file_") ||
          url.startsWith("blob:");

        if (!interesting || seen.has(url)) continue;
        seen.add(url);

        const name =
          el.getAttribute("download") ||
          el.getAttribute("data-filename") ||
          el.getAttribute("alt") ||
          el.getAttribute("aria-label") ||
          null;

        const tagName = el.tagName.toLowerCase();
        files.push({
          name,
          url,
          kind: tagName === "img"
            ? "image"
            : (tagName === "video" || tagName === "source" ? "video" : undefined),
          mime_type: tagName === "img"
            ? "image/*"
            : (tagName === "video" || tagName === "source" ? "video/*" : undefined),
          source: "assistant-dom"
        });
      }

      const artifacts = [...node.querySelectorAll('[class*="group/artifact-row"]')].map((row) => {
        const buttons = [...row.querySelectorAll("button[aria-label]")];
        const openButton = buttons.find((button) => {
          const label = (button.getAttribute("aria-label") || "").trim();
          return label && !/^(baixar arquivo|download file)$/i.test(label);
        });

        const icon = row.querySelector("[data-library-file-icon-key]");
        const name = openButton?.getAttribute("aria-label")?.trim() || null;

        return {
          name,
          icon_key: icon?.getAttribute("data-library-file-icon-key") || null,
          icon_kind: icon?.getAttribute("data-library-file-icon-kind") || null,
          source: "artifact-row"
        };
      });

      const markdownText = [...node.querySelectorAll(".markdown")]
        .map((el) => (el.innerText || "").trim())
        .filter(Boolean)
        .join("\n")
        .trim();

      const assistantMessage = node.querySelector('[data-message-author-role="assistant"]');
      const fallbackText = assistantMessage
        ? [...assistantMessage.querySelectorAll(".markdown")]
            .map((el) => (el.innerText || "").trim())
            .filter(Boolean)
            .join("\n")
            .trim()
        : "";

      return {
        text: markdownText || fallbackText,
        files,
        artifacts
      };
    });
  }

  async collectGlobalMediaFiles(beforeMediaUrls) {
    const items = await this.page.locator("img[src], video[src], source[src]").evaluateAll((elements) =>
      elements.map((el) => ({
        tag: el.tagName.toLowerCase(),
        url: el.src || el.getAttribute("src"),
        name: el.getAttribute("alt") || el.getAttribute("aria-label") || null
      }))
    ).catch(() => []);

    return items
      .filter((item) => item.url && !beforeMediaUrls.has(item.url) && this.isLikelyFileUrl(item.url))
      .map((item) => this.candidateFromUrl(item.url, {
        name: item.name,
        kind: item.tag === "img" ? "image" : item.tag === "video" || item.tag === "source" ? "video" : undefined,
        source: "global-media-dom"
      }));
  }

  artifactFilesFromMetadata(artifacts = []) {
    return artifacts
      .filter((artifact) => artifact?.name)
      .map((artifact) => ({
        name: artifact.name,
        mime_type: this.mimeTypeFromName(artifact.name, "", artifact.icon_key || ""),
        kind: this.kindFromMime(
          this.mimeTypeFromName(artifact.name, "", artifact.icon_key || ""),
          artifact.name,
          artifact.icon_key || ""
        ),
        file_id: null,
        url: null,
        source: artifact.source || "artifact-row"
      }));
  }

  async clickDownloadLikeButtons(turnLocator, networkCapture) {
    const buttons = turnLocator.locator("button");
    const count = Math.min(await buttons.count(), 30);
    const discovered = [];
    const clickedLabels = new Set();

    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);

      const info = await button.evaluate((el) => {
        const text = (el.textContent || "").trim();
        const aria = (el.getAttribute("aria-label") || "").trim();
        const artifactRow = el.closest('[class*="group/artifact-row"]');
        const artifactName = artifactRow
          ? [...artifactRow.querySelectorAll("button[aria-label]")]
              .map((candidate) => (candidate.getAttribute("aria-label") || "").trim())
              .find((candidate) => candidate && !/^(baixar arquivo|download file)$/i.test(candidate)) || null
          : null;

        return {
          text,
          aria,
          inArtifactRow: Boolean(artifactRow),
          artifactName
        };
      }).catch(() => null);

      if (!info) continue;

      const label = info.aria || info.text;
      const clickKey = `${index}:${info.artifactName || ""}:${label}`;
      if (!label || clickedLabels.has(clickKey)) continue;

      // Only click the real artifact download control. Generic text buttons such as
      // "Baixar o teste.pdf" can open ChatGPT's preview panel instead of downloading.
      const isArtifactDownload =
        info.inArtifactRow &&
        /^(baixar arquivo|download file)$/i.test(info.aria || "");

      if (!isArtifactDownload) continue;

      clickedLabels.add(clickKey);

      const beforeUrls = networkCapture.urls();
      const actionPage = this.page;

      if (!actionPage || actionPage.isClosed()) {
        break;
      }

      const returnUrl = this.isConversationPage()
        ? actionPage.url()
        : this.lastConversationUrl;

      const downloadPromise = actionPage
        .waitForEvent("download", { timeout: 12000 })
        .catch(() => null);

      let clicked = false;

      try {
        await button.click({ timeout: 2500 });
        clicked = true;
      } catch {
        // Some artifact rows remain in the DOM while visually collapsed/hidden.
        // Dispatching the DOM click still invokes ChatGPT's download handler.
        try {
          await button.evaluate((el) => el.click());
          clicked = true;
        } catch {}
      }

      if (!clicked) continue;

      const download = await downloadPromise;
      await sleep(1200);

      if (download) {
        try {
          const downloadUrl = download.url();
          const suggestedName = download.suggestedFilename();

          if (downloadUrl && /^https?:/i.test(downloadUrl)) {
            const resolvedName = suggestedName || info.artifactName || null;
            const resolvedMime = this.mimeTypeFromName(
              resolvedName || "",
              downloadUrl
            );

            discovered.push(this.candidateFromUrl(downloadUrl, {
              name: resolvedName,
              mime_type: resolvedMime,
              kind: this.kindFromMime(
                resolvedMime,
                resolvedName || ""
              ),
              source: "playwright-download"
            }));
          }
        } catch {}

        // Do not cancel the Playwright download here. Cancelling a browser-managed
        // attachment after reading download.url() can race with Chromium's download
        // lifecycle on Windows. Playwright cleans temporary downloads with the context.
      }

      const afterFiles = networkCapture.files();
      const newFiles = afterFiles.filter((file) => file.url && !beforeUrls.has(file.url));

      const currentPage = this.page;
      if (
        returnUrl &&
        currentPage &&
        !currentPage.isClosed() &&
        currentPage.url() !== returnUrl
      ) {
        await currentPage.goto(returnUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await sleep(500);
      }

      for (const file of newFiles) {
        const cleanedLabel = label
          .replace(/^(baixar|download)\s+/i, "")
          .replace(/^(o|a)\s+/i, "")
          .trim();

        discovered.push({
          ...file,
          name: file.name || info.artifactName || cleanedLabel || null,
          source: "download-button"
        });
      }
    }

    return discovered;
  }

  async collectTurnResult(turnLocator, beforeMediaUrls, networkCapture, { clickDownloads = false } = {}) {
    const direct = await this.extractAssistantTurnData(turnLocator).catch(() => ({
      text: "",
      files: [],
      artifacts: []
    }));

    const globalMedia = await this.collectGlobalMediaFiles(beforeMediaUrls);
    const artifactFiles = this.artifactFilesFromMetadata(direct.artifacts);

    const preliminaryFiles = this.mergeFiles(
      direct.files,
      globalMedia,
      networkCapture.files(),
      artifactFiles
    );

    const linkedFiles = preliminaryFiles.filter((file) => file?.url);
    const artifactCount = artifactFiles.length;

    let clickedFiles = [];
    const needsDownloadClicks =
      clickDownloads &&
      (
        linkedFiles.length === 0 ||
        (artifactCount > 0 && linkedFiles.length < artifactCount)
      );

    if (needsDownloadClicks) {
      clickedFiles = await this.clickDownloadLikeButtons(turnLocator, networkCapture);
      await sleep(500);
    }

    const files = this.mergeFiles(
      preliminaryFiles,
      clickedFiles,
      networkCapture.files()
    );

    return {
      text: String(direct.text || "").trim(),
      files
    };
  }

  async sendPrompt(prompt, attachments = []) {
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

    const beforeAssistantCount = await this.assistantTurnLocator().count();
    const beforeMediaUrls = await this.snapshotMediaUrls();
    const networkCapture = this.createNetworkCapture();

    try {
      const composer = await this.findComposer();

      if (this.isConversationPage()) {
        this.lastConversationUrl = this.page.url();
      }

      if (attachments.length) {
        await this.attachFiles(attachments);
      }

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

        const assistantMessages = this.assistantTurnLocator();
        const count = await assistantMessages.count();

        if (count > beforeAssistantCount) {
          const latest = assistantMessages.nth(count - 1);

          const result = await this.collectTurnResult(
            latest,
            beforeMediaUrls,
            networkCapture
          );

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

          if ((lastResult.text || lastResult.files.length) && !stopVisible && Date.now() - stableSince > 1800) {
            // Give late-rendered image/file cards a brief chance to attach to the completed turn.
            await sleep(900);

            const finalResult = await this.collectTurnResult(
              latest,
              beforeMediaUrls,
              networkCapture,
              { clickDownloads: true }
            );

            return {
              text: finalResult.text || lastResult.text,
              files: this.mergeFiles(lastResult.files, finalResult.files)
            };
          }
        }

        await sleep(350);
      }

      if (lastResult.text || lastResult.files.length) {
        const assistantMessages = this.assistantTurnLocator();
        const count = await assistantMessages.count();

        if (count > beforeAssistantCount) {
          const latest = assistantMessages.nth(count - 1);
          const finalResult = await this.collectTurnResult(
            latest,
            beforeMediaUrls,
            networkCapture,
            { clickDownloads: true }
          );

          return {
            text: finalResult.text || lastResult.text,
            files: this.mergeFiles(lastResult.files, finalResult.files)
          };
        }

        return lastResult;
      }

      throw new Error("Timed out waiting for a ChatGPT response.");
    } finally {
      networkCapture.stop();
    }
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
      const attachments = this.latestMessageAttachments(messages);
      const rawPrompt = shouldSendFullContext
        ? this.buildPrompt(messages)
        : this.buildLatestPrompt(messages);
      const prompt = rawPrompt.trim()
        ? rawPrompt
        : this.defaultAttachmentPrompt(attachments);

      if (!prompt.trim() && !attachments.length) {
        throw new Error("No text or attachment input was provided.");
      }

      if (!shouldSendFullContext) {
        this.recordMessage("user", prompt);
      }

      try {
        const result = await this.sendPrompt(prompt, attachments);
        this.recordMessage("assistant", this.assistantResultToHistoryText(result));
        return result;
      } catch (error) {
        if (error?.code !== "conversation_limit" || !autoRollover) {
          throw error;
        }

        this.rollovers += 1;
        await this.newChat();

        const rolloverPrompt = this.buildRolloverPrompt(messages);
        const result = await this.sendPrompt(rolloverPrompt, attachments);
        this.recordMessage("assistant", this.assistantResultToHistoryText(result));
        return result;
      }
    };

    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
