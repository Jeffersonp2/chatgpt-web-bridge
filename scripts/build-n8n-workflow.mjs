import fs from "node:fs";
import path from "node:path";

const node = (name, type, typeVersion, position, parameters) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name, type, typeVersion, position, parameters
});
const code = (name, position, jsCode) => node(name, "n8n-nodes-base.code", 2, position, {
  mode: "runOnceForAllItems", language: "javaScript", jsCode
});
const httpRequest = (name, position, parameters) =>
  node(name, "n8n-nodes-base.httpRequest", 4.2, position, parameters);
const whatsapp = (name, position, parameters) =>
  node(name, "n8n-nodes-base.whatsApp", 1.1, position, parameters);

const bridgeUrl = "http://SEU_SERVIDOR:4310/v1/chat/completions";
const bridgeAuth = { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" };
const metaAuth = { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" };
const bridgeOptions = { timeout: 660000 };

const nodes = [
  node("WhatsApp Trigger", "n8n-nodes-base.whatsAppTrigger", 1, [0, 300], {
    updates: ["messages"], options: {}
  }),
  code("Normalize", [220, 300], `const event = $input.first().json;
const message = event.messages?.[0];
if (!message?.id || !message.from) return [];
const sender = String(message.from);
const mediaType = ['audio', 'image', 'document', 'video'].includes(message.type) ? message.type : '';
const media = mediaType ? message[mediaType] : null;
if (message.type !== 'text' && !media?.id) return [];
const prompt = String(message.text?.body || media?.caption || (mediaType === 'audio'
  ? 'Ouça o áudio e responda ao que foi falado.'
  : 'Analise o arquivo anexado e responda ao conteúdo.'));
return [{ json: {
  sender, messageId: message.id, mediaId: media?.id || '', mediaType,
  prompt, sessionId: ('wa_' + sender.replace(/[^0-9]/g, '')).slice(0, 64)
}}];`),
  node("Has Media", "n8n-nodes-base.if", 2.2, [440, 300], {
    conditions: { options: { version: 2, leftValue: "", caseSensitive: true, typeValidation: "strict" },
      combinator: "and", conditions: [{ id: "media", leftValue: "={{ $json.mediaId }}",
        rightValue: "", operator: { type: "string", operation: "notEmpty", singleValue: true } }] },
    options: {}
  }),
  whatsapp("Get Media URL", [660, 160], {
    resource: "media", operation: "mediaUrlGet", mediaGetId: "={{ $json.mediaId }}"
  }),
  httpRequest("Download Media", [880, 160], {
    method: "GET", url: "={{ $json.url }}", ...metaAuth,
    options: { response: { response: { responseFormat: "file", outputPropertyName: "data" } } }
  }),
  httpRequest("Bridge Media", [1100, 160], {
    method: "POST", url: bridgeUrl, ...bridgeAuth, sendBody: true,
    contentType: "multipart-form-data",
    bodyParameters: { parameters: [
      { name: "model", value: "chatgpt-web" },
      { name: "session_id", value: "={{ $('Normalize').first().json.sessionId }}" },
      { name: "messages", value: "={{ JSON.stringify([{role:'user',content:$('Normalize').first().json.prompt}]) }}" },
      { name: "include_base64", value: "true" },
      { parameterType: "formBinaryData", name: "file", inputDataFieldName: "data" }
    ] }, options: bridgeOptions
  }),
  httpRequest("Bridge Text", [880, 440], {
    method: "POST", url: bridgeUrl, ...bridgeAuth, sendBody: true,
    contentType: "json", specifyBody: "json",
    jsonBody: "={{ JSON.stringify({model:'chatgpt-web',session_id:$('Normalize').first().json.sessionId,messages:[{role:'user',content:$('Normalize').first().json.prompt}],include_base64:true}) }}",
    options: bridgeOptions
  }),
  code("Prepare Reply", [1320, 300], `const result = $input.first().json;
const files = Array.isArray(result.files) ? result.files : [];
let text = String(result.output_text ?? result.choices?.[0]?.message?.content ?? '').trim();
if (files.length && files.some(file => !file.b64_json)) {
  text += (text ? '\\n\\n' : '') + 'Um arquivo foi gerado, mas não consegui baixá-lo para enviar pelo WhatsApp.';
}
if (!text) text = files.length ? 'Segue o arquivo gerado.' : 'Não consegui gerar uma resposta.';
return [{json:{text,files}}];`),
  code("Text Parts", [1540, 200], `const text = $input.first().json.text;
const sender = $('Normalize').first().json.sender;
const parts = text.match(/[\\s\\S]{1,3500}/g) || [];
return parts.map(part => ({json:{text:part,sender}}));`),
  whatsapp("Send Text", [1760, 200], {
    operation: "send", messageType: "text", phoneNumberId: "SEU_PHONE_NUMBER_ID",
    recipientPhoneNumber: "={{ $json.sender }}", textBody: "={{ $json.text }}", additionalFields: {}
  }),
  code("Generated Files", [1540, 400], `const files = $input.first().json.files || [];
const sender = $('Normalize').first().json.sender;
return files.filter(file => typeof file.b64_json === 'string' && file.b64_json.length)
  .map(file => {
    const mimeType = String(file.mime_type || 'application/octet-stream').split(';')[0];
    const messageType = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('audio/') ? 'audio'
      : mimeType.startsWith('video/') ? 'video' : 'document';
    return {json:{sender,messageType},binary:{data:{
      data:file.b64_json,mimeType,fileName:file.name || 'arquivo.bin'
    }}};
  });`),
  whatsapp("Send Generated File", [1760, 400], {
    operation: "send", messageType: "={{ $json.messageType }}", mediaPath: "useMedian8n",
    mediaPropertyName: "data",
    phoneNumberId: "SEU_PHONE_NUMBER_ID", recipientPhoneNumber: "={{ $json.sender }}",
    additionalFields: {}
  })
];

const connections = {};
const connect = (from, to, output = 0) => {
  connections[from] ||= { main: [] };
  connections[from].main[output] ||= [];
  connections[from].main[output].push({ node: to, type: "main", index: 0 });
};
connect("WhatsApp Trigger", "Normalize");
connect("Normalize", "Has Media");
connect("Has Media", "Get Media URL", 0);
connect("Has Media", "Bridge Text", 1);
connect("Get Media URL", "Download Media");
connect("Download Media", "Bridge Media");
connect("Bridge Media", "Prepare Reply");
connect("Bridge Text", "Prepare Reply");
connect("Prepare Reply", "Text Parts");
connect("Prepare Reply", "Generated Files");
connect("Text Parts", "Send Text");
connect("Generated Files", "Send Generated File");

const workflow = {
  name: "testeGPT WhatsApp Cloud (texto e mídia)",
  nodes, connections,
  settings: { executionOrder: "v1" },
  active: false,
  pinData: {},
  tags: []
};
const output = path.resolve("examples/n8n-whatsapp-meta.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(workflow, null, 2) + "\n");
console.log(`Wrote ${output}`);
