import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import { ChatGPTWebSession } from "./browser.js";

const app = express();

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";
const JSON_LIMIT = process.env.JSON_LIMIT || "50mb";
const LOCAL_API_KEY = String(process.env.LOCAL_API_KEY || "");
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 40);
const MAX_REMOTE_FILE_BYTES = Number(process.env.MAX_REMOTE_FILE_BYTES || 25 * 1024 * 1024);
const REMOTE_FETCH_TIMEOUT_MS = Number(process.env.REMOTE_FETCH_TIMEOUT_MS || 30000);
const ALLOW_REMOTE_URL_INPUT = String(process.env.ALLOW_REMOTE_URL_INPUT || "true").toLowerCase() !== "false";
const CORS_ORIGIN = String(process.env.CORS_ORIGIN || "").trim();

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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_MB * 1024 * 1024,
    files: 20,
    fieldSize: 50 * 1024 * 1024
  }
});

const chatgpt = new ChatGPTWebSession({
  profileDir: process.env.CHATGPT_PROFILE_DIR || ".data/chatgpt-profile",
  headless: String(process.env.CHATGPT_HEADLESS || "false").toLowerCase() === "true",
  timeoutMs: process.env.REQUEST_TIMEOUT_MS || 180000
});

const sessions = new Map([["default", chatgpt]]);

const id = () => `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
const unix = () => Math.floor(Date.now() / 1000);
const bool = (value) =>
  value === true ||
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

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
  await session.stop().catch(() => {});
  return true;
};

const apiAuth = (req, res, next) => {
  if (!LOCAL_API_KEY) return next();

  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const token = bearer || String(req.get("x-api-key") || "");

  if (token !== LOCAL_API_KEY) {
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

  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// attachment URLs are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Attachment URLs containing embedded credentials are not supported.");
  }

  const response = await fetch(parsed, {
    redirect: "follow",
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Could not fetch attachment URL: HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > MAX_REMOTE_FILE_BYTES) {
    throw new Error(`Remote attachment exceeds the ${MAX_REMOTE_FILE_BYTES} byte limit.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_REMOTE_FILE_BYTES) {
    throw new Error(`Remote attachment exceeds the ${MAX_REMOTE_FILE_BYTES} byte limit.`);
  }

  const mimeType =
    String(response.headers.get("content-type") || "")
      .split(";")[0]
      .trim() ||
    "application/octet-stream";

  const buffer = Buffer.from(arrayBuffer);

  return {
    buffer,
    base64: buffer.toString("base64"),
    mimeType,
    filename: remoteFilename(
      response.url || url,
      mimeType,
      response.headers.get("content-disposition") || ""
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

app.get("/", (_req, res) => {
  res.json({
    name: "testeGPT Local Bridge",
    version: "0.2.0",
    api: `http://${HOST}:${PORT}/v1`,
    dashboard: `http://${HOST}:${PORT}/dashboard`
  });
});

app.get("/health", async (_req, res) => {
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
        parallel_tabs: true,
        model_modes: ["instant", "thinking", "pro"],
        local_api_key_enabled: Boolean(LOCAL_API_KEY)
      }
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/dashboard", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>testeGPT Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;max-width:980px;margin:40px auto;padding:0 20px;background:#111;color:#eee}
.card{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:18px;margin:14px 0}
.ok{color:#65d48a}.bad{color:#ff7b7b}code,pre{background:#090909;border-radius:8px;padding:10px;overflow:auto}
</style>
</head>
<body>
<h1>testeGPT Local Bridge</h1>
<div class="card"><strong>API:</strong> http://127.0.0.1:${PORT}/v1</div>
<div class="card"><h2>Status</h2><pre id="status">carregando...</pre></div>
<script>
async function refresh(){
  try{
    const r=await fetch('/health',{cache:'no-store'});
    const j=await r.json();
    document.getElementById('status').textContent=JSON.stringify(j,null,2);
  }catch(e){
    document.getElementById('status').textContent=String(e);
  }
}
refresh(); setInterval(refresh,3000);
</script>
</body>
</html>`);
});

app.get("/login", async (_req, res) => {
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
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let streamedText = "";

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
        res.end("data: [DONE]\n\n");
      } catch (error) {
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
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let streamedText = "";

      sseChunk(res, {
        type: "response.created",
        response: { id: responseId, object: "response", status: "in_progress", model }
      });

      try {
        const result = await session.complete(messages, {
          newChat: body.new_chat === true,
          mode,
          onDelta: (delta, fullText) => {
            streamedText = fullText;
            sseChunk(res, {
              type: "response.output_text.delta",
              response_id: responseId,
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
          sseChunk(res, {
            type: "response.output_text.delta",
            response_id: responseId,
            delta: outputText.slice(streamedText.length)
          });
        } else if (fileContext) {
          sseChunk(res, {
            type: "response.output_text.delta",
            response_id: responseId,
            delta: `\n\n${fileContext}`
          });
        }

        sseChunk(res, {
          type: "response.completed",
          response: {
            id: responseId,
            object: "response",
            status: "completed",
            model,
            session_id: sessionId,
            output_text: outputText,
            files,
            url: files.find((file) => file?.url)?.url || null
          }
        });
        res.end();
      } catch (error) {
        sseChunk(res, { type: "error", ...errorShape(error).payload });
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
  console.log(`testeGPT listening on http://${HOST}:${PORT}`);
  console.log(`Dashboard: http://${HOST}:${PORT}/dashboard`);

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

const shutdown = async () => {
  server.close();

  const secondary = [...sessions.entries()]
    .filter(([sessionId]) => sessionId !== "default")
    .map(([, session]) => session.stop().catch(() => {}));

  await Promise.allSettled(secondary);
  await chatgpt.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
