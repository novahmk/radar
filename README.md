# radar-ponte

Serviço Node.js + TypeScript que funciona como **ponte somente-leitura** entre o WhatsApp de uma única pessoa e o banco Supabase do app Radar. Ele lê as conversas (histórico e tempo real) e as entrega à Edge Function **`ponte-api`**, que grava em `conversas` e `mensagens`. A ponte **não acessa o banco diretamente** e não tem a chave service role. **Ele nunca envia mensagens**, presença, confirmações de leitura nem nada para o WhatsApp.

> **Aviso:** a conexão usa o WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys), que **não é oficial**. O uso pode violar os termos do WhatsApp e **pode causar bloqueio do número**. Use por sua conta e risco.

## Garantias de privacidade

- Nenhuma função de envio é chamada (verificável com `npm run verificar-envio`).
- Logs contêm apenas contagens, status e códigos de erro — nunca texto, nomes ou telefones.
- Mídia nunca é baixada; grava-se apenas `tem_midia = true`.
- A ponte não tem a `SUPABASE_SERVICE_ROLE_KEY`: ela fica só nos segredos da Edge Function. A ponte guarda apenas o `PONTE_TOKEN`, em variável de ambiente, enviado só no header `Authorization` (nunca logado). Fora de `localhost` a URL precisa ser `https`.
- Corpos de resposta da `ponte-api` nunca vão para os logs; só a ação, o status HTTP e um código curto de erro. A fila de envio em memória também só loga contagens.
- `DATA_DIR` guarda a sessão do WhatsApp (`auth/`) e o mapa de identidades das conversas (`identidades.json`, permissão `600`, com jids e telefones). Os dois têm a mesma sensibilidade e ficam só no volume.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PONTE_API_URL` | sim | — | URL da Edge Function, ex.: `https://SEU-PROJETO.supabase.co/functions/v1/ponte-api` |
| `PONTE_TOKEN` | sim | — | Segredo compartilhado com a função (mínimo 32 caracteres; gere com `openssl rand -hex 32`) |
| `DATA_DIR` | não | `/data` | Pasta da sessão do WhatsApp (`DATA_DIR/auth`) e de `identidades.json` |
| `LOG_LEVEL` | não | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `PORT` | não | `3000` | Porta do healthcheck |

Se alguma variável obrigatória faltar ou for inválida, o processo sai com código 1 e uma mensagem listando o problema (sem mostrar valores). Veja `.env.example`.

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OWNER_ID` **não são mais usadas**. O dono é definido pela própria função a partir do token. Se ainda estiverem no ambiente, a ponte avisa no log (só os nomes): remova-as.

## Como funciona

1. **Consentimento:** só conecta se `conexao.consentimento_aceito_em` estiver preenchido; senão mantém `status = 'aguardando_consentimento'` e verifica de novo a cada 15 s. Depois de conectado, continua relendo a cada 15 s: se o consentimento for **revogado**, fecha a conexão **sem logout e sem apagar nada** (sessão local e dados no banco continuam), grava `status = 'aguardando_consentimento'` e recusa `novo_qr`/`reconectar` até ele voltar. Falha de leitura não conta como revogação.
2. **QR:** cada QR novo vira data URL PNG em `conexao.qr_code` (`status = 'aguardando_qr'`). Ao conectar: `status = 'conectado'`, `qr_code = null`.
3. **Reconexão:** quedas comuns reconectam com backoff exponencial (2 s a 60 s, com jitter). Em logout, a sessão é apagada, `status = 'sessao_encerrada'` e o serviço aguarda um comando `novo_qr`.
4. **Sincronização:** histórico completo (`messaging-history.set`) e tempo real (`messages.upsert`) em lotes de 200, cada lote enviado numa única ação `lote` (idempotente). A tabela `sincronizacao` é atualizada a cada lote; `concluida = true` após 60 s sem novos lotes de histórico.
   - **Lote só sai da memória depois de confirmado.** Se a `ponte-api` falhar, o lote fica numa fila em memória e é reenviado com backoff crescente (2 s, 4 s, 8 s... até 60 s, com jitter) enquanto o serviço estiver vivo. Lotes pequenos que chegam durante a falha são juntados (até 200 mensagens).
   - **Limite de memória:** no máximo 50.000 mensagens aguardando confirmação. Acima disso, mensagens **novas** são descartadas e o log mostra só a contagem (no máximo um aviso por minuto).
   - **Recusa definitiva** (400/413/422): o mesmo lote recusado 3 vezes é descartado, para não travar os seguintes.
   - Um reinício perde o que ainda não foi confirmado (a fila é só em memória); o log do encerramento mostra quantas mensagens ficaram.
5. **Filtros:** quando `configuracoes.ignorar_grupos = true`, mensagens de grupos (`@g.us`) são **simplesmente puladas** (nada é gravado) — opção mais simples. Telefones em `contatos_ignorados` (recarregados a cada 60 s), broadcasts, status e newsletters também são pulados. Uma conversa `@lid` cujo telefone ainda é desconhecido não tem como ser comparada e é gravada; o filtro é reaplicado a cada mensagem e, **quando o telefone é resolvido** e está na lista, a conversa vai em `conversas_ignoradas` e a `ponte-api` marca `ignorada = true` (sai da fila de extração). As mensagens seguintes dela não são gravadas.
6. **Comandos:** tabela `comandos` lida por **polling a cada 10 s** (`comandos_pendentes`), um por vez:
   - `novo_qr`: se já conectado, marca `erro`; senão reinicia a conexão para gerar novo QR.
   - `reconectar`: fecha e reabre o socket mantendo a sessão.
   - `desconectar`: logout, apaga a sessão, `status = 'desconectado'`, `qr_code = null`.
   - Se gravar o status do comando falhar, ele **não é executado de novo**: o status fica em memória e é reenviado a cada ciclo até a `ponte-api` confirmar.
7. **Heartbeat:** toda gravação em `conexao` carimba `ultimo_evento_em`. Além disso, a cada 60 s a ponte envia só `ultimo_evento_em`, sem mexer no `status`, para o app saber que ela está viva.
8. **Retry:** cada chamada à `ponte-api` tem timeout de 30 s e até 3 tentativas com backoff exponencial e jitter (0,5 s e 1,5 s). Repetem-se só falhas de rede, timeout, 408, 429 e 5xx; outros 4xx falham na hora. Por cima disso, `lote`, `fila_iniciar`, `fila_falha` e `comando_status` são retentados por mais tempo (backoff de 2 s a 60 s ou a cada ciclo). Quedas do WhatsApp têm backoff próprio (item 3).
9. **Healthcheck:** `GET /health` → `200 { "status": "ok", "conexao": "<status>" }`. Não há outros endpoints.
10. **SIGTERM:** espera o envio em andamento (até 20 s), grava `identidades.json`, fecha o socket sem logout e grava `status = 'reiniciando'`.

## Conversas `@lid` (chave estável)

O WhatsApp identifica contatos por telefone (`...@s.whatsapp.net`) ou por um id opaco (`...@lid`), e o par entre os dois nem sempre é conhecido na hora. Antes, a mesma pessoa podia virar duas conversas: uma pelo `@lid` (sem telefone) e outra pelo telefone, quando o par aparecia.

**Escolha: manter o jid original como chave e só preencher o telefone depois**, com unificação para o caso raro de duas chaves:

1. Na primeira vez que a conversa aparece, a chave é o jid do telefone, se já conhecido (igual ao comportamento anterior, então dados já gravados continuam válidos), ou o `@lid`.
2. A chave **nunca muda**. Quando o telefone de um `@lid` é descoberto, ele só é registrado como alias e enviado no campo `telefone` da mesma conversa. Mensagens que chegam depois pelo telefone caem na mesma chave `@lid`.
3. Os pares vêm só do que o WhatsApp já entrega: `remoteJidAlt` da mensagem, eventos `lid-mapping.update`, `lidPnMappings` do histórico, contatos e o mapeamento salvo na sessão. A ponte **não** consulta o servidor para descobrir pares (isso seria enviar algo ao WhatsApp).
4. Se a mesma pessoa já tinha ganhado duas chaves antes de o par ser conhecido, a ponte passa a usar uma só (a do telefone) e envia `unificar: [{ jid_de, jid_para }]` no próximo lote; a `ponte-api` junta as conversas e mensagens (veja o contrato). A unificação fica pendente em disco até ser confirmada.
5. O mapa fica em `DATA_DIR/identidades.json`. Se o volume for apagado, a sessão também é, e o pareamento recomeça do zero.

A alternativa (mandar o par `jid_lid`/`jid_telefone` em toda mensagem para a função resolver) foi descartada porque deixaria o `id_externo` dependente de uma decisão do servidor e exigiria unificação a cada lote.

## Extração gradual (fila de conversas)

A ponte separa **captura** de **processamento**:

1. **Captura:** ao parear o QR, o histórico e as mensagens em tempo real são gravados em `conversas` e `mensagens` (como descrito acima).
2. **Fila:** toda conversa individual (não grupo) e não ignorada entra em `fila_conversas` como `pendente`. Conversas já existentes são enfileiradas na inicialização.
3. **Lotes:** com a captura ociosa (sem histórico chegando), a ponte reserva `tamanho_lote` conversas pendentes (`fila_proximos`), da `ultima_mensagem_em` mais recente para a mais antiga, já marcadas `em_processamento`, recalcula `total_mensagens`, `ultima_mensagem_em` e `ultima_mensagem_autor` a partir do banco e marca `processada` com `lote_numero` e `processada_em`. O próximo lote só começa depois de `intervalo_entre_lotes_min`.
4. **Pausa e retomada:** com `extracao_pausada = true` nenhum lote novo começa. Ao reiniciar, conversas em `em_processamento` voltam para `pendente` (`fila_iniciar`). Se `fila_iniciar` falhar, a ponte tenta de novo com backoff (2 s a 60 s) sem bloquear a captura, em vez de esperar o próximo reinício.
5. **Falhas:** erro numa conversa (em `fila_processada`) não trava o lote; `tentativas` é incrementado e, na 3ª falha, o status vira `erro`. Se gravar a falha (`fila_falha`) também falhar, a ponte repete com backoff até conseguir, para o item não ficar preso em `em_processamento`.
6. **Progresso:** `sincronizacao` recebe `conversas_total_fila`, `conversas_processadas`, `lote_atual` e `proximo_lote_em`.

> "Garantir que as mensagens estão gravadas" significa esperar a captura terminar antes de processar. A ponte **não** pede histórico adicional ao celular, porque isso exigiria enviar uma solicitação ao WhatsApp.

### Schema necessário

A tabela `fila_conversas` está em [supabase/migrations/20261014000000_fila_conversas.sql](supabase/migrations/20261014000000_fila_conversas.sql) (aplique pelo Lovable ou pelo SQL Editor; nem a ponte nem a `ponte-api` executam DDL). Ela assume `conversas.id` do tipo `uuid` e precisa da chave estrangeira `conversa_id → conversas.id`, usada para ordenar a fila.

As colunas abaixo são **criadas pelo Lovable**; a `ponte-api` apenas lê e escreve nelas:

| Tabela | Coluna | Tipo sugerido | Uso |
|---|---|---|---|
| `configuracoes` | `tamanho_lote` | `integer default 5` | conversas por lote (1 a 50) |
| `configuracoes` | `intervalo_entre_lotes_min` | `integer default 10` | minutos entre lotes |
| `configuracoes` | `extracao_pausada` | `boolean default false` | pausa novos lotes |
| `sincronizacao` | `conversas_total_fila` | `integer` | total na fila |
| `sincronizacao` | `conversas_processadas` | `integer` | total `processada` |
| `sincronizacao` | `lote_atual` | `integer` | número do último lote iniciado |
| `sincronizacao` | `proximo_lote_em` | `timestamptz` | horário previsto do próximo lote (`null` se pausada ou ociosa) |

Se as colunas de `configuracoes` ainda não existirem, os padrões (5 conversas, 10 min, não pausada) são usados.

## Contrato da Edge Function `ponte-api`

A ponte só conversa com o Supabase por esta função, que deve ser implementada no projeto Supabase (por exemplo, pelo Lovable). O contrato completo, com cada ação, o payload, a resposta e os códigos de erro, está em **[CONTRATO-PONTE-API.md](CONTRATO-PONTE-API.md)**.

Resumo:

- `POST {PONTE_API_URL}` com `Authorization: Bearer {PONTE_TOKEN}` e corpo `{ "acao": "<nome>", "dados": { ... } }`. Sucesso: `200 { "ok": true, "dados": ... }`. Erro: não-2xx `{ "ok": false, "erro": "<codigo>" }`.
- A função é publicada com `verify_jwt = false`, compara o token em tempo constante com o segredo `PONTE_TOKEN` e tira o `owner_id` do segredo `PONTE_OWNER_ID`. A service role fica só no Supabase.
- Toda ação precisa ser idempotente (a ponte repete requisições).

| Categoria | Ações |
|---|---|
| estado | `estado`, `historico` |
| conexão | `conexao` (status, QR e heartbeat) |
| lotes | `lote` (conversas, mensagens, `conversas_ignoradas`, `unificar`, contadores) |
| fila | `fila_iniciar`, `fila_proximos`, `fila_processada`, `fila_falha`, `fila_progresso` |
| comandos | `comandos_pendentes`, `comando_status` |

## Desenvolvimento local

```bash
npm ci
cp .env.example .env   # preencha os valores
npm run build
set -a; . ./.env; set +a
npm run check          # testa as variáveis e a ponte-api
DATA_DIR=./data npm start
```

### `npm run check`

Valida as variáveis e faz uma chamada de leitura (ação `estado`) à `ponte-api`, com uma única tentativa e timeout de 15 s. Imprime `OK` (código 0) ou `FALHA: <motivo>` (código 1). Nunca imprime o token nem dados retornados; mostra só o host.

| Saída | Significado |
|---|---|
| `FALHA: variáveis inválidas` | lista o nome e o motivo de cada variável com problema |
| `FALHA: 401: token errado` | `PONTE_TOKEN` não confere com o segredo da função |
| `FALHA: 404: URL errada ou ação inexistente` | `PONTE_API_URL` errada ou função não publicada |
| `FALHA: 400: ação inexistente na função` | a função não reconhece `estado` |
| `FALHA: timeout: serviço fora` | sem resposta em 15 s |
| `FALHA: econnrefused` / `enotfound` | serviço fora ou host inexistente |
| `FALHA: 5xx: erro interno na função` | erro dentro da função |

Requer `npm run build` antes (usa `dist/check.js`). No container do Railway: `node dist/check.js`.

## Deploy no Railway

Passo a passo detalhado, com as variáveis exatas e o que esperar nos logs: **[DEPLOY-RAILWAY.md](DEPLOY-RAILWAY.md)**.

1. Crie um projeto no Railway e um serviço a partir deste repositório (o `railway.json` já define o builder Dockerfile e `restartPolicyType = ON_FAILURE`).
2. Em **Settings → Volumes**, crie um volume montado em **`/data`** (guarda a sessão do WhatsApp entre deploys).
3. Mantenha **exatamente 1 réplica**. Duas instâncias com a mesma sessão derrubam uma à outra.
4. Publique a Edge Function `ponte-api` (veja [CONTRATO-PONTE-API.md](CONTRATO-PONTE-API.md)) com os segredos `PONTE_TOKEN` e `PONTE_OWNER_ID`. Teste antes com `npm run check` apontando para ela.
5. Em **Variables**, defina `PONTE_API_URL` e `PONTE_TOKEN` (opcionalmente `LOG_LEVEL`). Remova `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OWNER_ID` se existirem. Não defina `PORT` manualmente se quiser usar a do Railway.
6. Faça o deploy e acompanhe em **Deployments → View logs**. Deve aparecer o healthcheck ouvindo e o status da conexão.
7. No app Radar, aceite o consentimento. O serviço gera o QR e grava em `conexao.qr_code`.
8. No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho** e escaneie o QR exibido no app.
9. Acompanhe o progresso em `sincronizacao` até `concluida = true`.

> A imagem roda como usuário `node` (não root). Se os logs indicarem falta de permissão de escrita em `/data/auth`, o volume foi montado como root: ajuste a permissão do volume no Railway e reinicie.

## Como testar

- `npm run build` — compila sem erros.
- `npm run verificar-envio` — falha se houver qualquer chamada de envio em `src/`.
- `npm run check` — testa as variáveis e a conexão com a `ponte-api` (OK/FALHA com o motivo).
- `curl localhost:3000/health` — deve devolver `200` com o status da conexão.
- Sem variáveis obrigatórias (ou com `PONTE_API_URL` em `http` fora de localhost), `npm start` deve sair com código 1 e listar o problema.
- Contra a função rodando localmente (`supabase functions serve ponte-api --no-verify-jwt`), use `PONTE_API_URL=http://127.0.0.1:54321/functions/v1/ponte-api`.
- Fluxo completo: aceitar consentimento → QR em `conexao` → escanear → `status = 'conectado'` → linhas em `conversas`/`mensagens` → inserir em `comandos` (`reconectar`, `desconectar`, `novo_qr`) e conferir o `status` do comando.