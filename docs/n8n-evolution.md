# WhatsApp com Evolution API v2 e n8n

Importe [n8n-whatsapp-evolution.json](../examples/n8n-whatsapp-evolution.json) no n8n. O fluxo recebe o evento `MESSAGES_UPSERT`, envia texto e mídia ao testeGPT e devolve texto e arquivos pelo WhatsApp. O arquivo pode ser regenerado com `node scripts/build-n8n-evolution-workflow.mjs`.

## Configuração

1. Inicie o testeGPT e confirme que a sessão do ChatGPT Web está conectada. O n8n precisa alcançar o endereço do bridge; `127.0.0.1` dentro de um contêiner aponta para o próprio contêiner.
2. Importe o workflow e altere `SEU_SERVIDOR` nos nós **Bridge Text** e **Bridge Media**. Configure neles uma credencial **Header Auth** com `X-API-Key: <LOCAL_API_KEY>`. Se o bridge estiver acessível fora do computador, use `LOCAL_API_KEY`, `DASHBOARD_TOKEN` distintos e HTTPS ou rede privada.
3. Altere `SUA_EVOLUTION_API` e `SUA_INSTANCIA` nos nós **Send Text** e **Send Generated File**. Configure nesses nós outra credencial **Header Auth**, com `apikey: <chave da Evolution API>`.
4. No nó **Evolution Webhook**, substitua `TROQUE-POR-SEGREDO-ALEATORIO` por um valor longo e aleatório. Configure o webhook da instância Evolution para apontar à **Production URL** exibida pelo n8n. Use `webhookByEvents: false`, `webhookBase64: true` e somente o evento `MESSAGES_UPSERT`. A publicação do endpoint deve ser protegida por HTTPS e controle de acesso no proxy quando possível.
5. Ative o workflow após testar as credenciais e o webhook. Mantenha segredos apenas nas credenciais do n8n e na configuração da Evolution, nunca no JSON exportado.

Exemplo do corpo para configurar `POST /webhook/set/SUA_INSTANCIA` na Evolution API v2:

```json
{
  "enabled": true,
  "url": "https://SEU_N8N/webhook/teste-gpt-evolution-SEU_SEGREDO",
  "webhookByEvents": false,
  "webhookBase64": true,
  "events": ["MESSAGES_UPSERT"]
}
```

Confirme a **Production URL** exata no nó depois de alterar o caminho. Instalações diferentes da Evolution podem usar nomes de campos em `snake_case`; confira a versão instalada.

## Como funciona

- O nó **Normalize Evolution** ignora eventos que não sejam mensagens, mensagens enviadas pelo próprio número e conversas de grupo. Ele mantém um `session_id` por número e lê texto, legenda, áudio, imagem, documento e vídeo.
- Para mídia, o workflow exige base64 no webhook. O nó **Media Binary** o converte para binário do n8n e envia por `multipart/form-data` ao bridge. Se a Evolution não fornecer base64, a execução falha com uma mensagem explicativa, sem tentar baixar URLs protegidas ou criptografadas do WhatsApp. O fluxo aceita base64 no objeto da mídia ou em `data.message.base64`, conforme o canal e a versão.
- A resposta em texto é dividida em partes de até 3.500 caracteres e enviada por `/message/sendText/{instance}`. Arquivos com `b64_json` são enviados por `/message/sendMedia/{instance}`. Arquivos sem base64 são informados em texto. Áudio gerado é enviado como documento; mensagem de voz falada exige um serviço de síntese de fala.

O workflow de exemplo não inclui deduplicação persistente. Configure Data Table, Redis ou banco no n8n usando `messageId` antes de uso contínuo; reentregas do webhook podem gerar respostas duplicadas. Verifique também os limites de mídia da Evolution, `MAX_UPLOAD_MB`, o tempo de execução do n8n e a memória consumida por base64. Uma única mensagem é processada por execução.

## Testes de ponta a ponta

Envie texto, áudio curto, imagem e PDF para o número conectado. Em seguida, peça a geração de um arquivo e confirme `files[].b64_json` e a entrega do arquivo no WhatsApp. O workflow foi validado estruturalmente e com exemplos de payload locais; a conexão com a sua instância Evolution e o envio real exigem essas verificações após configurar as credenciais.

Referências: [webhook da Evolution API](https://docs.evoapicloud.com/api-reference/webhook/set), [envio de mídia](https://docs.evoapicloud.com/api-reference/message-controller/send-media), [documentação do n8n Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).
