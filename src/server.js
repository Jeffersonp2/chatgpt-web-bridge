import express from "express";
import { ChatGPTWebSession } from "./browser.js";

const app = express();

const PORT = Number(process.env.PORT || 4310);
const HOST = process.env.HOST || "127.0.0.1";

app.use(express.json({ limit: "25mb" }));

const chatgpt = new ChatGPTWebSession({
  profileDir: process.env.CHATGPT_PROFILE_DIR || ".data/chatgpt-profile",
  headless: String(process.env.CHATGPT_HEADLESS || "false").toLowerCase() === "true",
  timeoutMs: process.env.REQUEST_TIMEOUT_MS || 180000
});

const id = () => `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
const unix = () => Math.floor(Date.now() / 1000);

app.get("/", (_req, res) => {
  res.json({
    name: "testeGPT Local Bridge",
    version: "0.1.0",
    api: `http://${HOST}:${PORT}/v1`
  });
});

app.get("/health", async (_req, res) => {
  try {
    const status = await chatgpt.getStatus();
    res.json({ ok: true, chatgpt: status });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get("/login", async (_req, res) => {
  try {
    await chatgpt.start();
    res.json({
      ok: true,
      message: "Browser opened. Sign in to ChatGPT there; the local profile will be reused."
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "chatgpt-web",
        object: "model",
        created: 0,
        owned_by: "local"
      }
    ]
  });
});

app.post("/v1/conversation/new", async (_req, res) => {
  try {
    await chatgpt.start();
    await chatgpt.newChat();
    res.json({
      ok: true,
      message: "A new normal ChatGPT conversation is ready."
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = body.model || "chatgpt-web";

  if (!messages.length) {
    return res.status(400).json({
      error: { message: "messages must be a non-empty array", type: "invalid_request_error" }
    });
  }

  try {
    const output = await chatgpt.complete(messages, {
      newChat: body.new_chat === true
    });

    const completionId = id();

    if (body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: unix(),
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }]
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: unix(),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    res.json({
      id: completionId,
      object: "chat.completion",
      created: unix(),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: output },
          finish_reason: "stop"
        }
      ],
      usage: null
    });
  } catch (error) {
    const status = error?.code === "not_authenticated" ? 401 : 502;
    const type = error?.code === "not_authenticated"
      ? "authentication_error"
      : "chatgpt_web_error";

    res.status(status).json({
      error: {
        message: error.message,
        type
      }
    });
  }
});

app.post("/v1/responses", async (req, res) => {
  const body = req.body || {};
  const input = body.input;
  const messages = Array.isArray(input)
    ? input
    : [{ role: "user", content: typeof input === "string" ? input : JSON.stringify(input ?? "") }];

  try {
    const output = await chatgpt.complete(messages, { newChat: body.new_chat === true });
    res.json({
      id: `resp_${crypto.randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: unix(),
      status: "completed",
      model: body.model || "chatgpt-web",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: output }]
        }
      ],
      output_text: output
    });
  } catch (error) {
    const status = error?.code === "not_authenticated" ? 401 : 502;
    const type = error?.code === "not_authenticated"
      ? "authentication_error"
      : "chatgpt_web_error";

    res.status(status).json({ error: { message: error.message, type } });
  }
});

app.post("/v1/images/generations", (_req, res) => {
  res.status(501).json({
    error: {
      type: "not_implemented",
      message: "Image generation through the ChatGPT Web adapter is planned but not implemented yet."
    }
  });
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`testeGPT listening on http://${HOST}:${PORT}`);
  console.log(`Open http://${HOST}:${PORT}/login once to authenticate ChatGPT.`);
});

const shutdown = async () => {
  server.close();
  await chatgpt.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
