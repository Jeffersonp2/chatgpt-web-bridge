import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ChatGPTWebSession } from "./browser.js";
import { RemoteLoginManager } from "./remote-login.js";
import { downloadRemoteAttachment } from "./remote-attachment.js";

const app = express();

const ENV_FILE = path.resolve(process.env.ENV_FILE || ".env");
const DASHBOARD_DOCS_FILE = fileURLToPath(new URL("../docs/dashboard.html", import.meta.url));

const ENV_SETTINGS = [
  { key: "PORT", label: "Porta HTTP", type: "number", default: "4310", group: "Servidor", min: 1, max: 65535 },
  { key: "HOST", label: "Host / interface", type: "text", default: "127.0.0.1", group: "Servidor" },
  { key: "JSON_LIMIT", label: "Limite JSON", type: "text", default: "50mb", group: "Servidor" },
  { key: "LOCAL_API_KEY", label: "Chave local da API", type: "secret", default: "", group: "Segurança" },
  { key: "CORS_ORIGIN", label: "Origem CORS", type: "text", default: "", group: "Segurança" },
  { key: "DASHBOARD_TOKEN", label: "Token do dashboard", type: "secret", default: "", group: "Segurança" },

  { key: "CHATGPT_PROFILE_DIR", label: "Diretório do perfil ChatGPT", type: "text", default: ".data/chatgpt-profile", group: "ChatGPT" },
  { key: "CHATGPT_HEADLESS", label: "Forçar headless real", type: "boolean", default: "false", group: "ChatGPT" },
  { key: "CHATGPT_BROWSER_CHANNEL", label: "Canal do navegador (chrome/chromium)", type: "text", default: "", group: "ChatGPT" },
  { key: "REQUEST_TIMEOUT_MS", label: "Timeout da resposta (ms)", type: "number", default: "600000", group: "ChatGPT", min: 1000 },
  { key: "STREAM_POLL_MS", label: "Intervalo dos deltas da UI (ms)", type: "number", default: "200", group: "ChatGPT", min: 100, max: 1000 },
  { key: "REMOTE_BROWSER_CONTROL_ENABLED", label: "Controle pelo dashboard", type: "boolean", default: "true", group: "ChatGPT" },
  { key: "REMOTE_BROWSER_HIDDEN", label: "Ocultar janela do navegador", type: "boolean", default: "false", group: "ChatGPT" },

  { key: "MAX_UPLOAD_MB", label: "Upload máximo (MB)", type: "number", default: "40", group: "Arquivos", min: 1 },
  { key: "MAX_REMOTE_FILE_BYTES", label: "Arquivo remoto máximo (bytes)", type: "number", default: "26214400", group: "Arquivos", min: 1 },
  { key: "REMOTE_FETCH_TIMEOUT_MS", label: "Timeout de URL remota (ms)", type: "number", default: "30000", group: "Arquivos", min: 1000 },
  { key: "ALLOW_REMOTE_URL_INPUT", label: "Permitir entrada por URL", type: "boolean", default: "true", group: "Arquivos" },

  { key: "HISTORY_MAX_RECENT_MESSAGES", label: "Mensagens recentes", type: "number", default: "60", group: "Histórico", min: 2 },
  { key: "HISTORY_MAX_RECENT_CHARS", label: "Caracteres recentes", type: "number", default: "80000", group: "Histórico", min: 1000 },
  { key: "HISTORY_MESSAGE_CLIP_CHARS", label: "Máximo por mensagem compactada", type: "number", default: "1600", group: "Histórico", min: 100 },
  { key: "HISTORY_SUMMARY_MAX_CHARS", label: "Resumo acumulado máximo", type: "number", default: "50000", group: "Histórico", min: 1000 },

  { key: "REMOTE_LOGIN_ENABLED", label: "Login VNC Linux", type: "boolean", default: "false", group: "Linux VNC" },
  { key: "REMOTE_LOGIN_DISPLAY", label: "Display X11", type: "text", default: ":99", group: "Linux VNC" },
  { key: "REMOTE_LOGIN_RFB_PORT", label: "Porta VNC local", type: "number", default: "5900", group: "Linux VNC", min: 1, max: 65535 },
  { key: "REMOTE_LOGIN_WIDTH", label: "Largura virtual", type: "number", default: "1440", group: "Linux VNC", min: 320 },
  { key: "REMOTE_LOGIN_HEIGHT", label: "Altura virtual", type: "number", default: "900", group: "Linux VNC", min: 240 },
  { key: "REMOTE_LOGIN_USE_EXISTING_DISPLAY", label: "Reutilizar display existente", type: "boolean", default: "false", group: "Linux VNC" }
];

const ENV_SETTING_MAP = new Map(ENV_SETTINGS.map((setting) => [setting.key, setting]));

const htmlEscape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const parseDotEnvText = (text = "") => {
  const values = {};
  const lines = String(text).split(/\r?\n/);

  for (const line of lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;

    let value = match[2] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    }

    values[match[1]] = value;
  }

  return { values, lines };
};

const readDotEnv = async () => {
  try {
    const text = await fs.readFile(ENV_FILE, "utf8");
    return { exists: true, text, ...parseDotEnvText(text) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, text: "", values: {}, lines: [] };
    }
    throw error;
  }
};

const encodeEnvValue = (value) => {
  const text = String(value ?? "").replace(/[\r\n]+/g, "");
  if (!text) return "";
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(text)) return text;
  return JSON.stringify(text);
};

const writeDotEnvUpdates = async (updates) => {
  const current = await readDotEnv();
  const pending = new Map(Object.entries(updates));
  const output = [];

  for (const line of current.lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];

    if (key && pending.has(key)) {
      output.push(`${key}=${encodeEnvValue(pending.get(key))}`);
      pending.delete(key);
    } else {
      output.push(line);
    }
  }

  if (output.length && output[output.length - 1] !== "") {
    output.push("");
  }

  for (const [key, value] of pending) {
    output.push(`${key}=${encodeEnvValue(value)}`);
  }

  await fs.writeFile(
    ENV_FILE,
    output.join("\n").replace(/\n*$/, "\n"),
    "utf8"
  );
};

const validateEnvUpdates = (updates, existingValues = {}) => {
  const errors = [];

  for (const [key, value] of Object.entries(updates)) {
    const setting = ENV_SETTING_MAP.get(key);
    if (!setting) continue;

    if (setting.type === "boolean" && !["true", "false"].includes(String(value))) {
      errors.push(`${key}: use true ou false`);
    }

    if (setting.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors.push(`${key}: valor numérico inválido`);
      } else {
        if (setting.min != null && number < setting.min) {
          errors.push(`${key}: mínimo ${setting.min}`);
        }
        if (setting.max != null && number > setting.max) {
          errors.push(`${key}: máximo ${setting.max}`);
        }
      }
    }
  }

  const futureHost = String(
    updates.HOST ?? existingValues.HOST ?? process.env.HOST ?? "127.0.0.1"
  ).trim();

  const futureDashboardToken = String(
    updates.DASHBOARD_TOKEN ??
    existingValues.DASHBOARD_TOKEN ??
    process.env.DASHBOARD_TOKEN ??
    ""
  ).trim();
  const futureApiKey = String(
    updates.LOCAL_API_KEY ??
    existingValues.LOCAL_API_KEY ??
    process.env.LOCAL_API_KEY ??
    ""
  ).trim();

  if (!futureHost) {
    errors.push("HOST não pode ficar vazio.");
  }

  if (
    !["127.0.0.1", "::1", "localhost"].includes(futureHost.toLowerCase()) &&
    !futureDashboardToken
  ) {
    errors.push(
      "DASHBOARD_TOKEN é obrigatório quando HOST expõe o dashboard fora do loopback."
    );
  }
  if (
    !["127.0.0.1", "::1", "localhost"].includes(futureHost.toLowerCase()) &&
    !futureApiKey
  ) {
    errors.push("LOCAL_API_KEY é obrigatória quando HOST expõe a API fora do loopback.");
  }

  const futureProfileDir = String(
    updates.CHATGPT_PROFILE_DIR ??
    existingValues.CHATGPT_PROFILE_DIR ??
    process.env.CHATGPT_PROFILE_DIR ??
    ".data/chatgpt-profile"
  ).trim();

  if (!futureProfileDir) {
    errors.push("CHATGPT_PROFILE_DIR não pode ficar vazio.");
  }

  return errors;
};

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";
const JSON_LIMIT = process.env.JSON_LIMIT || "50mb";
const LOCAL_API_KEY = String(process.env.LOCAL_API_KEY || "");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 40);
const MAX_REMOTE_FILE_BYTES = Number(process.env.MAX_REMOTE_FILE_BYTES || 25 * 1024 * 1024);
const REMOTE_FETCH_TIMEOUT_MS = Number(process.env.REMOTE_FETCH_TIMEOUT_MS || 30000);
const ALLOW_REMOTE_URL_INPUT = String(process.env.ALLOW_REMOTE_URL_INPUT || "true").toLowerCase() !== "false";
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || "").trim();
const DASHBOARD_TOKEN = String(process.env.DASHBOARD_TOKEN || "").trim();
const REMOTE_LOGIN_ENABLED =
  String(process.env.REMOTE_LOGIN_ENABLED || "false").toLowerCase() === "true";
const REMOTE_LOGIN_ACTIVE = REMOTE_LOGIN_ENABLED && process.platform === "linux";
const REMOTE_BROWSER_CONTROL_ENABLED =
  String(process.env.REMOTE_BROWSER_CONTROL_ENABLED || "true").toLowerCase() !== "false";
const REMOTE_BROWSER_HIDDEN =
  String(process.env.REMOTE_BROWSER_HIDDEN || "false").toLowerCase() === "true";
const REMOTE_LOGIN_DISPLAY = String(process.env.REMOTE_LOGIN_DISPLAY || ":99");
const REMOTE_LOGIN_RFB_PORT = Number(process.env.REMOTE_LOGIN_RFB_PORT || 5900);
const REMOTE_LOGIN_WIDTH = Number(process.env.REMOTE_LOGIN_WIDTH || 1440);
const REMOTE_LOGIN_HEIGHT = Number(process.env.REMOTE_LOGIN_HEIGHT || 900);
const REMOTE_LOGIN_USE_EXISTING_DISPLAY =
  String(process.env.REMOTE_LOGIN_USE_EXISTING_DISPLAY || "false").toLowerCase() === "true";

const require = createRequire(import.meta.url);
let NOVNC_DIR = null;
try {
  NOVNC_DIR = path.resolve(
    path.dirname(require.resolve("@novnc/novnc/core/rfb.js")),
    ".."
  );
} catch {
  try {
    NOVNC_DIR = path.dirname(require.resolve("@novnc/novnc/package.json"));
  } catch {}
}

const remoteLogin = new RemoteLoginManager({
  enabled: REMOTE_LOGIN_ACTIVE,
  display: REMOTE_LOGIN_DISPLAY,
  rfbPort: REMOTE_LOGIN_RFB_PORT,
  width: REMOTE_LOGIN_WIDTH,
  height: REMOTE_LOGIN_HEIGHT,
  useExistingDisplay: REMOTE_LOGIN_USE_EXISTING_DISPLAY,
  wsPath: "/dashboard/vnc"
});

if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-Session-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  });
}

app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 20,
    fieldSize: 50 * 1024 * 1024
  }
});

const CHATGPT_HEADLESS =
  String(process.env.CHATGPT_HEADLESS || "false").toLowerCase() === "true";
const CHATGPT_BROWSER_CHANNEL =
  String(process.env.CHATGPT_BROWSER_CHANNEL || "").trim() ||
  (process.platform === "win32" ? "chrome" : "");
const WINDOWS_HIDDEN_HEADFUL =
  process.platform === "win32" &&
  REMOTE_BROWSER_HIDDEN &&
  !CHATGPT_HEADLESS &&
  !REMOTE_LOGIN_ACTIVE;

const EFFECTIVE_CHATGPT_HEADLESS =
  REMOTE_LOGIN_ACTIVE
    ? false
    : (WINDOWS_HIDDEN_HEADFUL ? false : (REMOTE_BROWSER_HIDDEN || CHATGPT_HEADLESS));

const chatgpt = new ChatGPTWebSession({
  profileDir: process.env.CHATGPT_PROFILE_DIR || ".data/chatgpt-profile",
  headless: EFFECTIVE_CHATGPT_HEADLESS,
  hiddenWindow: WINDOWS_HIDDEN_HEADFUL,
  browserChannel: CHATGPT_BROWSER_CHANNEL,
  timeoutMs: process.env.REQUEST_TIMEOUT_MS || 600000,
  streamPollMs: process.env.STREAM_POLL_MS || 200,
  historyMaxRecentMessages: process.env.HISTORY_MAX_RECENT_MESSAGES || 60,
  historyMaxRecentChars: process.env.HISTORY_MAX_RECENT_CHARS || 80000,
  historyMessageClipChars: process.env.HISTORY_MESSAGE_CLIP_CHARS || 1600,
  historySummaryMaxChars: process.env.HISTORY_SUMMARY_MAX_CHARS || 50000
});

const sessions = new Map([["default", chatgpt]]);

const id = () => `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
const unix = () => Math.floor(Date.now() / 1000);
const bool = (value) =>
  value === true ||
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());


const isLoopbackHost = (host) =>
  ["127.0.0.1", "::1", "localhost"].includes(String(host || "").toLowerCase());


const dashboardNetworkUrls = () => {
  if (isLoopbackHost(HOST)) {
    return [`http://127.0.0.1:${PORT}/dashboard`];
  }

  if (HOST !== "0.0.0.0" && HOST !== "::") {
    return [`http://${HOST}:${PORT}/dashboard`];
  }

  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (
        entry &&
        entry.family === "IPv4" &&
        !entry.internal &&
        entry.address
      ) {
        urls.push(`http://${entry.address}:${PORT}/dashboard`);
      }
    }
  }

  return [...new Set(urls)];
};

const REMOTE_LOGIN_SECURITY_OK =
  !REMOTE_LOGIN_ACTIVE ||
  isLoopbackHost(HOST) ||
  Boolean(DASHBOARD_TOKEN);

const safeTokenEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const cookieValue = (cookieHeader, name) => {
  const pairs = String(cookieHeader || "").split(";");
  for (const pair of pairs) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (key !== name) continue;

    try {
      return decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      return pair.slice(index + 1).trim();
    }
  }
  return "";
};

const dashboardRequestAuthorized = (req) => {
  if (!DASHBOARD_TOKEN) {
    return isLoopbackHost(HOST);
  }

  const token = cookieValue(req?.headers?.cookie, "testegpt_dashboard");
  return safeTokenEqual(token, DASHBOARD_TOKEN);
};

const dashboardAuth = (req, res, next) => {
  if (!DASHBOARD_TOKEN && isLoopbackHost(HOST)) {
    return next();
  }

  if (!DASHBOARD_TOKEN) {
    return res.status(403).type("html").send(
      "<h1>Dashboard bloqueado</h1><p>Como o servidor está exposto na rede, configure <code>DASHBOARD_TOKEN</code> e reinicie.</p>"
    );
  }

  const queryToken = String(req.query?.token || "");
  if (DASHBOARD_TOKEN && safeTokenEqual(queryToken, DASHBOARD_TOKEN)) {
    const secure = req.secure ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `testegpt_dashboard=${encodeURIComponent(DASHBOARD_TOKEN)}; Path=/; HttpOnly; SameSite=Strict${secure}`
    );
    const cleanUrl = req.path || "/dashboard";
    return res.redirect(cleanUrl);
  }

  if (dashboardRequestAuthorized(req)) {
    return next();
  }

  res.status(401).type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Web Bridge Dashboard Login</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:70px auto;padding:0 20px;background:#111;color:#eee}
.card{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:22px}
input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px;border-radius:9px;border:1px solid #444}
button{cursor:pointer}
</style>
</head>
<body>
<div class="card">
<h1>ChatGPT Web Bridge Dashboard</h1>
<p>Informe o token configurado em <code>DASHBOARD_TOKEN</code>.</p>
<form method="get">
<input type="password" name="token" autocomplete="current-password" autofocus>
<button type="submit">Entrar</button>
</form>
</div>
</body>
</html>`);
};

const normalizeSessionId = (value) => {
  const raw = String(value || "default").trim() || "default";
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(raw)) {
    const error = new Error("session_id must contain only letters, numbers, dot, underscore or dash (max 64 chars).");
    error.code = "invalid_session_id";
    throw error;
  }
  return raw;
};

const requestSessionId = (req, body = {}) =>
  normalizeSessionId(body.session_id || req.get("x-session-id") || "default");

const modeFromRequest = (body = {}) => {
  if (body.mode) return String(body.mode);

  const model = String(body.model || "").toLowerCase();
  if (model.endsWith("-instant")) return "instant";
  if (model.endsWith("-thinking")) return "thinking";
  if (model.endsWith("-pro")) return "pro";
  return null;
};

const getSession = async (sessionId = "default") => {
  const normalized = normalizeSessionId(sessionId);

  if (normalized === "default") {
    await chatgpt.start();
    return chatgpt;
  }

  await chatgpt.start();

  const existing = sessions.get(normalized);
  if (existing?.isUsableWithContext(chatgpt.context)) {
    return existing;
  }

  if (existing) {
    await existing.stop().catch(() => {});
    sessions.delete(normalized);
  }

  const created = await chatgpt.createTabSession(normalized);
  sessions.set(normalized, created);
  return created;
};

const closeSession = async (sessionId) => {
  const normalized = normalizeSessionId(sessionId);
  if (normalized === "default") {
    throw new Error("The default session cannot be deleted.");
  }

  const session = sessions.get(normalized);
  if (!session) return false;

  sessions.delete(normalized);
  await session.clearConversationState().catch(() => {});
  await session.stop().catch(() => {});
  return true;
};

const apiAuth = (req, res, next) => {
  if (!LOCAL_API_KEY) {
    if (isLoopbackHost(HOST)) return next();
    return res.status(503).json({
      error: {
        message: "Set LOCAL_API_KEY before exposing /v1 outside loopback.",
        type: "configuration_error"
      }
    });
  }

  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const token = bearer || String(req.get("x-api-key") || "");

  if (!safeTokenEqual(token, LOCAL_API_KEY)) {
    return res.status(401).json({
      error: {
        message: "Invalid local API key.",
        type: "authentication_error"
      }
    });
  }

  next();
};

app.use("/v1", apiAuth);

const parseJsonField = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const normalizeIncomingBody = (req) => {
  const body = { ...(req.body || {}) };

  for (const key of ["messages", "input", "attachments"]) {
    if (key in body) body[key] = parseJsonField(body[key]);
  }

  for (const key of ["stream", "new_chat", "include_base64"]) {
    if (key in body) body[key] = bool(body[key]);
  }

  const incomingFiles = [
    ...(Array.isArray(req.files) ? req.files : []),
    ...(req.file ? [req.file] : [])
  ];

  const multipartAttachments = incomingFiles.map((file) => ({
    filename: file.originalname || file.fieldname || "upload.bin",
    mime_type: file.mimetype || "application/octet-stream",
    buffer: file.buffer
  }));

  if (multipartAttachments.length) {
    body.attachments = [
      ...(Array.isArray(body.attachments) ? body.attachments : []),
      ...multipartAttachments
    ];
  }

  return body;
};

const mergeTopLevelAttachments = (messages = [], attachments = []) => {
  if (!Array.isArray(attachments) || !attachments.length) return messages;

  const cloned = messages.map((message) => ({
    ...message,
    content: Array.isArray(message?.content)
      ? [...message.content]
      : message?.content
  }));

  let targetIndex = -1;
  for (let index = cloned.length - 1; index >= 0; index -= 1) {
    if (String(cloned[index]?.role || "") === "user") {
      targetIndex = index;
      break;
    }
  }

  if (targetIndex < 0) {
    cloned.push({ role: "user", content: [] });
    targetIndex = cloned.length - 1;
  }

  const target = cloned[targetIndex];
  const parts = Array.isArray(target.content)
    ? [...target.content]
    : (target.content == null || target.content === "")
      ? []
      : [{ type: "text", text: String(target.content) }];

  target.content = [
    ...parts,
    ...attachments.map((attachment) => ({
      type: "attachment",
      attachment
    }))
  ];

  return cloned;
};

const extensionFromMime = (mimeType = "") => {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv"
  };
  return map[String(mimeType).toLowerCase()] || "bin";
};

const remoteFilename = (url, mimeType, disposition = "") => {
  const match =
    /filename\*=UTF-8''([^;]+)/i.exec(disposition) ||
    /filename="?([^";]+)"?/i.exec(disposition);

  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  try {
    const pathname = new URL(url).pathname;
    const name = path.basename(pathname);
    if (name && name !== "/") return name;
  } catch {}

  return `remote.${extensionFromMime(mimeType)}`;
};

const fetchRemoteAttachment = async (url) => {
  if (!ALLOW_REMOTE_URL_INPUT) {
    throw new Error("Remote URL input is disabled by ALLOW_REMOTE_URL_INPUT=false.");
  }

  const response = await downloadRemoteAttachment(url, {
    maxBytes: MAX_REMOTE_FILE_BYTES,
    timeoutMs: REMOTE_FETCH_TIMEOUT_MS
  });

  const mimeType =
    String(response.headers["content-type"] || "")
      .split(";")[0]
      .trim() ||
    "application/octet-stream";

  const buffer = response.buffer;

  return {
    buffer,
    base64: buffer.toString("base64"),
    mimeType,
    filename: remoteFilename(
      response.url || url,
      mimeType,
      response.headers["content-disposition"] || ""
    )
  };
};

const resolveRemotePart = async (part) => {
  if (!part || typeof part !== "object") return part;

  if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
    const source = part.image_url || part.image || part;
    const url = typeof source === "string" ? source : source?.url;

    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const remote = await fetchRemoteAttachment(url);
      const imageObject = typeof source === "object" ? { ...source } : {};
      imageObject.url = `data:${remote.mimeType};base64,${remote.base64}`;
      imageObject.filename ||= remote.filename;
      imageObject.mime_type ||= remote.mimeType;

      return {
        ...part,
        image_url: imageObject
      };
    }

    return part;
  }

  if (part.type === "input_audio" || part.type === "audio") {
    const source = part.input_audio || part.audio || part;
    const url = source?.url;

    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const remote = await fetchRemoteAttachment(url);
      const format = extensionFromMime(remote.mimeType);

      return {
        ...part,
        input_audio: {
          ...source,
          url: undefined,
          data: remote.base64,
          format,
          filename: source.filename || remote.filename,
          mime_type: source.mime_type || remote.mimeType
        }
      };
    }

    return part;
  }

  if (["file", "input_file", "attachment"].includes(part.type)) {
    const key =
      part.type === "file"
        ? "file"
        : part.type === "input_file"
          ? "input_file"
          : "attachment";

    const source = part[key] || part;
    const url = source?.url;

    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      const remote = await fetchRemoteAttachment(url);

      return {
        ...part,
        [key]: {
          ...source,
          url: undefined,
          data: remote.base64,
          filename: source.filename || source.name || remote.filename,
          mime_type: source.mime_type || source.mimeType || remote.mimeType
        }
      };
    }
  }

  return part;
};

const resolveRemoteMessages = async (messages = []) => {
  const result = [];

  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      result.push(message);
      continue;
    }

    const content = [];
    for (const part of message.content) {
      content.push(await resolveRemotePart(part));
    }

    result.push({ ...message, content });
  }

  return result;
};

const prepareMessages = async (rawMessages, attachments = []) => {
  const messages = mergeTopLevelAttachments(
    Array.isArray(rawMessages) ? rawMessages : [],
    Array.isArray(attachments) ? attachments : []
  );
  return await resolveRemoteMessages(messages);
};

const contextualFileMessage = (files = []) => {
  if (!files.length) return "";

  const usableFiles = files.filter((file) => file?.url || file?.b64_json);
  const displayFiles = usableFiles.length ? usableFiles : files;
  const kinds = new Set(displayFiles.map((file) => file?.kind).filter(Boolean));

  let title = "Arquivo gerado com sucesso.";

  if (displayFiles.length > 1) {
    title = `${displayFiles.length} arquivos gerados com sucesso.`;
  } else if (kinds.has("image")) {
    title = "Imagem gerada com sucesso.";
  } else if (kinds.has("video")) {
    title = "Vídeo gerado com sucesso.";
  } else if (kinds.has("archive")) {
    title = "Arquivo compactado gerado com sucesso.";
  } else if (kinds.has("document")) {
    title = "Documento gerado com sucesso.";
  } else if (kinds.has("code")) {
    title = "Arquivo de código gerado com sucesso.";
  }

  const first = displayFiles[0];
  const name = first?.name ? `\nArquivo: ${first.name}` : "";
  const url = first?.url ? `\nURL: ${first.url}` : "";

  return title + name + url;
};

const maybeBase64Files = async (session, files, body) => {
  if (!bool(body.include_base64) && String(body.response_format || "") !== "b64_json") {
    return files;
  }
  return await session.filesWithBase64(files);
};

const errorShape = (error) => {
  const authentication = error?.code === "not_authenticated";
  const invalid =
    error?.code === "invalid_session_id" ||
    error?.code === "model_unavailable";

  return {
    status: authentication ? 401 : invalid ? 400 : 502,
    payload: {
      error: {
        message: error?.message || "Unknown bridge error.",
        type: authentication
          ? "authentication_error"
          : invalid
            ? "invalid_request_error"
            : "chatgpt_web_error"
      }
    }
  };
};

const sseChunk = (res, payload) => {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const sseEvent = (res, eventName, payload) => {
  res.write(
    `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
  );
};

const startSseHeartbeat = (res, intervalMs = 10000) => {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      // Valid SSE comment. Keeps proxies/routers from treating a quiet
      // reasoning period as a stalled stream, without creating a client event.
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {}
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
};

app.get("/", (_req, res) => {
  res.json({
    name: "ChatGPT Web Bridge",
    version: "0.2.0",
    api: `http://${HOST}:${PORT}/v1`,
    dashboard: `http://${HOST}:${PORT}/dashboard`
  });
});

app.get("/health", dashboardAuth, async (_req, res) => {
  try {
    const status = await chatgpt.getStatus();
    res.json({
      ok: true,
      chatgpt: status,
      sessions: {
        count: sessions.size,
        ids: [...sessions.keys()]
      },
      features: {
        multipart: true,
        remote_url_input: ALLOW_REMOTE_URL_INPUT,
        base64_input: true,
        base64_output: true,
        incremental_streaming: true,
        stream_granularity: "ui-delta",
        stream_poll_ms: chatgpt.streamPollMs,
        parallel_tabs: true,
        model_modes: ["instant", "thinking", "pro"],
        local_api_key_enabled: Boolean(LOCAL_API_KEY),
        remote_dashboard_login: REMOTE_LOGIN_ACTIVE,
        remote_dashboard_login_configured: REMOTE_LOGIN_ENABLED,
        remote_browser_control: REMOTE_BROWSER_CONTROL_ENABLED,
        remote_browser_hidden: REMOTE_BROWSER_HIDDEN,
        browser_headless_effective: EFFECTIVE_CHATGPT_HEADLESS,
        browser_hidden_headful: WINDOWS_HIDDEN_HEADFUL,
        browser_channel: CHATGPT_BROWSER_CHANNEL || "playwright-chromium"
      },
      remote_login: {
        ...remoteLogin.status(),
        security_ok: REMOTE_LOGIN_SECURITY_OK,
        novnc_available: Boolean(NOVNC_DIR)
      }
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

if (NOVNC_DIR) {
  app.use("/novnc", dashboardAuth, express.static(NOVNC_DIR));
}

app.get("/dashboard", dashboardAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Web Bridge Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
.card{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:18px;margin:14px 0}
.ok{color:#65d48a}.bad{color:#ff7b7b}.muted{color:#aaa}
code,pre{background:#090909;border-radius:8px;padding:10px;overflow:auto}
a.button{display:inline-block;padding:11px 16px;border-radius:9px;background:#eee;color:#111;text-decoration:none;font-weight:650;margin-right:8px}
</style>
</head>
<body>
<h1>ChatGPT Web Bridge</h1>
<div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0">
  <a class="button" href="/dashboard/settings">⚙ Configurar .env</a>
  <a class="button" href="/dashboard/browser">🖥 Chromium remoto</a>
  <a class="button" href="/dashboard/docs">📚 Endpoints e integrações</a>
</div>
<div class="card"><strong>API:</strong> http://127.0.0.1:${PORT}/v1</div>
<div class="card">
  <h2>Configuração</h2>
  <a class="button" href="/dashboard/settings">⚙ Configurar .env</a>
  <p class="muted">Altere as configurações do servidor pelo dashboard. Mudanças são gravadas no arquivo .env e podem exigir reinício.</p>
</div>
<div class="card">
  <h2>Login remoto</h2>
  <p id="remote-summary">carregando...</p>
  <a class="button" href="/dashboard/browser">Controle pelo Playwright (Windows/Linux)</a>
  <a class="button" href="/dashboard/login">Tela VNC (Linux)</a>
  <p class="muted">No Windows use o controle pelo Playwright. Com REMOTE_BROWSER_HIDDEN=true, o Chromium não abre janela no servidor e continua visível aqui pelo dashboard.</p>
</div>
<div class="card"><h2>Status</h2><pre id="status">carregando...</pre></div>
<script>
async function refresh(){
  try{
    const [healthResponse, remoteResponse] = await Promise.all([
      fetch('/health',{cache:'no-store'}),
      fetch('/dashboard/remote-status',{cache:'no-store'})
    ]);
    const health = await healthResponse.json();
    const remote = await remoteResponse.json();
    document.getElementById('status').textContent = JSON.stringify({health, remote_login: remote}, null, 2);

    const summary = document.getElementById('remote-summary');
    if (!remote.enabled) {
      summary.textContent = 'Desativado. Configure REMOTE_LOGIN_ENABLED=true.';
      summary.className = 'bad';
    } else if (!remote.security_ok) {
      summary.textContent = 'Bloqueado por segurança: defina DASHBOARD_TOKEN antes de expor o dashboard na rede.';
      summary.className = 'bad';
    } else if (remote.ready) {
      summary.textContent = 'Pronto. Clique no botão para controlar o Chromium do servidor.';
      summary.className = 'ok';
    } else {
      summary.textContent = remote.error || 'Ainda não está pronto.';
      summary.className = 'bad';
    }
  }catch(e){
    document.getElementById('status').textContent=String(e);
  }
}
refresh(); setInterval(refresh,3000);
</script>
</body>
</html>`);
});

app.get("/dashboard/docs", dashboardAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.sendFile(DASHBOARD_DOCS_FILE);
});

app.get("/dashboard/settings", dashboardAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  try {
    const envState = await readDotEnv();
    const saved = String(req.query.saved || "") === "1";

    const groups = new Map();
    for (const setting of ENV_SETTINGS) {
      if (!groups.has(setting.group)) groups.set(setting.group, []);
      groups.get(setting.group).push(setting);
    }

    const fields = [...groups.entries()].map(([group, settings]) => {
      const controls = settings.map((setting) => {
        const fileHasValue = Object.prototype.hasOwnProperty.call(envState.values, setting.key);
        const currentValue = fileHasValue
          ? envState.values[setting.key]
          : String(process.env[setting.key] ?? setting.default ?? "");

        if (setting.type === "secret") {
          const configured = Boolean(currentValue);
          return `
            <div class="field">
              <label for="secret_${htmlEscape(setting.key)}">
                <strong>${htmlEscape(setting.label)}</strong>
                <code>${htmlEscape(setting.key)}</code>
              </label>
              <input
                id="secret_${htmlEscape(setting.key)}"
                name="secret_${htmlEscape(setting.key)}"
                type="password"
                autocomplete="new-password"
                placeholder="${configured ? "Configurado — deixe em branco para manter" : "Não configurado"}"
              >
              <label class="inline">
                <input type="checkbox" name="clear_${htmlEscape(setting.key)}" value="1">
                Limpar este valor
              </label>
            </div>`;
        }

        if (setting.type === "boolean") {
          const enabled = String(currentValue).toLowerCase() === "true";
          return `
            <div class="field">
              <label for="${htmlEscape(setting.key)}">
                <strong>${htmlEscape(setting.label)}</strong>
                <code>${htmlEscape(setting.key)}</code>
              </label>
              <div class="switch-row">
                <input type="hidden" name="${htmlEscape(setting.key)}" value="false">
                <label class="switch" for="${htmlEscape(setting.key)}">
                  <input
                    id="${htmlEscape(setting.key)}"
                    name="${htmlEscape(setting.key)}"
                    type="checkbox"
                    value="true"
                    ${enabled ? "checked" : ""}
                  >
                  <span class="slider"></span>
                </label>
                <span
                  class="switch-state"
                  data-switch-state="${htmlEscape(setting.key)}"
                >${enabled ? "Ativado" : "Desativado"}</span>
              </div>
            </div>`;
        }

        const numeric = setting.type === "number";
        const inputMode = numeric ? ' inputmode="numeric"' : "";

        return `
          <div class="field">
            <label for="${htmlEscape(setting.key)}">
              <strong>${htmlEscape(setting.label)}</strong>
              <code>${htmlEscape(setting.key)}</code>
            </label>
            <input
              id="${htmlEscape(setting.key)}"
              name="${htmlEscape(setting.key)}"
              type="text"
              value="${htmlEscape(currentValue)}"
              ${inputMode}
            >
          </div>`;
      }).join("");

      return `<section class="group"><h2>${htmlEscape(group)}</h2>${controls}</section>`;
    }).join("");

    res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Web Bridge - Configurar .env</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1050px;margin:32px auto;padding:0 20px;background:#111;color:#eee}
a{color:#eee}.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.notice{padding:14px;border-radius:10px;margin:16px 0;background:#172719;border:1px solid #315e37;color:#9de5a8}
.warning{padding:14px;border-radius:10px;margin:16px 0;background:#2a2112;border:1px solid #6a5126;color:#f2cd83}
.group{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:18px;margin:16px 0}
.field{display:grid;grid-template-columns:minmax(230px,1fr) minmax(260px,1.2fr);gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid #2b2b2b}
.field:last-child{border-bottom:0}.field label{display:flex;flex-direction:column;gap:5px}
.field label.inline{grid-column:2;display:flex;flex-direction:row;align-items:center;font-size:14px;color:#bbb}
input,button{box-sizing:border-box;width:100%;padding:10px;border-radius:8px;border:1px solid #444;background:#101010;color:#eee;font:inherit}
.inline input{width:auto}
.switch-row{display:flex;align-items:center;gap:12px;min-height:42px}
.switch{position:relative;display:inline-block!important;width:54px;height:30px;flex:none}
.switch input{opacity:0;width:0;height:0;position:absolute}
.slider{position:absolute;inset:0;background:#444;border-radius:999px;cursor:pointer;transition:.18s}
.slider:before{content:"";position:absolute;width:22px;height:22px;left:4px;top:4px;background:#fff;border-radius:50%;transition:.18s}
.switch input:checked + .slider{background:#2f9e5b}
.switch input:checked + .slider:before{transform:translateX(24px)}
.switch input:focus-visible + .slider{outline:2px solid #8ec5ff;outline-offset:2px}
.switch-state{font-weight:650;color:#aaa}
.switch input:checked ~ .slider + .switch-state{color:#7cdb9d}
.actions{position:sticky;bottom:0;background:#111e;padding:14px 0;display:flex;gap:10px}
.actions button,.actions a{width:auto;padding:11px 18px;border-radius:9px;text-decoration:none}
.actions button{background:#eee;color:#111;font-weight:700;cursor:pointer}
.actions a{background:#292929;border:1px solid #444}
code{color:#aaa;font-size:12px}
@media(max-width:700px){.field{grid-template-columns:1fr}.field label.inline{grid-column:1}.actions{flex-wrap:wrap}}
</style>
</head>
<body>
<div class="top">
  <h1>Configurar .env</h1>
  <a href="/dashboard">← Dashboard</a>
</div>
${saved ? '<div class="notice">Configuração gravada em <code>.env</code>. Reinicie o ChatGPT Web Bridge para aplicar as mudanças.</div>' : ""}
<div class="warning">
  Os valores são gravados em <code>${htmlEscape(ENV_FILE)}</code>.
  Variáveis já definidas pelo sistema operacional podem ter prioridade sobre o arquivo <code>.env</code>.
  Campos secretos nunca são exibidos em texto puro.
</div>
<form method="post" action="/dashboard/settings">
  ${fields}
  <div class="actions">
    <button type="submit">Salvar .env</button>
    <a href="/dashboard">Cancelar</a>
  </div>
</form>
<script>
document.querySelectorAll('.switch input[type="checkbox"]').forEach((input) => {
  const state = document.querySelector('[data-switch-state="' + input.id + '"]');
  const refresh = () => {
    if (!state) return;
    state.textContent = input.checked ? 'Ativado' : 'Desativado';
    state.style.color = input.checked ? '#7cdb9d' : '#aaa';
  };
  input.addEventListener('change', refresh);
  refresh();
});
</script>
</body>
</html>`);
  } catch (error) {
    res.status(500).type("html").send(
      `<h1>Erro ao carregar .env</h1><pre>${htmlEscape(error.message)}</pre>`
    );
  }
});

app.post("/dashboard/settings", dashboardAuth, async (req, res) => {
  try {
    const envState = await readDotEnv();
    const updates = {};

    for (const setting of ENV_SETTINGS) {
      if (setting.type === "secret") {
        const clearRequested = String(req.body[`clear_${setting.key}`] || "") === "1";
        const newSecret = String(req.body[`secret_${setting.key}`] || "");

        if (clearRequested) {
          updates[setting.key] = "";
        } else if (newSecret) {
          updates[setting.key] = newSecret;
        }

        continue;
      }

      if (Object.prototype.hasOwnProperty.call(req.body, setting.key)) {
        const rawValue = req.body[setting.key];
        const normalizedValue = Array.isArray(rawValue)
          ? rawValue[rawValue.length - 1]
          : rawValue;
        updates[setting.key] = String(normalizedValue ?? "").trim();
      }
    }

    const errors = validateEnvUpdates(updates, envState.values);
    if (errors.length) {
      return res.status(400).type("html").send(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configuração inválida</title></head>
<body style="font-family:system-ui;background:#111;color:#eee;max-width:850px;margin:50px auto;padding:20px">
<h1>Não foi possível salvar</h1>
<ul>${errors.map((error) => `<li>${htmlEscape(error)}</li>`).join("")}</ul>
<p><a style="color:#fff" href="/dashboard/settings">← Voltar para configurações</a></p>
</body>
</html>`);
    }

    await writeDotEnvUpdates(updates);
    res.redirect("/dashboard/settings?saved=1");
  } catch (error) {
    res.status(500).type("html").send(
      `<h1>Erro ao salvar .env</h1><pre>${htmlEscape(error.message)}</pre><p><a href="/dashboard/settings">Voltar</a></p>`
    );
  }
});

app.get("/dashboard/browser", dashboardAuth, async (_req, res) => {
  if (!REMOTE_BROWSER_CONTROL_ENABLED) {
    return res.status(503).type("html").send(
      "<h1>Controle remoto desativado</h1><p>Configure <code>REMOTE_BROWSER_CONTROL_ENABLED=true</code>.</p>"
    );
  }

  try {
    await chatgpt.openLoginIfNeeded();
  } catch {}

  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>ChatGPT Web Bridge - Controle do Chromium</title>
<style>
html,body{margin:0;min-height:100%;background:#111;color:#eee;font-family:system-ui,sans-serif}
#bar{position:sticky;top:0;z-index:20;background:#1b1b1b;border-bottom:1px solid #333;padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button,a,input{font:inherit}
button,a.btn{padding:8px 11px;border-radius:8px;border:1px solid #444;background:#292929;color:#eee;text-decoration:none;cursor:pointer}
button.active{background:#eee;color:#111}
#tabs{display:flex;gap:6px;flex-wrap:wrap;max-width:100%}
#viewer{display:flex;justify-content:center;align-items:flex-start;background:#000;min-height:60vh;overflow:auto}
#frame{display:block;max-width:100%;height:auto;cursor:crosshair;user-select:none;-webkit-user-drag:none}
#typing{display:flex;gap:8px;padding:8px;background:#181818;border-top:1px solid #333;position:sticky;bottom:0}
#text{flex:1;min-width:80px;padding:10px;border-radius:8px;border:1px solid #444;background:#111;color:#eee}
#status{margin-left:auto;color:#aaa;font-size:13px}
</style>
</head>
<body>
<div id="bar">
  <a class="btn" href="/dashboard">← Dashboard</a>
  <button id="back">←</button>
  <button id="forward">→</button>
  <button id="reload">↻</button>
  <div id="tabs"></div>
  <span id="status">carregando...</span>
</div>
<div id="viewer" tabindex="0">
  <img id="frame" alt="Chromium remoto">
</div>
<div id="typing">
  <input id="text" type="text" autocomplete="off" placeholder="Digite texto para o campo selecionado no Chromium">
  <button id="sendText">Digitar</button>
  <button id="enter">Enter</button>
  <button id="tabKey">Tab</button>
  <button id="backspace">⌫</button>
</div>
<script>
const frame = document.getElementById("frame");
const viewer = document.getElementById("viewer");
const tabs = document.getElementById("tabs");
const status = document.getElementById("status");
const text = document.getElementById("text");
let pageIndex = 0;
let lastPageCount = 0;
let stopped = false;
let frameBusy = false;

async function action(payload) {
  payload.page = pageIndex;
  const response = await fetch("/dashboard/browser/action", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || ("HTTP " + response.status));
  }
}

async function refreshState() {
  try {
    const response = await fetch("/dashboard/browser/state", {cache:"no-store"});
    const state = await response.json();
    const pages = state.pages || [];

    if (pages.length > lastPageCount && lastPageCount > 0) {
      pageIndex = pages.length - 1;
    }
    lastPageCount = pages.length;

    if (pageIndex >= pages.length) pageIndex = Math.max(0, pages.length - 1);

    tabs.innerHTML = "";
    pages.forEach((page) => {
      const button = document.createElement("button");
      button.textContent = (page.title || page.url || ("Aba " + (page.index + 1))).slice(0, 32);
      button.title = page.url || "";
      button.className = page.index === pageIndex ? "active" : "";
      button.onclick = () => {
        pageIndex = page.index;
        loadFrame(true);
        refreshState();
      };
      tabs.appendChild(button);
    });

    const selected = pages[pageIndex];
    status.textContent = selected ? selected.url : "sem página";
  } catch (error) {
    status.textContent = String(error);
  }
}

function loadFrame(force = false) {
  if ((frameBusy && !force) || stopped) return;
  frameBusy = true;
  const separator = "/dashboard/browser/frame?page=" + encodeURIComponent(pageIndex) + "&t=" + Date.now();
  frame.src = separator;
}

frame.onload = () => {
  frameBusy = false;
  setTimeout(() => loadFrame(), 350);
};

frame.onerror = () => {
  frameBusy = false;
  setTimeout(() => loadFrame(), 1000);
};

frame.addEventListener("click", async (event) => {
  if (!frame.naturalWidth || !frame.naturalHeight) return;

  const rect = frame.getBoundingClientRect();
  const x = (event.clientX - rect.left) * frame.naturalWidth / rect.width;
  const y = (event.clientY - rect.top) * frame.naturalHeight / rect.height;

  try {
    await action({type:"click", x, y});
    viewer.focus();
    setTimeout(() => loadFrame(true), 100);
  } catch (error) {
    status.textContent = String(error);
  }
});

frame.addEventListener("dblclick", async (event) => {
  if (!frame.naturalWidth || !frame.naturalHeight) return;
  const rect = frame.getBoundingClientRect();
  const x = (event.clientX - rect.left) * frame.naturalWidth / rect.width;
  const y = (event.clientY - rect.top) * frame.naturalHeight / rect.height;
  await action({type:"dblclick", x, y}).catch((e) => status.textContent = String(e));
});

viewer.addEventListener("wheel", async (event) => {
  event.preventDefault();
  await action({type:"scroll", deltaX:event.deltaX, deltaY:event.deltaY})
    .catch((e) => status.textContent = String(e));
}, {passive:false});

viewer.addEventListener("keydown", async (event) => {
  if (event.target === text) return;

  event.preventDefault();

  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");

  const special = [
    "Enter","Tab","Backspace","Delete","Escape",
    "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
    "Home","End","PageUp","PageDown"
  ];

  try {
    if (event.key.length === 1 && modifiers.length === 0) {
      await action({type:"type", text:event.key});
    } else {
      const key = [...modifiers, event.key].join("+");
      if (special.includes(event.key) || modifiers.length) {
        await action({type:"key", key});
      }
    }
  } catch (error) {
    status.textContent = String(error);
  }
});

viewer.addEventListener("paste", async (event) => {
  event.preventDefault();
  const value = event.clipboardData?.getData("text") || "";
  if (value) await action({type:"type", text:value}).catch((e) => status.textContent = String(e));
});

document.getElementById("sendText").onclick = async () => {
  const value = text.value;
  if (!value) return;
  try {
    await action({type:"type", text:value});
    text.value = "";
    viewer.focus();
  } catch (error) {
    status.textContent = String(error);
  }
};

text.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    document.getElementById("sendText").click();
  }
});

document.getElementById("enter").onclick = () => action({type:"key",key:"Enter"});
document.getElementById("tabKey").onclick = () => action({type:"key",key:"Tab"});
document.getElementById("backspace").onclick = () => action({type:"key",key:"Backspace"});
document.getElementById("back").onclick = () => action({type:"back"});
document.getElementById("forward").onclick = () => action({type:"forward"});
document.getElementById("reload").onclick = () => action({type:"reload"});

setInterval(refreshState, 900);
refreshState();
loadFrame();
</script>
</body>
</html>`);
});

app.get("/dashboard/browser/state", dashboardAuth, async (_req, res) => {
  if (!REMOTE_BROWSER_CONTROL_ENABLED) {
    return res.status(503).json({ error: "remote browser control disabled" });
  }

  try {
    res.json(await chatgpt.remoteBrowserState());
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get("/dashboard/browser/frame", dashboardAuth, async (req, res) => {
  if (!REMOTE_BROWSER_CONTROL_ENABLED) {
    return res.sendStatus(503);
  }

  try {
    const page = Number.isFinite(Number(req.query.page))
      ? Number(req.query.page)
      : null;
    const png = await chatgpt.remoteBrowserScreenshot(page);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.send(png);
  } catch (error) {
    res.status(503).type("text").send(error.message);
  }
});

app.post("/dashboard/browser/action", dashboardAuth, async (req, res) => {
  if (!REMOTE_BROWSER_CONTROL_ENABLED) {
    return res.status(503).json({ error: "remote browser control disabled" });
  }

  try {
    res.json(await chatgpt.remoteBrowserAction(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/dashboard/remote-status", dashboardAuth, (_req, res) => {
  res.json({
    ...remoteLogin.status(),
    configured: REMOTE_LOGIN_ENABLED,
    active: REMOTE_LOGIN_ACTIVE,
    security_ok: REMOTE_LOGIN_SECURITY_OK,
    novnc_available: Boolean(NOVNC_DIR)
  });
});

app.get("/dashboard/login", dashboardAuth, async (_req, res) => {
  if (!REMOTE_LOGIN_ACTIVE) {
    return res.status(503).type("html").send(
      "<h1>Login remoto desativado</h1><p>Configure REMOTE_LOGIN_ENABLED=true e reinicie o servidor.</p>"
    );
  }

  if (!REMOTE_LOGIN_SECURITY_OK) {
    return res.status(403).type("html").send(
      "<h1>Login remoto bloqueado</h1><p>Defina DASHBOARD_TOKEN antes de expor o servidor na rede.</p>"
    );
  }

  if (!NOVNC_DIR) {
    return res.status(503).type("html").send(
      "<h1>noVNC não instalado</h1><p>Execute npm install e reinicie o servidor.</p>"
    );
  }

  const remoteState = await remoteLogin.ensureDisplay();
  if (!remoteState.ready) {
    return res.status(503).type("html").send(
      `<h1>Login remoto indisponível</h1><pre>${String(remoteState.error || "erro desconhecido")}</pre><p>Em Ubuntu/Debian execute: <code>npm run install:remote-login</code></p>`
    );
  }

  try {
    await chatgpt.openLoginIfNeeded();
  } catch {}

  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChatGPT Web Bridge - Login remoto</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font-family:system-ui,sans-serif;overflow:hidden}
#bar{height:48px;box-sizing:border-box;padding:10px 14px;background:#1b1b1b;border-bottom:1px solid #333;display:flex;gap:14px;align-items:center}
#screen{width:100%;height:calc(100% - 48px);overflow:hidden;background:#000}
#status{margin-left:auto;color:#aaa}
a{color:#fff}
</style>
</head>
<body>
<div id="bar">
  <strong>Chromium do servidor</strong>
  <a href="/dashboard">← Dashboard</a>
  <span id="status">conectando...</span>
</div>
<div id="screen"></div>
<script type="module">
import RFB from "/novnc/core/rfb.js";

const status = document.getElementById("status");
const screen = document.getElementById("screen");
const scheme = location.protocol === "https:" ? "wss" : "ws";
const url = scheme + "://" + location.host + "/dashboard/vnc";
const rfb = new RFB(screen, url, { shared: true });

rfb.scaleViewport = true;
rfb.resizeSession = true;
rfb.viewOnly = false;
rfb.focusOnClick = true;

rfb.addEventListener("connect", () => {
  status.textContent = "conectado";
  status.style.color = "#65d48a";
});

rfb.addEventListener("disconnect", (event) => {
  status.textContent = event.detail.clean ? "desconectado" : "conexão perdida";
  status.style.color = "#ff7b7b";
});

rfb.addEventListener("securityfailure", () => {
  status.textContent = "falha de segurança";
  status.style.color = "#ff7b7b";
});
</script>
</body>
</html>`);
});

app.get("/dashboard/logout", dashboardAuth, (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    "testegpt_dashboard=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
  );
  res.redirect("/dashboard");
});

app.get("/login", dashboardAuth, async (_req, res) => {
  try {
    const state = await chatgpt.openLoginIfNeeded();
    res.json({
      ok: true,
      authenticated: state.authenticated,
      message: state.authenticated
        ? "ChatGPT is already authenticated."
        : "ChatGPT login window opened automatically."
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

const modelList = [
  { id: "chatgpt-web", object: "model", created: 0, owned_by: "local" },
  { id: "chatgpt-web-instant", object: "model", created: 0, owned_by: "chatgpt-web" },
  { id: "chatgpt-web-thinking", object: "model", created: 0, owned_by: "chatgpt-web" },
  { id: "chatgpt-web-pro", object: "model", created: 0, owned_by: "chatgpt-web" }
];

app.get("/v1/models", (_req, res) => {
  res.json({ object: "list", data: modelList });
});

app.get("/v1/models/:model", (req, res) => {
  const model = modelList.find((item) => item.id === req.params.model);
  if (!model) {
    return res.status(404).json({
      error: { message: "Model alias not found.", type: "invalid_request_error" }
    });
  }
  res.json(model);
});

app.get("/v1/sessions", (_req, res) => {
  res.json({
    object: "list",
    data: [...sessions.keys()].map((sessionId) => ({
      id: sessionId,
      object: "chatgpt.web.session"
    }))
  });
});

app.post("/v1/sessions", upload.none(), async (req, res) => {
  try {
    const body = normalizeIncomingBody(req);
    const sessionId = normalizeSessionId(
      body.session_id || `session_${crypto.randomUUID().slice(0, 8)}`
    );
    await getSession(sessionId);
    res.status(201).json({
      id: sessionId,
      object: "chatgpt.web.session",
      ready: true
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

app.delete("/v1/sessions/:sessionId", async (req, res) => {
  try {
    const deleted = await closeSession(req.params.sessionId);
    res.json({ ok: true, deleted });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

app.post("/v1/conversation/new", upload.none(), async (req, res) => {
  try {
    const body = normalizeIncomingBody(req);
    const sessionId = requestSessionId(req, body);
    const session = await getSession(sessionId);
    await session.newChat();

    res.json({
      ok: true,
      session_id: sessionId,
      message: "A new normal ChatGPT conversation is ready."
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

app.post("/v1/chat/completions", upload.any(), async (req, res) => {
  const body = normalizeIncomingBody(req);
  const model = body.model || "chatgpt-web";
  const completionId = id();

  try {
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    if (!rawMessages.length && !(Array.isArray(body.attachments) && body.attachments.length)) {
      return res.status(400).json({
        error: { message: "messages must be a non-empty array", type: "invalid_request_error" }
      });
    }

    const messages = await prepareMessages(rawMessages, body.attachments);
    const sessionId = requestSessionId(req, body);
    const session = await getSession(sessionId);
    const mode = modeFromRequest(body);

    if (body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-TesteGPT-Stream-Granularity", "ui-delta");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let streamedText = "";
      const stopHeartbeat = startSseHeartbeat(res);

      sseChunk(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created: unix(),
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
      });

      try {
        const result = await session.complete(messages, {
          newChat: body.new_chat === true,
          mode,
          onDelta: (delta, fullText) => {
            streamedText = fullText;
            sseChunk(res, {
              id: completionId,
              object: "chat.completion.chunk",
              created: unix(),
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            });
          }
        });

        let files = Array.isArray(result?.files) ? result.files : [];
        files = await maybeBase64Files(session, files, body);

        const baseText = String(result?.text || "").trim();
        const fileContext = contextualFileMessage(files);

        let tail = "";
        if (!streamedText) {
          tail = baseText;
        } else if (baseText.startsWith(streamedText)) {
          tail = baseText.slice(streamedText.length);
        }

        if (fileContext) {
          tail += `${tail || streamedText || baseText ? "\n\n" : ""}${fileContext}`;
        }

        if (tail) {
          sseChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created: unix(),
            model,
            choices: [{ index: 0, delta: { content: tail }, finish_reason: null }]
          });
        }

        if (files.length) {
          sseChunk(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created: unix(),
            model,
            session_id: sessionId,
            files
          });
        }

        sseChunk(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: unix(),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        stopHeartbeat();
        res.end("data: [DONE]\n\n");
      } catch (error) {
        stopHeartbeat();
        sseChunk(res, errorShape(error).payload);
        res.end("data: [DONE]\n\n");
      }
      return;
    }

    const result = await session.complete(messages, {
      newChat: body.new_chat === true,
      mode
    });

    let files = Array.isArray(result?.files) ? result.files : [];
    files = await maybeBase64Files(session, files, body);

    const baseText = String(result?.text || "").trim();
    const fileContext = contextualFileMessage(files);
    const outputText = [baseText, fileContext].filter(Boolean).join("\n\n");

    res.json({
      id: completionId,
      object: "chat.completion",
      created: unix(),
      model,
      session_id: sessionId,
      output_text: baseText,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: outputText },
          finish_reason: "stop"
        }
      ],
      files,
      url: files.find((file) => file?.url)?.url || null,
      usage: null
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

app.post("/v1/responses", upload.any(), async (req, res) => {
  const body = normalizeIncomingBody(req);

  try {
    const input = body.input;
    let rawMessages;

    if (
      Array.isArray(input) &&
      input.some((item) => item && typeof item === "object" && "role" in item)
    ) {
      rawMessages = input;
    } else if (Array.isArray(input)) {
      rawMessages = [{ role: "user", content: input }];
    } else {
      rawMessages = [{
        role: "user",
        content: typeof input === "string" ? input : JSON.stringify(input ?? "")
      }];
    }

    const messages = await prepareMessages(rawMessages, body.attachments);
    const sessionId = requestSessionId(req, body);
    const session = await getSession(sessionId);
    const mode = modeFromRequest(body);
    const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
    const model = body.model || "chatgpt-web";

    if (body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-TesteGPT-Stream-Granularity", "ui-delta");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let streamedText = "";
      const stopHeartbeat = startSseHeartbeat(res);

      let sequenceNumber = 0;
      const responseBase = {
        id: responseId,
        object: "response",
        created_at: unix(),
        status: "in_progress",
        model,
        output: []
      };

      sseEvent(res, "response.created", {
        type: "response.created",
        sequence_number: sequenceNumber++,
        response: responseBase
      });

      sseEvent(res, "response.in_progress", {
        type: "response.in_progress",
        sequence_number: sequenceNumber++,
        response: responseBase
      });

      try {
        const result = await session.complete(messages, {
          newChat: body.new_chat === true,
          mode,
          onDelta: (delta, fullText) => {
            streamedText = fullText;
            sseEvent(res, "response.output_text.delta", {
              type: "response.output_text.delta",
              sequence_number: sequenceNumber++,
              response_id: responseId,
              output_index: 0,
              content_index: 0,
              delta
            });
          }
        });

        let files = Array.isArray(result?.files) ? result.files : [];
        files = await maybeBase64Files(session, files, body);

        const baseText = String(result?.text || "").trim();
        const fileContext = contextualFileMessage(files);
        const outputText = [baseText, fileContext].filter(Boolean).join("\n\n");

        if (outputText.startsWith(streamedText) && outputText.length > streamedText.length) {
          sseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: sequenceNumber++,
            response_id: responseId,
            output_index: 0,
            content_index: 0,
            delta: outputText.slice(streamedText.length)
          });
        } else if (fileContext) {
          sseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: sequenceNumber++,
            response_id: responseId,
            output_index: 0,
            content_index: 0,
            delta: `\n\n${fileContext}`
          });
        }

        const completedResponse = {
          id: responseId,
          object: "response",
          created_at: responseBase.created_at,
          status: "completed",
          model,
          session_id: sessionId,
          output: [
            {
              id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: outputText,
                  annotations: []
                }
              ]
            }
          ],
          output_text: outputText,
          files,
          url: files.find((file) => file?.url)?.url || null
        };

        sseEvent(res, "response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: sequenceNumber++,
          response_id: responseId,
          output_index: 0,
          content_index: 0,
          text: outputText
        });

        sseEvent(res, "response.completed", {
          type: "response.completed",
          sequence_number: sequenceNumber++,
          response: completedResponse
        });
        stopHeartbeat();
        res.end();
      } catch (error) {
        stopHeartbeat();
        sseEvent(res, "error", {
          type: "error",
          sequence_number: sequenceNumber++,
          ...errorShape(error).payload
        });
        res.end();
      }
      return;
    }

    const result = await session.complete(messages, {
      newChat: body.new_chat === true,
      mode
    });

    let files = Array.isArray(result?.files) ? result.files : [];
    files = await maybeBase64Files(session, files, body);

    const baseText = String(result?.text || "").trim();
    const fileContext = contextualFileMessage(files);
    const outputText = [baseText, fileContext].filter(Boolean).join("\n\n");

    res.json({
      id: responseId,
      object: "response",
      created_at: unix(),
      status: "completed",
      model,
      session_id: sessionId,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: outputText }]
        }
      ],
      output_text: outputText,
      files,
      url: files.find((file) => file?.url)?.url || null
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

const handleAudioEndpoint = (instruction) => async (req, res) => {
  const body = normalizeIncomingBody(req);

  if (!(Array.isArray(body.attachments) && body.attachments.length)) {
    return res.status(400).json({
      error: {
        message: "A multipart audio file is required in field 'file'.",
        type: "invalid_request_error"
      }
    });
  }

  try {
    const userPrompt = String(body.prompt || "").trim();
    const prompt = userPrompt
      ? `${instruction}\n\nAdditional instruction: ${userPrompt}`
      : instruction;

    const messages = await prepareMessages(
      [{ role: "user", content: prompt }],
      body.attachments
    );

    const sessionId = requestSessionId(req, body);
    const session = await getSession(sessionId);
    const mode = modeFromRequest(body);

    const result = await session.complete(messages, {
      newChat: body.new_chat === true,
      mode
    });

    res.json({
      text: String(result?.text || "").trim(),
      session_id: sessionId,
      model: body.model || "chatgpt-web"
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
};

app.post(
  "/v1/audio/transcriptions",
  upload.single("file"),
  handleAudioEndpoint(
    "Transcribe the attached audio faithfully. Return only the transcription unless the user asks for something else."
  )
);

app.post(
  "/v1/audio/translations",
  upload.single("file"),
  handleAudioEndpoint(
    "Transcribe the attached audio and translate it to English. Return only the English translation unless the user asks for something else."
  )
);

app.post("/v1/images/generations", upload.any(), async (req, res) => {
  const body = normalizeIncomingBody(req);
  const prompt = String(body.prompt || "").trim();

  if (!prompt && !(Array.isArray(body.attachments) && body.attachments.length)) {
    return res.status(400).json({
      error: { message: "prompt or attachment is required", type: "invalid_request_error" }
    });
  }

  try {
    const messages = await prepareMessages(
      [{ role: "user", content: prompt }],
      body.attachments
    );
    const sessionId = requestSessionId(req, body);
    const session = await getSession(sessionId);
    const mode = modeFromRequest(body);

    const result = await session.complete(messages, {
      newChat: body.new_chat === true,
      mode
    });

    let files = Array.isArray(result?.files)
      ? result.files.filter((file) => file.kind === "image")
      : [];

    const wantsBase64 = String(body.response_format || "") === "b64_json" || bool(body.include_base64);
    if (wantsBase64) {
      files = await session.filesWithBase64(files);
    }

    res.json({
      created: unix(),
      session_id: sessionId,
      data: files.map((file) =>
        wantsBase64
          ? {
              b64_json: file.b64_json || null,
              file_id: file.file_id,
              name: file.name,
              mime_type: file.mime_type,
              url: file.url || null
            }
          : {
              url: file.url,
              file_id: file.file_id,
              name: file.name,
              mime_type: file.mime_type
            }
      ),
      files,
      url: files.find((file) => file?.url)?.url || null,
      text: [
        String(result?.text || "").trim(),
        contextualFileMessage(files)
      ].filter(Boolean).join("\n\n")
    });
  } catch (error) {
    const shaped = errorShape(error);
    res.status(shaped.status).json(shaped.payload);
  }
});

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      error: {
        message: error.message,
        type: "invalid_request_error",
        code: error.code
      }
    });
  }

  if (error) {
    return res.status(500).json({
      error: {
        message: error.message || "Unexpected server error.",
        type: "server_error"
      }
    });
  }

  next();
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`ChatGPT Web Bridge listening on http://${HOST}:${PORT}`);
  console.log(
    `[browser] mode: ${EFFECTIVE_CHATGPT_HEADLESS ? "headless" : WINDOWS_HIDDEN_HEADFUL ? "hidden/headful" : "visible"}; channel: ${CHATGPT_BROWSER_CHANNEL || "playwright-chromium"}`
  );

  const dashboardUrls = dashboardNetworkUrls();
  if (dashboardUrls.length) {
    for (const url of dashboardUrls) {
      console.log(`Dashboard: ${url}`);
    }
  } else {
    console.log(`Dashboard: http://${HOST}:${PORT}/dashboard`);
  }

  if (REMOTE_LOGIN_ENABLED && !REMOTE_LOGIN_ACTIVE) {
    console.warn(
      "[remote-login] REMOTE_LOGIN_ENABLED=true ignored on this platform; using Playwright dashboard control instead."
    );
  }

  if (REMOTE_LOGIN_ACTIVE) {
    if (!REMOTE_LOGIN_SECURITY_OK) {
      remoteLogin.lastError =
        "Set DASHBOARD_TOKEN before enabling remote login on a non-loopback HOST.";
      console.error("[remote-login]", remoteLogin.lastError);
      return;
    }

    const remoteState = await remoteLogin.ensureDisplay();
    if (!remoteState.ready) {
      console.error("[remote-login]", remoteState.error || "Remote login display is not ready.");
      return;
    }

    console.log(
      `[remote-login] Dashboard browser access: http://${HOST}:${PORT}/dashboard/login`
    );
  }

  try {
    const state = await chatgpt.openLoginIfNeeded();

    if (state.authenticated) {
      console.log("ChatGPT session already authenticated.");
    } else {
      console.log("ChatGPT login window opened automatically.");
    }
  } catch (error) {
    console.error("Could not open the ChatGPT login window:", error.message);
  }
});

remoteLogin.installWebSocketProxy(server, {
  isAuthorized: dashboardRequestAuthorized
});

const shutdown = async () => {
  server.close();

  const secondary = [...sessions.entries()]
    .filter(([sessionId]) => sessionId !== "default")
    .map(([, session]) => session.stop().catch(() => {}));

  await Promise.allSettled(secondary);
  await chatgpt.stop();
  await remoteLogin.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
