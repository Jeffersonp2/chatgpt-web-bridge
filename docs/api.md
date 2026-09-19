# Referência HTTP — testeGPT

Base URL padrão: `http://127.0.0.1:4310`. Os endpoints `/v1/*` são compatíveis com parte dos formatos da API da OpenAI, com extensões próprias descritas aqui. O processamento depende de uma sessão autenticada no ChatGPT Web.

## Autenticação, sessão e formatos

- Com `HOST=127.0.0.1` e `LOCAL_API_KEY` vazio, `/v1/*` aceita requisições sem chave. Se `LOCAL_API_KEY` estiver definido, use `Authorization: Bearer SUA_CHAVE` **ou** `X-API-Key: SUA_CHAVE` em todas as rotas `/v1/*`.
- Fora do loopback, `/v1/*` exige `LOCAL_API_KEY`. O dashboard usa um token diferente, `DASHBOARD_TOKEN`, via cookie após o login na página.
- `POST /v1/chat/completions`, `/v1/responses` e `/v1/images/generations` aceitam JSON ou `multipart/form-data`. Em multipart, campos estruturados como `messages`, `input` e `attachments` devem conter JSON serializado; arquivos podem usar o campo `file`.
- A sessão padrão é `default`. Nos endpoints de geração e em `POST /v1/conversation/new`, passe `session_id` no corpo ou `X-Session-Id` no cabeçalho. O corpo tem prioridade. IDs aceitam de 1 a 64 letras, números, `.`, `_` e `-`.
- Os aliases de modelo são `chatgpt-web`, `chatgpt-web-instant`, `chatgpt-web-thinking` e `chatgpt-web-pro`. `mode` também pode ser `instant`, `thinking` ou `pro`. A disponibilidade do modo depende da conta e da interface.
- `new_chat: true` abre uma conversa normal nova antes de enviar a mensagem. `include_base64: true` ou `response_format: "b64_json"` tenta acrescentar `b64_json` a arquivos gerados.

Nos exemplos, substitua `SUA_CHAVE` quando a chave estiver configurada. O projeto não usa a chave da API oficial da OpenAI.

## Índice de endpoints

| Método | Rota | Resultado | Autenticação |
|---|---|---|---|
| GET | `/` | Identificação e URLs | Nenhuma |
| GET | `/health` | Estado do navegador, sessões e recursos | Dashboard |
| GET | `/login` | Abre a tela de login do ChatGPT se necessário | Dashboard |
| GET | `/dashboard/docs` | Referência de endpoints e integrações no dashboard | Dashboard |
| GET | `/v1/models` | Lista de aliases | API |
| GET | `/v1/models/:model` | Alias específico | API |
| GET | `/v1/sessions` | Sessões abertas em memória | API |
| POST | `/v1/sessions` | Cria ou abre sessão | API |
| DELETE | `/v1/sessions/:sessionId` | Fecha sessão não padrão | API |
| POST | `/v1/conversation/new` | Inicia conversa normal na sessão | API |
| POST | `/v1/chat/completions` | Resposta de chat ou SSE | API |
| POST | `/v1/responses` | Resposta no formato Responses ou SSE | API |
| POST | `/v1/audio/transcriptions` | Transcrição de áudio | API |
| POST | `/v1/audio/translations` | Transcrição traduzida para inglês | API |
| POST | `/v1/images/generations` | Imagens geradas encontradas na resposta | API |

### `GET /` e `GET /health`

`GET /` devolve `name`, `version`, `api` e `dashboard`. `GET /health` consulta o navegador e devolve `ok`, `chatgpt`, `sessions`, `features` e `remote_login`; pode responder `503` quando a verificação falha. Quando `DASHBOARD_TOKEN` está configurado, `/health` requer o cookie do dashboard. Sem token, somente é acessível se `HOST` for loopback.

### Modelos e sessões

```bash
curl http://127.0.0.1:4310/v1/models -H 'X-API-Key: SUA_CHAVE'
curl http://127.0.0.1:4310/v1/models/chatgpt-web-thinking -H 'X-API-Key: SUA_CHAVE'
curl http://127.0.0.1:4310/v1/sessions -H 'X-API-Key: SUA_CHAVE'
curl http://127.0.0.1:4310/v1/sessions -H 'X-API-Key: SUA_CHAVE' -H 'Content-Type: application/json' -d '{"session_id":"cliente-1"}'
curl -X DELETE http://127.0.0.1:4310/v1/sessions/cliente-1 -H 'X-API-Key: SUA_CHAVE'
```

`POST /v1/sessions` devolve `201` com `id`, `object: "chatgpt.web.session"` e `ready: true`. Se o ID for omitido, o servidor gera um ID. `GET /v1/sessions` lista as sessões atualmente abertas; o estado persistido em disco pode existir mesmo quando a aba ainda não foi reaberta. `DELETE` devolve `{ "ok": true, "deleted": true|false }`; a sessão `default` não pode ser excluída.

Para abrir uma conversa nova dentro de uma sessão existente:

```bash
curl -X POST http://127.0.0.1:4310/v1/conversation/new \
  -H 'X-API-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"session_id":"cliente-1"}'
```

Resposta: `ok`, `session_id` e `message`.

### `POST /v1/chat/completions`

Campos principais: `messages` (array obrigatório, salvo quando `attachments` contém ao menos um anexo), `model`, `session_id`, `mode`, `new_chat`, `stream`, `attachments`, `include_base64` e `response_format`.

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H 'X-API-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","session_id":"cliente-1","messages":[{"role":"user","content":"Olá!"}]}'
```

Resposta não streaming: `id`, `object: "chat.completion"`, `created`, `model`, `session_id`, `output_text`, `choices`, `files`, `url` e `usage: null`. `choices[0].message.content` pode incluir uma descrição ou URL de arquivo; `output_text` contém só o texto da resposta. `files[]` contém metadados como `name`, `mime_type`, `kind`, `file_id`, `url` e, quando solicitado e obtido, `b64_json`. URLs do ChatGPT podem expirar ou exigir autenticação.

Com `"stream": true`, a resposta é `text/event-stream` com chunks `chat.completion.chunk`, possíveis chunks próprios com `files` e `session_id`, comentário de heartbeat e `data: [DONE]`. O cabeçalho `X-TesteGPT-Stream-Granularity: ui-delta` indica que os eventos são deltas observados na interface, sem garantia de um evento por token. Erros após o início do stream são enviados como objeto `error` no SSE.

### `POST /v1/responses`

`input` aceita string, array de partes de conteúdo ou array de mensagens com `role`. Os demais campos de sessão, modelo, anexos e streaming seguem o endpoint de chat.

```bash
curl http://127.0.0.1:4310/v1/responses \
  -H 'X-API-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"model":"chatgpt-web","input":"Explique HTTP em uma frase."}'
```

Resposta não streaming: `id`, `object: "response"`, `created_at`, `status: "completed"`, `model`, `session_id`, `output`, `output_text`, `files` e `url`. Com `stream: true`, usa eventos SSE `response.created`, `response.in_progress`, `response.output_text.delta`, `response.output_text.done` e `response.completed`; falhas após iniciar usam `event: error`. Este formato é uma implementação parcial da Responses API, sem suporte a todas as ferramentas ou campos da API oficial.

### Entrada de imagens, áudio e arquivos

Há três formas de anexar mídia:

1. `messages[].content` com partes `image_url`/`input_image`, `input_audio` ou `file`/`input_file`/`attachment`, usando data URL, base64 ou URL HTTP/HTTPS.
2. `attachments` no topo do JSON, anexado à última mensagem `user`; exemplo: `{ "filename":"dados.json", "mime_type":"application/json", "data":"BASE64" }`.
3. `multipart/form-data` com campo binário `file`, inclusive várias ocorrências, e `messages` como JSON serializado.

Exemplo multipart:

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H 'X-API-Key: SUA_CHAVE' \
  -F 'model=chatgpt-web' \
  -F 'session_id=cliente-1' \
  -F 'messages=[{"role":"user","content":"Analise este PDF."}]' \
  -F 'include_base64=true' \
  -F 'file=@relatorio.pdf;type=application/pdf'
```

URLs remotas só são aceitas com `ALLOW_REMOTE_URL_INPUT=true` e são baixadas pelo servidor com bloqueio de destinos internos, limite `MAX_REMOTE_FILE_BYTES` e timeout `REMOTE_FETCH_TIMEOUT_MS`. O bridge não possui credenciais de provedores externos: para mídia privada do WhatsApp, faça o download autenticado no n8n e envie o arquivo binário ao bridge.

### `POST /v1/audio/transcriptions` e `/v1/audio/translations`

Exigem `multipart/form-data` com campo binário `file`; aceitam `prompt`, `session_id`, `model`, `mode` e `new_chat`. A tradução pede ao ChatGPT texto em inglês. A resposta é `{ "text": "...", "session_id": "...", "model": "..." }`.

```bash
curl http://127.0.0.1:4310/v1/audio/transcriptions \
  -H 'X-API-Key: SUA_CHAVE' -F 'file=@fala.ogg;type=audio/ogg'
```

O resultado depende da capacidade de upload e compreensão de áudio disponível na sessão do ChatGPT Web; não é um serviço de transcrição determinístico.

### `POST /v1/images/generations`

Aceita `prompt` e os campos comuns de sessão; também aceita anexos como referência. É necessário `prompt` ou ao menos um anexo. `response_format: "b64_json"` ou `include_base64: true` tenta baixar as imagens geradas. A resposta contém `created`, `session_id`, `data[]`, `files[]`, `url` e `text`. `data[]` pode estar vazio se a interface não expuser um arquivo de imagem detectável.

```bash
curl http://127.0.0.1:4310/v1/images/generations \
  -H 'X-API-Key: SUA_CHAVE' -H 'Content-Type: application/json' \
  -d '{"prompt":"Uma paisagem em aquarela","response_format":"b64_json"}'
```

## Dashboard e controle do navegador

Essas rotas usam autenticação do dashboard, separada de `/v1`. Com token, abra `/dashboard?token=SEU_DASHBOARD_TOKEN` no navegador para receber o cookie; não use esse token como chave da API. Sem token, só são acessíveis quando `HOST` é loopback.

| Método | Rota | Função |
|---|---|
| GET | `/dashboard` | Interface de status |
| GET | `/dashboard/docs` | Endpoints, exemplos e integrações |
| GET/POST | `/dashboard/settings` | Formulário e gravação do `.env`; requer reinício para aplicar |
| GET | `/dashboard/browser` | Controle visual pelo Playwright |
| GET | `/dashboard/browser/state` | Estado e abas do navegador |
| GET | `/dashboard/browser/frame?page=0` | Captura PNG de uma aba |
| POST | `/dashboard/browser/action` | Clique, teclado, rolagem e navegação |
| GET | `/dashboard/remote-status` | Estado do login remoto Linux |
| GET | `/dashboard/login` | Tela noVNC quando habilitada |
| GET | `/dashboard/logout` | Remove o cookie |
| GET | `/novnc/*` | Recursos estáticos do noVNC, quando instalado |
| WS | `/dashboard/vnc` | WebSocket do noVNC, quando habilitado |

`/dashboard/browser/action` recebe JSON com `type`: `click`, `dblclick`, `move` (campos `x`, `y`, opcional `button`), `scroll` (`deltaX`, `deltaY`), `type` (`text`), `key` (`key`), `reload`, `back`, `forward` ou `focus`. O campo `page` seleciona a aba. As rotas de controle retornam `503` quando desativadas.

## Limites e erros

| Situação | Resposta típica |
|---|---|
| Chave de API ausente ou incorreta | `401` com `error.type: "authentication_error"` |
| API exposta sem `LOCAL_API_KEY` | `503` com `error.type: "configuration_error"` |
| `messages` ausente em Chat Completions, prompt/anexo ausente em imagens ou arquivo de áudio ausente | `400` com `error.type: "invalid_request_error"` |
| Alias de modelo não encontrado em `GET /v1/models/:model` | `404` |
| ID de sessão inválido ou modo indisponível | `400` |
| Login do ChatGPT ausente | `401` |
| Falha no ChatGPT Web ou na automação do navegador | `502` com `error.type: "chatgpt_web_error"` |
| Erro do parser multipart, inclusive limite de arquivo | `400` |

O limite padrão é `JSON_LIMIT=50mb`, até 20 arquivos multipart por requisição e `MAX_UPLOAD_MB=40` por arquivo. `REQUEST_TIMEOUT_MS=600000` controla a espera pelo ChatGPT. O bridge depende da interface do ChatGPT Web e não oferece a mesma estabilidade ou cobertura de recursos da API oficial.
