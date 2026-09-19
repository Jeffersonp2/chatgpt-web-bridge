import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = JSON.parse(fs.readFileSync(new URL("../examples/n8n-whatsapp-meta.json", import.meta.url)));
const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
const runCode = (name, input, extra = {}) => {
  const source = byName.get(name).parameters.jsCode;
  const fn = new Function("$input", "$", source);
  return fn({ first: () => ({ json: input }) }, (nodeName) => ({
    first: () => ({ json: extra[nodeName] })
  }));
};

test("workflow references existing nodes and compiles its Code nodes", () => {
  assert.equal(workflow.active, false);
  assert.equal(byName.size, workflow.nodes.length);
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    assert.ok(byName.has(source));
    for (const branch of outputs.main) {
      for (const edge of branch || []) assert.ok(byName.has(edge.node));
    }
  }
  for (const node of workflow.nodes.filter((item) => item.type === "n8n-nodes-base.code")) {
    assert.doesNotThrow(() => new Function("$input", "$", node.parameters.jsCode));
  }
});

test("normalizes a WhatsApp voice message for multipart upload", () => {
  const [item] = runCode("Normalize", {
    messages: [{ id: "wamid.123", from: "+55 (11) 99999-9999", type: "audio", audio: { id: "media1" } }]
  });
  assert.equal(item.json.mediaId, "media1");
  assert.equal(item.json.sessionId, "wa_5511999999999");
  assert.match(item.json.prompt, /Ouça o áudio/);
});

test("prepares generated files as WhatsApp binary media", () => {
  const file = { name: "relatorio.pdf", mime_type: "application/pdf", b64_json: "aGVsbG8=" };
  const [reply] = runCode("Prepare Reply", { output_text: "Pronto", files: [file] });
  assert.equal(reply.json.text, "Pronto");
  const items = runCode("Generated Files", reply.json, { Normalize: { sender: "5511999999999" } });
  assert.equal(items[0].json.messageType, "document");
  assert.equal(items[0].binary.data.data, file.b64_json);
  assert.equal(items[0].binary.data.fileName, "relatorio.pdf");
});
