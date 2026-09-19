# Histórico de versões

## v0.2.0 — primeiro release (2026-09-19)

Bridge local para uma sessão autenticada do ChatGPT Web, com endpoints de chat, Responses, transcrição, tradução de áudio, geração de imagens, modelos e sessões.

### Recursos

- Respostas em texto e streaming SSE com deltas observados na interface.
- Entrada de texto, imagens, áudio e arquivos por JSON/base64, URL remota validada ou multipart.
- Captura de arquivos gerados e retorno opcional em base64.
- Sessões paralelas, histórico local e retomada de conversa.
- Dashboard para status, configuração e controle remoto do Chromium.
- Workflows n8n para WhatsApp Business Cloud e Evolution API v2.

### Estabilização e segurança

- Recuperação de aba após downloads e testes automatizados com Chromium no CI.
- Seletores alternativos para estruturas conhecidas da interface do ChatGPT.
- Chave local exigida para expor `/v1` fora do loopback; token separado para o dashboard.
- Restrições de tamanho, tempo e destino para downloads de anexos por URL.

### Limites conhecidos

- O bridge depende da interface do ChatGPT Web; mudanças futuras podem exigir ajustes.
- Streaming envia deltas da UI, sem granularidade garantida por token do modelo.
- Integrações WhatsApp requerem credenciais, configuração do provedor e testes de ponta a ponta na instância do usuário.
- Downloads e mídia precisam de observação adicional em uma sessão real autenticada do ChatGPT.

Consulte a [referência HTTP](docs/api.md) e o [README](README.md) para instalação e configuração.
