<div align="center">

# 🤖 testeGPT Local Bridge

### ChatGPT Web → API local compatível com OpenAI

**Sem Ollama • sem modelo local • sem chave de API obrigatória**

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)
![API](https://img.shields.io/badge/API-OpenAI%20Compatible-412991)
![Local](https://img.shields.io/badge/Bind-127.0.0.1-blue)
![Status](https://img.shields.io/badge/status-alpha-orange)

</div>

---

## ✨ O que é

O **testeGPT Local Bridge** transforma uma sessão do **ChatGPT Web autenticada no seu próprio navegador local** em uma API HTTP local.

A ideia é simples:

```text
Seu programa / IDE / cliente
          │
          │ POST /v1/chat/completions
          ▼
┌──────────────────────────┐
│ testeGPT Local Bridge    │
│ http://127.0.0.1:4310/v1 │
└────────────┬─────────────┘
             │
             ▼
     ChatGPT Web autenticado
             │
             ▼
          resposta
```

Você continua usando sua conta do ChatGPT no navegador. O bridge recebe o input pela API, envia ao ChatGPT Web e devolve o output em um formato semelhante ao da API da OpenAI.

> Este projeto é experimental e não é uma API oficial do ChatGPT Web. Mudanças na interface do site podem exigir ajustes nos seletores do navegador.

---

## 🚀 Recursos atuais

- ✅ Login persistente em uma sessão local do ChatGPT
- ✅ Login normal pelo navegador, inclusive **Continuar com Google**
- ✅ API somente em `127.0.0.1` por padrão
- ✅ `GET /v1/models`
- ✅ `POST /v1/chat/completions`
- ✅ `POST /v1/responses`
- ✅ Compatibilidade inicial com `stream: true`
- ✅ Texto e código
- ✅ Perfil do navegador salvo localmente
- ✅ Fila para evitar duas mensagens brigando pela mesma aba
- ✅ Upload/entrada de imagens por base64/data URL (beta)
- ✅ Entrada de áudio/gravações por base64/data URL (beta)
- ✅ Entrada de arquivos genéricos por base64 (beta)
- 🚧 Upload multipart/form-data e URLs HTTP remotas
- ✅ Captura de links de imagens geradas
- ✅ Extração de links de arquivos/anexos gerados (imagem, vídeo, ZIP, PDF, código e outros)
- 🚧 Streaming token-a-token real
- 🚧 Múltiplas sessões/abas simultâneas

---

## 🧰 Requisitos

- Windows, Linux ou macOS
- **Node.js 20 ou superior**
- Internet
- Uma conta do ChatGPT

Não precisa de:

- Ollama
- LM Studio
- GPU local
- baixar pesos de modelos
- uma API key da OpenAI para o modo ChatGPT Web

---

## 📦 Instalação

Clone:

```bash
git clone https://github.com/Jeffersonp2/testeGPT.git
cd testeGPT
```

Instale as dependências:

```bash
npm install
```

Instale o Chromium usado pelo Playwright:

```bash
npm run install:browser
```

Inicie:

```bash
npm start
```

Servidor padrão:

```text
http://127.0.0.1:4310
```

API:

```text
http://127.0.0.1:4310/v1
```

---

## 🔐 Primeiro login

Ao executar:

```bash
npm start
```

o **Chrome for Testing abre automaticamente**.

Se ainda não existir uma sessão autenticada, ele vai direto para a tela de login do ChatGPT. Faça login normalmente e, se quiser, selecione:

```text
Continuar com Google
```

Depois do primeiro login, a sessão fica no diretório local:

```text
.data/chatgpt-profile/
```

Esse diretório está no `.gitignore` e **não deve ser enviado ao GitHub**.

Confira o estado:

```text
http://127.0.0.1:4310/health
```

---

## 🔄 Continuidade da conversa

Por padrão, o bridge **não abre um chat novo a cada requisição**.

O comportamento é:

```text
primeira mensagem
      ↓
abre/usa um chat normal
      ↓
segunda mensagem
      ↓
continua no MESMO chat
      ↓
terceira mensagem
      ↓
continua no MESMO chat
      ↓
limite específico daquela conversa detectado
      ↓
abre automaticamente outro chat normal
      ↓
reenvia o contexto disponível e continua
```

Isso não usa Chat Temporário.

Se você quiser forçar manualmente uma conversa nova, envie `new_chat: true` na requisição ou chame:

```text
POST http://127.0.0.1:4310/v1/conversation/new
```

O rollover automático é feito somente para sinais de **limite daquela conversa**. Limites gerais da conta ou do modelo não são tratados como motivo para abrir chats em loop.

---

## 💬 Exemplo — Chat Completions

### PowerShell

```powershell
$body = @{
    model = "chatgpt-web"
    messages = @(
        @{
            role = "user"
            content = "Crie uma função JavaScript que calcule Fibonacci."
        }
    )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
    -Uri "http://127.0.0.1:4310/v1/chat/completions" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

### curl

```bash
curl http://127.0.0.1:4310/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {
        "role": "user",
        "content": "Explique Docker em poucas linhas."
      }
    ]
  }'
```

Resposta:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "model": "chatgpt-web",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ]
}
```


---

## 📎 Arquivos gerados

Quando o ChatGPT gerar ou anexar um arquivo no turno da resposta, o bridge tenta detectar o link e devolve uma lista `files[]`.

Isso vale para imagens, vídeos, ZIP, PDF, arquivos de texto/código e outros anexos que apareçam no ChatGPT Web.

Exemplo:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Arquivo criado."
      }
    }
  ],
  "files": [
    {
      "name": "file_00000000...",
      "mime_type": "image/*",
      "kind": "image",
      "file_id": "file_00000000...",
      "url": "https://chatgpt.com/backend-api/estuary/content?id=file_..."
    }
  ]
}
```

Os links retornados pelo ChatGPT podem ser temporários e podem depender da sessão autenticada.

Também existe:

```text
POST /v1/images/generations
```

com body:

```json
{
  "prompt": "gere uma imagem qualquer"
}
```

---


## 🎙️ Entrada de áudio, imagem e arquivos em base64

O bridge aceita anexos dentro de `messages[].content` e também em `attachments` no nível principal da requisição.

### Áudio como comando

Exemplo compatível com o formato `input_audio`:

```json
{
  "model": "chatgpt-web",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_audio",
          "input_audio": {
            "data": "<BASE64>",
            "format": "wav",
            "filename": "comando.wav"
          }
        }
      ]
    }
  ]
}
```

Quando o áudio for enviado sem texto junto, o bridge acrescenta uma instrução padrão para o ChatGPT ouvir o áudio e seguir uma eventual instrução falada; se não houver comando, ele responde normalmente ao conteúdo.

Formatos inicialmente tratados: `wav`, `mp3`, `m4a/mp4`, `ogg` e `webm`.

### Imagem em data URL

```json
{
  "model": "chatgpt-web",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Descreva esta imagem."
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,<BASE64>"
          }
        }
      ]
    }
  ]
}
```

### Anexo genérico

Também pode ser enviado no nível principal:

```json
{
  "model": "chatgpt-web",
  "messages": [
    {
      "role": "user",
      "content": "Analise o arquivo anexado."
    }
  ],
  "attachments": [
    {
      "filename": "dados.json",
      "mime_type": "application/json",
      "data": "<BASE64>"
    }
  ]
}
```

A carga JSON padrão foi aumentada para `50mb` e pode ser alterada com `JSON_LIMIT`. Como base64 aumenta o tamanho em aproximadamente um terço, arquivos binários grandes devem futuramente usar `multipart/form-data`.

> Esta entrada multimodal é beta e depende do controle de upload presente na interface atual do ChatGPT Web.

---

## 🧠 Responses API

```powershell
$body = @{
    model = "chatgpt-web"
    input = "Escreva um exemplo de servidor HTTP em Python."
} | ConvertTo-Json

Invoke-RestMethod `
    -Uri "http://127.0.0.1:4310/v1/responses" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

---

## 🔌 Usando como endpoint OpenAI-compatible

Em ferramentas que aceitam uma **Base URL customizada**, use:

```text
http://127.0.0.1:4310/v1
```

Modelo inicial:

```text
chatgpt-web
```

Alguns clientes exigem uma API key mesmo quando o servidor local não a utiliza. Nesses casos, enquanto o bridge não exigir autenticação local, você pode informar um valor fictício como:

```text
local
```

---

## ⚙️ Configuração

As variáveis disponíveis estão em `.env.example`.

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `4310` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de rede |
| `CHATGPT_PROFILE_DIR` | `.data/chatgpt-profile` | Perfil persistente |
| `CHATGPT_HEADLESS` | `false` | Navegador visível/invisível |
| `REQUEST_TIMEOUT_MS` | `180000` | Timeout de uma resposta |

> Recomenda-se manter `HOST=127.0.0.1`. Não exponha diretamente o bridge na internet sem autenticação, TLS e controles adicionais.

---

## 🗺️ Roadmap

### v0.1
- [x] Bridge HTTP local
- [x] Login persistente
- [x] Chat Completions
- [x] Responses API básica
- [x] Proteção do perfil via `.gitignore`

### v0.2
- [ ] Captura incremental para streaming real
- [ ] Seleção do modelo/modo disponível no ChatGPT
- [x] Conversa persistente por padrão\n- [x] Rollover automático para um novo chat normal ao atingir limite da conversa
- [x] Entrada de imagens por base64/data URL (beta)
- [x] Entrada de áudio por base64/data URL (beta)
- [x] Entrada de arquivos genéricos por base64 (beta)
- [ ] Upload multipart/form-data e URLs HTTP remotas
- [ ] Melhor detecção de término da resposta

### v0.3
- [x] Captura de links de imagens geradas
- [x] Retorno de links de arquivos/anexos gerados
- [x] Retorno de imagens por URL\n- [ ] Retorno opcional em base64
- [ ] Compatibilidade maior com SDKs OpenAI

### v0.4
- [ ] Pool de abas
- [ ] Sessões paralelas
- [ ] Token local para proteger `/v1`
- [ ] Dashboard de status

---

## 🔒 Segurança

Nunca faça commit de:

```text
.data/
.env
cookies
tokens
perfil do navegador
credenciais
```

O servidor é limitado a `127.0.0.1` por padrão.

---

## ⚠️ Observação

Este projeto automatiza uma interface Web autenticada pelo próprio usuário. Isso é inerentemente mais frágil do que uma API documentada: seletores, DOM, fluxos de login e controles do ChatGPT podem mudar.

Para aplicações de produção, integração oficial e comportamento contratualmente estável, prefira interfaces oficiais disponibilizadas pela OpenAI.

---

<div align="center">

Feito para experimentar **ChatGPT como backend local**, mantendo o processamento do modelo remoto.

**Jeffersonp2/testeGPT**

</div>
