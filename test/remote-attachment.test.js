import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { downloadRemoteAttachment, validateRemoteUrl } from "../src/remote-attachment.js";

test("rejects direct and DNS-resolved internal destinations", async () => {
  for (const url of [
    "http://127.0.0.1/file", "http://2130706433/file",
    "http://[::1]/file", "http://169.254.169.254/file",
    "http://[64:ff9b::a9fe:a9fe]/file"
  ]) {
    await assert.rejects(validateRemoteUrl(url), /private or reserved/);
  }
  await assert.rejects(
    validateRemoteUrl("https://files.example/file", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 }
    ]),
    /private or reserved/
  );
});

test("allows a public URL and stops a chunked response at the byte limit", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/small") return res.end("hello");
    res.write("12345");
    res.end("67890");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const options = {
    maxBytes: 6,
    timeoutMs: 2000,
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    requestUrl: (_url, requestOptions, callback) =>
      http.get(`http://127.0.0.1:${port}${_url.pathname}`, {
        signal: requestOptions.signal
      }, callback)
  };
  const result = await downloadRemoteAttachment("http://files.example/small", options);
  assert.equal(result.buffer.toString(), "hello");
  await assert.rejects(
    downloadRemoteAttachment("http://files.example/large", options),
    /exceeds the 6 byte limit/
  );
});

test("validates redirected destinations before requesting them", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1/private" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  let requests = 0;
  await assert.rejects(downloadRemoteAttachment("http://files.example/start", {
    maxBytes: 100,
    timeoutMs: 2000,
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    requestUrl: (_url, options, callback) => {
      requests++;
      return http.get(`http://127.0.0.1:${server.address().port}/`, {
        signal: options.signal
      }, callback);
    }
  }), /private or reserved/);
  assert.equal(requests, 1);
});

test("timeout also covers DNS resolution", async () => {
  await assert.rejects(downloadRemoteAttachment("https://files.example/file", {
    maxBytes: 100,
    timeoutMs: 20,
    resolve: () => new Promise((resolve) => setTimeout(() => resolve([
      { address: "8.8.8.8", family: 4 }
    ]), 100))
  }), /timeout|aborted/i);
});
