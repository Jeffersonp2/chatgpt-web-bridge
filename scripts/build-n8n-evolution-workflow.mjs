import fs from "node:fs";
import path from "node:path";

const node = (name, type, typeVersion, position, parameters) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, type, typeVersion, position, parameters
});
const code = (name, position, jsCode) => node(name, "n8n-nodes-base.code", 2, position, {
  mode: "runOnceForAllItems", language: "javaScript", jsCode
});
const http = (name, position, parameters) => node(name, "n8n-nodes-base.httpRequest", 4.2, position, parameters);
const auth = { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" };
const bridgeUrl = "http://SEU_SERVIDOR:4310/v1/chat/completions";
const evolutionUrl = "https://SUA_EVOLUTION_API";
const instance = "SUA_INSTANCIA";

const nodes = [
  node("Evolution Webhook", "n8n-nodes-base.webhook", 2, [0, 300], {
    httpMethod: "POST", path: "teste-gpt-evolution-TROQUE-POR-SEGREDO-ALEATORIO",
    responseMode: "onReceived", options: {}
  }),
  code("Normalize Evolution", [220, 300], `const event = $input.first().json.body || $input.first().json;
if (!['messages.upsert', 'MESSAGES_UPSERT'].includes(event.event)) return [];
const data = Array.isArray(event.data) ? event.data[0] : event.data;
const key = data?.key;
if (!key?.id || key.fromMe || typeof key.remoteJid !== 'string') return [];
const sender = key.remoteJid;
if (!/^\\d+@s\\.whatsapp\\.net$/.test(sender)) return [];
const raw = data.message || {};
const message = raw.ephemeralMessage?.message || raw.viewOnceMessage?.message || raw;
const mediaType = ['audio', 'image', 'document', 'video'].find(type => message[type + 'Message']) || '';
const media = mediaType ? message[mediaType + 'Message'] : null;
const base64 = typeof media?.base64 === 'string' ? media.base64
  : typeof message.base64 === 'string' ? message.base64
  : typeof data.base64 === 'string' ? data.base64 : '';
const text = message.conversation || message.extendedTextMessage?.text || media?.caption || '';
if (!mediaType && !text) return [];
const prompt = String(text || (mediaType === 'audio'
  ? 'Ouça o áudio e responda ao que foi falado.'
  : 'Analise o arquivo anexado e responda ao conteúdo.'));
return [{json:{sender:sender.split('@')[0],messageId:key.id,mediaType,base64,
  mimeType:media?.mimetype || 'application/octet-stream',
  fileName:media?.fileName || (mediaType || 'arquivo') + '.bin',prompt,
  sessionId:('wa_' + sender.split('@')[0]).slice(0,64)}}];`),
  node("Has Media", "n8n-nodes-base.if", 2.2, [440, 300], {
    conditions: { options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
      combinator: "and", conditions: [{ id: "media", leftValue: "={{ $json.mediaType }}",
        rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } }] },
    options: {}
  }),
  code("Media Binary", [660, 160], `const item = $input.first().json;
const raw = String(item.base64 || '');
const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1)
  throw new Error('Mídia sem base64 no webhook. Ative webhookBase64 na Evolution API.');
return [{json:item,binary:{data:{data:base64,mimeType:item.mimeType,fileName:item.fileName}}}];`),
  http("Bridge Media", [880, 160], {
    method: "POST", url: bridgeUrl, ...auth, sendBody: true, contentType: "multipart-form-data",
    bodyParameters: { parameters: [
      { name: "model", value: "chatgpt-web" },
      { name: "session_id", value: "={{ $json.sessionId }}" },
      { name: "messages", value: "={{ JSON.stringify([{role:'user',content:$json.prompt}]) }}" },
      { name: "include_base64", value: "true" },
      { parameterType: "formBinaryData", name: "file", inputDataFieldName: "data" }
    ] }, options: { timeout: 660000 }
  }),
  http("Bridge Text", [660, 440], {
    method: "POST", url: bridgeUrl, ...auth, sendBody: true, contentType: "json", specifyBody: "json",
    jsonBody: "={{ JSON.stringify({model:'chatgpt-web',session_id:$json.sessionId,messages:[{role:'user',content:$json.prompt}],include_base64:true}) }}",
    options: { timeout: 660000 }
  }),
  code("Prepare Reply", [1100, 300], `const result = $input.first().json;
const files = Array.isArray(result.files) ? result.files : [];
let text = String(result.output_text ?? result.choices?.[0]?.message?.content ?? '').trim();
if (files.some(file => !file.b64_json))
  text += (text ? '\\n\\n' : '') + 'Um arquivo foi gerado, mas não consegui baixá-lo para enviar pelo WhatsApp.';
if (!text) text = files.length ? 'Segue o arquivo gerado.' : 'Não consegui gerar uma resposta.';
return [{json:{text,files}}];`),
  code("Text Parts", [1320, 200], `const text = $input.first().json.text;
const sender = $('Normalize Evolution').first().json.sender;
return (text.match(/[\\s\\S]{1,3500}/g) || []).map(part => ({json:{text:part,sender}}));`),
  http("Send Text", [1540, 200], {
    method: "POST", url: `${evolutionUrl}/message/sendText/${instance}`, ...auth,
    sendBody: true, contentType: "json", specifyBody: "json",
    jsonBody: "={{ JSON.stringify({number:$json.sender,text:$json.text}) }}", options: {}
  }),
  code("Generated Files", [1320, 400], `const files = $input.first().json.files || [];
const sender = $('Normalize Evolution').first().json.sender;
return files.filter(file => typeof file.b64_json === 'string' && file.b64_json.length)
  .map(file => { const mimeType = String(file.mime_type || 'application/octet-stream').split(';')[0];
    const mediatype = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video' : 'document';
    return {json:{sender,mediatype,mimeType,fileName:file.name || 'arquivo.bin',
      media:file.b64_json}};
  });`),
  http("Send Generated File", [1540, 400], {
    method: "POST", url: `${evolutionUrl}/message/sendMedia/${instance}`, ...auth,
    sendBody: true, contentType: "json", specifyBody: "json",
    jsonBody: "={{ JSON.stringify({number:$json.sender,mediatype:$json.mediatype,mimetype:$json.mimeType,media:$json.media,fileName:$json.fileName,filename:$json.fileName}) }}",
    options: { timeout: 120000 }
  })
];

const connections = {};
const connect = (from, to, output = 0) => {
  connections[from] ||= { main: [] };
  connections[from].main[output] ||= [];
  connections[from].main[output].push({ node: to, type: "main", index: 0 });
};
connect("Evolution Webhook", "Normalize Evolution");
connect("Normalize Evolution", "Has Media");
connect("Has Media", "Media Binary", 0);
connect("Has Media", "Bridge Text", 1);
connect("Media Binary", "Bridge Media");
connect("Bridge Media", "Prepare Reply");
connect("Bridge Text", "Prepare Reply");
connect("Prepare Reply", "Text Parts");
connect("Prepare Reply", "Generated Files");
connect("Text Parts", "Send Text");
connect("Generated Files", "Send Generated File");

const workflow = {
  name: "ChatGPT Web Bridge Evolution API v2 (texto e mídia)", nodes, connections,
  settings: { executionOrder: "v1" }, active: false, pinData: {}, tags: []
};
const output = path.resolve("examples/n8n-whatsapp-evolution.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(workflow, null, 2) + "\n");
console.log(`Wrote ${output}`);
