# Deploy da radar-ponte no Railway

Guia de deploy sem valores secretos. O `PONTE_TOKEN` real só existe nas variáveis do Railway e no segredo da `ponte-api`; nunca em arquivo, commit ou log.

## 1. Antes de subir

Teste a `ponte-api` publicada a partir da sua máquina (o token é digitado sem aparecer na tela e não vai para o histórico do shell):

```bash
npm ci && npm run build
read -rsp 'PONTE_TOKEN: ' PONTE_TOKEN; echo
PONTE_API_URL=https://holo-match-engine.lovable.app/api/public/ponte-api \
PONTE_TOKEN="$PONTE_TOKEN" DATA_DIR=./data-teste npm run -s check
unset PONTE_TOKEN
```

Esperado: `OK`. Os motivos de `FALHA` estão no [README](README.md#npm-run-check) (401 = token errado, 404 = URL errada ou ação inexistente, timeout = serviço fora).

## 2. Serviço

1. **New Project → Deploy from GitHub repo →** `novahmk/radar`, branch `main`.
2. O [railway.json](railway.json) já configura:

| Item | Valor |
|---|---|
| Builder | `DOCKERFILE` ([Dockerfile](Dockerfile) em duas etapas, roda como usuário `node`) |
| Réplicas | `numReplicas: 1` |
| Healthcheck | `GET /health`, timeout de 60 s |
| Reinício | `ON_FAILURE`, até 10 tentativas |

3. **Mantenha exatamente 1 réplica.** Duas instâncias com a mesma sessão do WhatsApp derrubam uma à outra. Não ative autoscaling nem réplicas extras em **Settings → Deploy**.

## 3. Volume

**Settings → Volumes → New Volume**, montado em **`/data`**.

Ele guarda, entre deploys:

- `/data/auth/`: sessão do WhatsApp (sem ela, um novo QR é exigido a cada deploy);
- `/data/identidades.json`: chaves estáveis das conversas `@lid`.

Os dois contêm identificadores e telefones: não exporte nem compartilhe o volume.

## 4. Variáveis (Settings → Variables)

| Variável | Valor | Observação |
|---|---|---|
| `PONTE_API_URL` | `https://holo-match-engine.lovable.app/api/public/ponte-api` | exato; precisa ser `https` |
| `PONTE_TOKEN` | *(segredo; mínimo 32 caracteres)* | o mesmo valor configurado como segredo na `ponte-api`. Cole direto no Railway. |
| `DATA_DIR` | `/data` | opcional: já é o padrão no Dockerfile. Precisa ser o caminho do volume. |
| `LOG_LEVEL` | `info` | opcional |
| `PORT` | *(não defina)* | o Railway injeta a porta; o healthcheck usa a mesma |

**Remova**, se existirem de versões antigas: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_ID`. Se continuarem lá, a ponte avisa no log (só os nomes), mas a service role não deve ficar fora do Supabase.

Variável faltando ou inválida faz o processo sair com código 1 e a mensagem `[radar-ponte] Configuração inválida...` listando só nomes e motivos.

## 5. O que esperar nos logs da primeira subida

Logs em JSON, horário de São Paulo, só com contagens, status e códigos. Nunca aparecem texto de mensagem, nome, telefone, QR ou token. Em ordem:

| # | `msg` | Significado |
|---|---|---|
| 1 | `Iniciando radar-ponte (somente leitura)` | processo subiu |
| 2 | `Healthcheck ouvindo` (`porta`) | `/health` respondendo; o deploy fica saudável |
| 3 | `Consentimento ainda não aceito no app; verificando a cada 15 s` | normal até aceitar no app (`status = aguardando_consentimento`) |
| 4 | `Consentimento confirmado` | aceite lido pela `ponte-api` |
| 5 | `Fila de conversas sincronizada com as conversas existentes` (`enfileiradas`) | `fila_iniciar` ok |
| 6 | `Status da conexão` `conectando` → `aguardando_qr` | QR gravado em `conexao.qr_code`; escaneie pelo app (**WhatsApp → Aparelhos conectados → Conectar um aparelho**) |
| 7 | `Conexão com o WhatsApp encerrada` (`codigo: 515`) | **normal** logo após escanear (reinício pedido pelo WhatsApp) |
| 8 | `Status da conexão` `conectando` → `conectado` | pareado |
| 9 | `Lote de histórico recebido` / `Lote processado` (`recebidas`, `gravadas`, `lotesPendentes`) | histórico chegando e sendo gravado |
| 10 | `Fila de conversas aguardando` (`aguardando_captura`) | a extração espera a captura terminar |
| 11 | `Sincronização do histórico concluída (60 s sem novos lotes)` | `sincronizacao.concluida = true` |
| 12 | `Lote de conversas processado` (`lote`, `processadas`, `falhas`) | extração gradual em andamento |

O heartbeat (`conexao.ultimo_evento_em` a cada 60 s) não gera log.

### Sinais de problema

| Log | Causa provável |
|---|---|
| `Falha ao verificar consentimento` (ou outro `Falha ao...`) com `codigo: nao_autorizado` | `PONTE_TOKEN` diferente do segredo da função |
| `Falha ao verificar consentimento` (ou outro `Falha ao...`) com `codigo: 404` ou `enotfound` | `PONTE_API_URL` errada |
| `ponte-api falhou; tentando de novo` com `codigo: erro_interno`, `timeout` ou `econnrefused` | `ponte-api` instável ou fora; a ponte repete sozinha |
| `Falha ao enviar lote; mantido em memória para nova tentativa` | `ponte-api` fora; nada se perde enquanto o serviço estiver de pé (até 50.000 mensagens) |
| `Fila em memória cheia; mensagens novas descartadas...` | `ponte-api` fora por muito tempo |
| `Falha na inicialização` com `Sem permissão de escrita em /data/auth` | volume montado como root: ajuste a permissão do volume e reinicie |
| `Sem sessão salva; aguardando comando novo_qr` | sessão anterior encerrada; peça um novo QR pelo app |
| `Consentimento revogado no app; desconectando sem apagar sessão nem dados` | aceite removido no app |

## 6. Redeploys

- Um redeploy envia SIGTERM: o log mostra `Encerrando com limpeza` e `status = reiniciando`. Na volta, a sessão do volume é reaproveitada, sem novo QR.
- Mensagens ainda não confirmadas pela `ponte-api` no momento do SIGTERM aparecem em `Mensagens não confirmadas no encerramento` (só contagens).

> Aviso: a conexão usa o WhatsApp Web via Baileys, que não é oficial, e pode causar bloqueio do número.
