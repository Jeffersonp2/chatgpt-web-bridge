import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = JSON.parse(fs.readFileSync(new URL("../examples/n8n-whatsapp-evolution.json", import.meta.url)));
const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
const runCode = (name, input, extra = {}) => {
  const source = byName.get(name).parameters.jsCode;
  const fn = new Function("$input", "$", source);
  return fn({ first: () => ({ json: input }) }, (nodeName) => ({ first: () => ({ json: extra[nodeName] }) }));
};

test("Evolution workflow has valid connections and compiled Code nodes", () => {
  assert.equal(workflow.active, false);
  assert.equal(byName.size, workflow.nodes.length);
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(byName.has(source));
    for (const branch of outputs.main) for (const edge of branch || []) assert.ok(byName.has(edge.node));
  }
  for (const node of workflow.nodes.filter((item) => item.type === "n8n-nodes-base.code")) {
    assert.doesNotThrow(() => new Function("$input", "$", node.parameters.jsCode));
  }
});

test("normalizes Evolution text and ignores own or group messages", () => {
  const payload = { event: "messages.upsert", data: {
    key: { id: "msg1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Olá" }
  } };
  const [item] = runCode("Normalize Evolution", { body: payload });
  assert.equal(item.json.sender, "5511999999999");
  assert.equal(item.json.sessionId, "wa_5511999999999");
  assert.equal(item.json.prompt, "Olá");
  assert.deepEqual(runCode("Normalize Evolution", { body: { ...payload, data: {
    ...payload.data, key: { ...payload.data.key, fromMe: true }
  } } }), []);
  assert.deepEqual(runCode("Normalize Evolution", { body: { ...payload, data: {
    ...payload.data, key: { ...payload.data.key, remoteJid: "123@g.us" }
  } } }), []);
});

test("converts Evolution audio base64 to bridge binary upload", () => {
  const payload = { event: "messages.upsert", data: {
    key: { id: "msg2", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { audioMessage: { mimetype: "audio/ogg", base64: "data:audio/ogg;base64,aGVsbG8=" } }
  } };
  const [normalized] = runCode("Normalize Evolution", { body: payload });
  assert.match(normalized.json.prompt, /Ouça o áudio/);
  const [item] = runCode("Media Binary", normalized.json);
  assert.equal(item.binary.data.data, "aGVsbG8=");
  assert.equal(item.binary.data.mimeType, "audio/ogg");
  assert.throws(() => runCode("Media Binary", { ...normalized.json, base64: "" }), /webhookBase64/);
  const alternate = structuredClone(payload);
  delete alternate.data.message.audioMessage.base64;
  alternate.data.message.base64 = "aGVsbG8=";
  assert.equal(runCode("Normalize Evolution", { body: alternate })[0].json.base64, "aGVsbG8=");
});

test("prepares generated document for Evolution sendMedia", () => {
  const [reply] = runCode("Prepare Reply", {
    output_text: "Pronto", files: [{ name: "relatorio.pdf", mime_type: "application/pdf", b64_json: "aGVsbG8=" }]
  });
  const [file] = runCode("Generated Files", reply.json, { "Normalize Evolution": { sender: "5511999999999" } });
  assert.equal(file.json.mediatype, "document");
  assert.equal(file.json.media, "aGVsbG8=");
  assert.match(byName.get("Send Generated File").parameters.url, /message\/sendMedia/);
});
