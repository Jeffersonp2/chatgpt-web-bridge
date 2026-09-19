import fs from "node:fs";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { WebSocket, WebSocketServer } from "ws";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rawToBuffer = (data) => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part)));
  return Buffer.from(data);
};

export class RemoteLoginManager {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.display = String(options.display || ":99");
    this.rfbPort = Number(options.rfbPort || 5900);
    this.width = Number(options.width || 1440);
    this.height = Number(options.height || 900);
    this.depth = Number(options.depth || 24);
    this.wsPath = String(options.wsPath || "/dashboard/vnc");
    this.useExistingDisplay = options.useExistingDisplay === true;

    this.xvfbProcess = null;
    this.vncProcess = null;
    this.wss = null;
    this.lastError = null;
    this.ready = false;
    this.startedAt = null;
    this.ownsDisplay = false;
  }

  commandExists(command) {
    const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore"
    });
    return result.status === 0;
  }

  displaySocketPath() {
    const match = /^:(\d+)$/.exec(this.display);
    return match ? `/tmp/.X11-unix/X${match[1]}` : null;
  }

  displayAlreadyExists() {
    const socketPath = this.displaySocketPath();
    return Boolean(socketPath && fs.existsSync(socketPath));
  }

  status() {
    return {
      enabled: this.enabled,
      supported: process.platform === "linux",
      ready: this.ready,
      display: this.display,
      rfb_port: this.rfbPort,
      websocket_path: this.wsPath,
      size: `${this.width}x${this.height}x${this.depth}`,
      owns_display: this.ownsDisplay,
      started_at: this.startedAt,
      error: this.lastError
    };
  }

  markProcessFailure(name, code, signal) {
    if (!this.ready) return;
    this.ready = false;
    this.lastError =
      `${name} exited unexpectedly` +
      (code != null ? ` with code ${code}` : "") +
      (signal ? ` (signal ${signal})` : "");
    console.warn(`[remote-login] ${this.lastError}`);
  }

  async ensureDisplay() {
    if (!this.enabled) return this.status();

    if (process.platform !== "linux") {
      this.lastError = "Remote dashboard login currently requires Linux.";
      return this.status();
    }

    const missing = ["Xvfb", "x11vnc"].filter((command) => !this.commandExists(command));
    if (missing.length) {
      this.lastError =
        `Missing system package(s): ${missing.join(", ")}. ` +
        "Run: npm run install:remote-login";
      return this.status();
    }

    if (this.ready) {
      process.env.DISPLAY = this.display;
      return this.status();
    }

    this.lastError = null;

    const existingDisplay = this.displayAlreadyExists();
    if (existingDisplay && !this.useExistingDisplay) {
      this.lastError =
        `Display ${this.display} is already in use. Set REMOTE_LOGIN_USE_EXISTING_DISPLAY=true ` +
        "or choose another REMOTE_LOGIN_DISPLAY.";
      return this.status();
    }

    if (!existingDisplay) {
      this.xvfbProcess = spawn(
        "Xvfb",
        [
          this.display,
          "-screen",
          "0",
          `${this.width}x${this.height}x${this.depth}`,
          "-nolisten",
          "tcp",
          "-ac"
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          env: process.env
        }
      );

      this.ownsDisplay = true;

      let xvfbError = "";
      this.xvfbProcess.stderr?.on("data", (chunk) => {
        xvfbError += chunk.toString();
        if (xvfbError.length > 4000) xvfbError = xvfbError.slice(-4000);
      });

      this.xvfbProcess.on("exit", (code, signal) => {
        if (this.xvfbProcess) {
          this.markProcessFailure("Xvfb", code, signal);
        }
      });

      await sleep(700);

      if (this.xvfbProcess.exitCode != null) {
        this.lastError =
          `Xvfb could not start on ${this.display}. ${xvfbError.trim()}`.trim();
        this.xvfbProcess = null;
        this.ownsDisplay = false;
        return this.status();
      }
    } else {
      this.ownsDisplay = false;
    }

    process.env.DISPLAY = this.display;

    this.vncProcess = spawn(
      "x11vnc",
      [
        "-display",
        this.display,
        "-localhost",
        "-forever",
        "-shared",
        "-rfbport",
        String(this.rfbPort),
        "-nopw",
        "-noxdamage"
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          DISPLAY: this.display
        }
      }
    );

    let vncError = "";
    this.vncProcess.stderr?.on("data", (chunk) => {
      vncError += chunk.toString();
      if (vncError.length > 4000) vncError = vncError.slice(-4000);
    });

    this.vncProcess.on("exit", (code, signal) => {
      if (this.vncProcess) {
        this.markProcessFailure("x11vnc", code, signal);
      }
    });

    await sleep(700);

    if (this.vncProcess.exitCode != null) {
      this.lastError =
        `x11vnc could not attach to ${this.display}. ${vncError.trim()}`.trim();
      this.vncProcess = null;
      await this.stopDisplayOnly();
      return this.status();
    }

    this.ready = true;
    this.startedAt = new Date().toISOString();
    console.log(
      `[remote-login] Virtual display ready on ${this.display}; VNC is local-only on 127.0.0.1:${this.rfbPort}.`
    );

    return this.status();
  }

  installWebSocketProxy(server, { isAuthorized } = {}) {
    if (this.wss) return this.wss;

    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has("binary")) return "binary";
        const first = protocols.values().next();
        return first.done ? false : first.value;
      }
    });

    server.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(req.url || "/", "http://localhost").pathname;
      } catch {}

      if (pathname !== this.wsPath) return;

      const authorized =
        typeof isAuthorized === "function" ? isAuthorized(req) : true;

      if (!authorized) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!this.enabled || !this.ready) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });

    this.wss.on("connection", (ws) => {
      const upstream = net.createConnection({
        host: "127.0.0.1",
        port: this.rfbPort
      });

      ws.on("message", (data) => {
        if (!upstream.destroyed) {
          upstream.write(rawToBuffer(data));
        }
      });

      upstream.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(chunk, { binary: true });
        }
      });

      upstream.on("error", () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "VNC upstream error");
        }
      });

      upstream.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000);
        }
      });

      ws.on("close", () => {
        upstream.destroy();
      });

      ws.on("error", () => {
        upstream.destroy();
      });
    });

    return this.wss;
  }

  async stopDisplayOnly() {
    const vnc = this.vncProcess;
    this.vncProcess = null;
    if (vnc && vnc.exitCode == null) {
      vnc.kill("SIGTERM");
    }

    const xvfb = this.xvfbProcess;
    this.xvfbProcess = null;
    if (this.ownsDisplay && xvfb && xvfb.exitCode == null) {
      xvfb.kill("SIGTERM");
    }

    this.ownsDisplay = false;
  }

  async stop() {
    this.ready = false;
    this.startedAt = null;

    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close(1001, "Server shutting down");
        } catch {}
      }
      this.wss.close();
      this.wss = null;
    }

    await this.stopDisplayOnly();
  }
}
