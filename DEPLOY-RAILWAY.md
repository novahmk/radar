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

> **Permissão do volume:** o Railway monta volumes como `root`, e a imagem roda como usuário `node`. Sem ajuste, a ponte não consegue gravar em `/data/auth`: o log mostra `Sem permissão de escrita em /data/auth`, o status vai para `erro` e o QR nunca é gerado. Defina **`RAILWAY_RUN_UID=0`** nas variáveis do serviço (solução indicada na [documentação de volumes do Railway](https://docs.railway.com/volumes/reference#caveats)). Com ela o container roda como root.

## 4. Variáveis (Settings → Variables)

| Variável | Valor | Observação |
|---|---|---|
| `PONTE_API_URL` | `https://holo-match-engine.lovable.app/api/public/ponte-api` | exato; precisa ser `https` |
| `PONTE_TOKEN` | *(segredo; mínimo 32 caracteres)* | o mesmo valor configurado como segredo na `ponte-api`. Cole direto no Railway. |
| `DATA_DIR` | `/data` | opcional: já é o padrão no Dockerfile. Precisa ser o caminho do volume. |
| `RAILWAY_RUN_UID` | `0` | necessário para gravar no volume (montado como root); veja a seção 3 |
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
| 3 | `Consentimento lido` (`consentido`, `status`, `linhaConexaoExiste`) | leitura do aceite na `ponte-api` (info quando muda; repetições só em `debug`) |
| 4 | `Consentimento ainda não aceito no app; verificando a cada 15 s` | normal até aceitar no app (`status = aguardando_consentimento`) |
| 5 | `Consentimento confirmado` | aceite lido pela `ponte-api` |
| 6 | `Fila de conversas sincronizada com as conversas existentes` (`enfileiradas`) | `fila_iniciar` ok |
| 7 | `Status da conexão` `conectando` → `Sessão do WhatsApp iniciando` (`sessaoSalva`, `versaoWa`, `versaoMaisRecente`) | pasta `DATA_DIR/auth` validada; socket sendo aberto |
| 8 | `QR gerado` → `Status da conexão` `aguardando_qr` → `QR enviado` | QR gravado em `conexao.qr_code` (só aparece `QR enviado` se a gravação foi confirmada); escaneie pelo app (**WhatsApp → Aparelhos conectados → Conectar um aparelho**) |
| 9 | `Conexão com o WhatsApp encerrada` (`codigo: 515`, `motivo: restartRequired`) | **normal** logo após escanear (reinício pedido pelo WhatsApp) |
| 10 | `Status da conexão` `conectando` → `conectado` | pareado |
| 11 | `Lote de histórico recebido` / `Lote processado` (`recebidas`, `gravadas`, `lotesPendentes`) | histórico chegando e sendo gravado |
| 12 | `Fila de conversas aguardando` (`aguardando_captura`) | a extração espera a captura terminar |
| 13 | `Sincronização do histórico concluída (60 s sem novos lotes)` | `sincronizacao.concluida = true` |
| 14 | `Lote de conversas processado` (`lote`, `processadas`, `falhas`) | extração gradual em andamento |

O heartbeat (`conexao.ultimo_evento_em` a cada 60 s) não gera log.

### Sinais de problema

| Log | Causa provável |
|---|---|
| `Falha ao ler consentimento` (ou outro `Falha ao...`) com `codigo: nao_autorizado` | `PONTE_TOKEN` diferente do segredo da função |
| `Falha ao ler consentimento` (ou outro `Falha ao...`) com `codigo: 404` ou `enotfound` | `PONTE_API_URL` errada |
| `codigo: resposta_invalida` | a `ponte-api` respondeu com corpo vazio ou que não é JSON (URL apontando para outra coisa, ou erro da função) |
| `A ponte-api devolveu conexao = null` | não existe linha em `conexao` para o dono; a ponte trata como sem consentimento e cria a linha ao gravar `aguardando_consentimento` |
| `Falha persistente; tentando de novo com backoff` (`operacao: ler contador de mensagens`) | `ponte-api` fora na subida; a ponte fica tentando (2 s a 60 s) em vez de encerrar |
| `ponte-api falhou; tentando de novo` com `codigo: erro_interno`, `timeout` ou `econnrefused` | `ponte-api` instável ou fora; a ponte repete sozinha |
| `Falha ao enviar lote; mantido em memória para nova tentativa` | `ponte-api` fora; nada se perde enquanto o serviço estiver de pé (até 50.000 mensagens) |
| `Fila em memória cheia; mensagens novas descartadas...` | `ponte-api` fora por muito tempo |
| `detalhe: Sem permissão de escrita em /data/auth` (em `Falha na inicialização`, `Falha ao iniciar a conexão`, `Comando falhou` etc.) e `status = erro` | volume montado como root: defina `RAILWAY_RUN_UID=0` (seção 3) e reinicie |
| `Não foi possível verificar a sessão salva; tratando como inexistente` | `DATA_DIR/auth/creds.json` sem permissão de leitura: mesma causa acima |
| `Não foi possível obter a versão mais recente do WhatsApp Web` | sem acesso ao GitHub; usa a versão embutida no Baileys. Se em seguida a conexão cair sem QR, essa versão pode estar desatualizada |
| `Falha ao enviar QR` | o QR foi gerado mas a `ponte-api` não confirmou; o próximo QR chega em cerca de 20 s |
| `Conexão com o WhatsApp encerrada` repetido com `motivo` `badSession`, `forbidden`, `multideviceMismatch` ou `desconhecido` | sessão salva inválida: o serviço só reconecta e não gera QR. Peça `desconectar` e depois `novo_qr` pelo app |
| `Sem sessão salva; aguardando comando novo_qr` | sessão anterior encerrada; peça um novo QR pelo app |
| `Consentimento revogado no app; desconectando sem apagar sessão nem dados` | aceite removido no app |

## 6. Redeploys

- Um redeploy envia SIGTERM: o log mostra `Encerrando com limpeza` e `status = reiniciando`. Na volta, a sessão do volume é reaproveitada, sem novo QR.
- Mensagens ainda não confirmadas pela `ponte-api` no momento do SIGTERM aparecem em `Mensagens não confirmadas no encerramento` (só contagens).

> Aviso: a conexão usa o WhatsApp Web via Baileys, que não é oficial, e pode causar bloqueio do número.
