import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright";

test("dashboard endpoint buttons send requests and show responses", async (t) => {
  const bundled = fs.existsSync(chromium.executablePath());
  const systemChrome = process.platform === "win32" &&
    fs.existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  if (!bundled && !systemChrome) return t.skip("Playwright browser not installed");

  const browser = await chromium.launch({
    headless: true,
    ...(bundled ? {} : { channel: "chrome" })
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = fs.readFileSync(new URL("../docs/dashboard.html", import.meta.url), "utf8");
  const calls = [];
  await page.route("http://dashboard.test/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/dashboard/docs") {
      return route.fulfill({ status: 200, contentType: "text/html", body: html });
    }
    calls.push({ path, method: request.method(), headers: request.headers(), body: request.postData() });
    if (path === "/v1/models") {
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"object":"list","data":[]}' });
    }
    if (path === "/v1/responses") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'event: response.completed\ndata: {"type":"response.completed"}\n\n'
      });
    }
    if (path === "/dashboard/browser/frame") {
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/MZkAAAAASUVORK5CYII=", "base64")
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"output_text":"teste OK"}' });
  });
  await page.goto("http://dashboard.test/dashboard/docs");
  const exampleCount = await page.locator("button[data-test]").count();
  assert.ok(exampleCount >= 19);
  assert.equal(await page.locator("button[data-test]").evaluateAll((buttons) =>
    buttons.filter((button) => !button.closest("tr")?.querySelector(".example-cell")?.textContent.trim()).length
  ), 0);
  await page.locator("#test-api-key").fill("local-test-key");

  await page.locator('button[data-test="models"]').click();
  await page.waitForFunction(() => document.querySelector("#test-status").textContent.includes("HTTP 200"));
  await page.waitForFunction(() => document.querySelector("#test-cancel").disabled);
  assert.match(await page.locator("#test-status").innerText(), /HTTP 200/);
  assert.match(await page.locator("#test-result").innerText(), /"object": "list"/);
  assert.equal(calls[0].path, "/v1/models");
  assert.equal(calls[0].headers["x-api-key"], "local-test-key");

  await page.locator('button[data-test="chat"]').click();
  await page.waitForFunction(() => document.querySelector("#test-result").textContent.includes("teste OK"));
  await page.waitForFunction(() => document.querySelector("#test-cancel").disabled);
  assert.match(await page.locator("#test-result").innerText(), /teste OK/);
  assert.equal(calls[1].path, "/v1/chat/completions");
  assert.equal(calls[1].method, "POST");
  const body = JSON.parse(calls[1].body);
  assert.equal(body.session_id, "dashboard-test");
  assert.equal(body.messages[0].content, "Responda apenas: teste OK");

  const previousCalls = calls.length;
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator('button[data-test="delete-session"]').click();
  assert.equal(calls.length, previousCalls);

  await page.locator('button[data-test="transcription"]').click();
  assert.match(await page.locator("#test-status").innerText(), /Selecione um arquivo de áudio/);
  assert.equal(calls.length, previousCalls);

  await page.locator("#test-stream").check();
  await page.locator('button[data-test="responses"]').click();
  await page.waitForFunction(() => document.querySelector("#test-result").textContent.includes("response.completed"));
  await page.waitForFunction(() => document.querySelector("#test-cancel").disabled);
  assert.equal(JSON.parse(calls[2].body).stream, true);

  await page.locator("#test-file").setInputFiles({
    name: "fala.ogg", mimeType: "audio/ogg", buffer: Buffer.from("audio de teste")
  });
  await page.locator('button[data-test="transcription"]').click();
  await page.waitForFunction(() => document.querySelector("#test-status").textContent.includes("HTTP 200"));
  assert.equal(calls[3].path, "/v1/audio/transcriptions");
  assert.match(calls[3].headers["content-type"], /multipart\/form-data/);
  assert.match(calls[3].body, /fala\.ogg/);

  await page.waitForFunction(() => document.querySelector("#test-cancel").disabled);
  await page.locator('button[data-test="dashboard-browser-focus"]').click();
  await page.waitForFunction(() => document.querySelector("#test-cancel").disabled);
  assert.equal(calls[4].path, "/dashboard/browser/action");
  assert.deepEqual(JSON.parse(calls[4].body), { type: "focus", page: 0 });
  assert.equal(calls[4].headers["x-api-key"], undefined);

  await page.locator('button[data-test="dashboard-browser-frame"]').click();
  await page.locator("#test-image").waitFor({ state: "visible" });
  assert.match(await page.locator("#test-result").innerText(), /Imagem PNG recebida/);
});
