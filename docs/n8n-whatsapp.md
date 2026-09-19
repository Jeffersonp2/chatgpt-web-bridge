# WhatsApp e n8n

O ChatGPT Web Bridge recebe texto, áudio, imagens e arquivos, mas não se conecta sozinho ao WhatsApp. O n8n recebe a mensagem, baixa a mídia com a credencial do provedor, chama o bridge e envia a resposta. Este guia usa os nós do WhatsApp Business Cloud da Meta; para outro provedor, troque apenas os nós de entrada, download e envio.

O arquivo [n8n-whatsapp-meta.json](../examples/n8n-whatsapp-meta.json) contém um workflow importável para a API oficial da Meta. Importe-o em **Workflows → Import from File**, configure os itens abaixo e só então ative o fluxo. O arquivo pode ser regenerado com `node scripts/build-n8n-workflow.mjs`.

## Preparação

1. Inicie o ChatGPT Web Bridge e confirme que o login do ChatGPT Web funciona.
2. Garanta que o n8n alcança a URL do bridge. `127.0.0.1` dentro de um contêiner n8n aponta para o próprio contêiner, não para o computador que executa o ChatGPT Web Bridge.
3. Se usar `HOST=0.0.0.0`, configure **duas chaves diferentes**: `DASHBOARD_TOKEN` e `LOCAL_API_KEY`. Use HTTPS ou uma rede privada entre n8n e o bridge.
4. Guarde `LOCAL_API_KEY` em uma credencial Header Auth do n8n com o cabeçalho `X-API-Key`. Não coloque a chave no workflow exportado.
5. No workflow importado, substitua `SEU_SERVIDOR` nos nós **Bridge Text** e **Bridge Media** e `SEU_PHONE_NUMBER_ID` nos nós **Send Text** e **Send Generated File**.
6. Selecione a credencial WhatsApp Business Cloud nos nós **WhatsApp Trigger**, **Get Media URL**, **Send Text** e **Send Generated File**. Nos nós **Download Media**, use uma credencial Header Auth com `Authorization: Bearer <token da Meta>`. Nos dois nós **Bridge**, use a credencial `X-API-Key` do passo 4.

O workflow trata uma mensagem por execução, separa respostas longas em partes de até 3.500 caracteres e tenta enviar cada arquivo de `files[]` que contenha `b64_json`. Se algum arquivo não puder ser baixado, ele informa isso em texto. O fluxo deve ser ativado apenas depois de configurar as credenciais e testar com o seu número.

## Fluxo de entrada

1. **WhatsApp Trigger**: receba eventos de mensagem. Ignore eventos de status e mensagens enviadas pelo próprio número para evitar loops. Guarde o ID da mensagem para impedir processamento duplicado.
2. **Edit Fields / Switch**: extraia o ID do contato, o texto, o tipo da mensagem e, para mídia, o ID do arquivo. Use um `session_id` estável por contato, com apenas letras, números, ponto, `_` ou `-` e até 64 caracteres. Por exemplo: `wa_5511999999999`.
3. **Mídia**: use **WhatsApp Business Cloud → Media → Download** com a credencial do WhatsApp para obter a URL temporária. Em seguida, use um **HTTP Request GET** com a credencial da Meta e resposta em formato de arquivo/binário para baixar o conteúdo. Não passe a URL protegida do WhatsApp diretamente ao bridge, pois o bridge não possui a credencial da Meta.
4. **HTTP Request** para `POST http://SEU-SERVIDOR:4310/v1/chat/completions`, com a credencial Header Auth do bridge. Desative streaming para receber uma única resposta JSON.

Para texto, use corpo JSON:

```json
{
  "model": "chatgpt-web",
  "session_id": "wa_5511999999999",
  "messages": [{ "role": "user", "content": "Olá!" }],
  "include_base64": true
}
```

Para áudio, imagem ou arquivo, escolha **Body Content Type: Form-Data** no HTTP Request e adicione:

| Parameter Type | Name | Value / Input Data Field Name |
|---|---|---|
| Form Data | `model` | `chatgpt-web` |
| Form Data | `session_id` | ID estável do contato |
| Form Data | `messages` | JSON serializado, como `[{"role":"user","content":"Responda ao conteúdo do anexo."}]` |
| Form Data | `include_base64` | `true` |
| n8n Binary File | `file` | Nome do campo binário recebido do nó de download |

Use a legenda do WhatsApp como texto da mensagem quando existir. Para áudio sem legenda, peça explicitamente ao ChatGPT para ouvir o arquivo e responder ao conteúdo falado. O upload de áudio, imagem e arquivo depende da interface do ChatGPT Web e precisa ser testado com o formato recebido.

## Fluxo de saída

- Texto: envie `choices[0].message.content` com **WhatsApp Business Cloud → Message → Send**.
- Arquivos: examine `files[]`. Quando houver `b64_json`, converta o base64 em binário no n8n, faça **Media → Upload** no WhatsApp e envie uma mensagem de mídia com o ID retornado. Evite entregar ao contato a URL do ChatGPT; ela pode expirar ou exigir autenticação.
- Quando `files[]` não tiver `b64_json`, não suponha que o arquivo esteja disponível para envio. Envie o texto e registre a falha para investigar o download autenticado.
- Para responder por mensagem de voz, acrescente um serviço de síntese de fala; o bridge gera texto, não áudio falado.

Respeite os limites `MAX_UPLOAD_MB`, `JSON_LIMIT` e os limites de mídia do seu provedor. O retorno em base64 aumenta o tamanho da resposta; para arquivos grandes, monitore memória e tempo de execução do n8n.

## Teste mínimo

1. Envie texto e confirme uma resposta e a continuidade da conversa pelo mesmo `session_id`.
2. Envie um áudio curto e confira se a resposta se refere ao que foi falado.
3. Envie uma imagem e um PDF pequenos.
4. Peça um arquivo gerado e confirme separadamente `files[]`, `b64_json`, upload e envio no WhatsApp.
5. Antes de uso contínuo, configure deduplicação persistente por ID da mensagem em um Data Table, Redis ou banco de dados no n8n. O workflow de exemplo ainda não inclui esse armazenamento; sem ele, uma nova entrega do webhook pode causar resposta dupla.

Consulte a documentação do n8n para os nós [WhatsApp Trigger](https://docs.n8n.io/integrations/builtin/trigger-nodes/n8n-nodes-base.whatsapptrigger/), [WhatsApp Business Cloud](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.whatsapp/) e [HTTP Request Form-Data](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/).
