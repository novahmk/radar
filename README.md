# radar-ponte

Serviço Node.js + TypeScript que funciona como **ponte somente-leitura** entre o WhatsApp de uma única pessoa e o banco Supabase do app Radar. Ele lê as conversas (histórico e tempo real) e as entrega à Edge Function **`ponte-api`**, que grava em `conversas` e `mensagens`. A ponte **não acessa o banco diretamente** e não tem a chave service role. **Ele nunca envia mensagens**, presença, confirmações de leitura nem nada para o WhatsApp.

> **Aviso:** a conexão usa o WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys), que **não é oficial**. O uso pode violar os termos do WhatsApp e **pode causar bloqueio do número**. Use por sua conta e risco.

## Garantias de privacidade

- Nenhuma função de envio é chamada (verificável com `npm run verificar-envio`).
- Logs contêm apenas contagens, status e códigos de erro — nunca texto, nomes ou telefones.
- Mídia nunca é baixada; grava-se apenas `tem_midia = true`.
- A ponte não tem a `SUPABASE_SERVICE_ROLE_KEY`: ela fica só nos segredos da Edge Function. A ponte guarda apenas o `PONTE_TOKEN`, em variável de ambiente, enviado só no header `Authorization` (nunca logado). Fora de `localhost` a URL precisa ser `https`.
- Corpos de resposta da `ponte-api` nunca vão para os logs; só a ação, o status HTTP e um código curto de erro.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `PONTE_API_URL` | sim | — | URL da Edge Function, ex.: `https://SEU-PROJETO.supabase.co/functions/v1/ponte-api` |
| `PONTE_TOKEN` | sim | — | Segredo compartilhado com a função (mínimo 32 caracteres; gere com `openssl rand -hex 32`) |
| `DATA_DIR` | não | `/data` | Pasta da sessão do WhatsApp (`DATA_DIR/auth`) |
| `LOG_LEVEL` | não | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `PORT` | não | `3000` | Porta do healthcheck |

Se alguma variável obrigatória faltar ou for inválida, o processo sai com código 1 e uma mensagem listando o problema (sem mostrar valores). Veja `.env.example`.

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OWNER_ID` **não são mais usadas**. O dono é definido pela própria função a partir do token. Se ainda estiverem no ambiente, a ponte avisa no log (só os nomes): remova-as.

## Como funciona

1. **Consentimento:** só conecta se `conexao.consentimento_aceito_em` estiver preenchido; senão mantém `status = 'aguardando_consentimento'` e verifica de novo a cada 15 s.
2. **QR:** cada QR novo vira data URL PNG em `conexao.qr_code` (`status = 'aguardando_qr'`). Ao conectar: `status = 'conectado'`, `qr_code = null`.
3. **Reconexão:** quedas comuns reconectam com backoff exponencial (2 s a 60 s, com jitter). Em logout, a sessão é apagada, `status = 'sessao_encerrada'` e o serviço aguarda um comando `novo_qr`.
4. **Sincronização:** histórico completo (`messaging-history.set`) e tempo real (`messages.upsert`) em lotes de 200, cada lote enviado numa única ação `lote` (idempotente). A tabela `sincronizacao` é atualizada a cada lote; `concluida = true` após 60 s sem novos lotes de histórico.
5. **Filtros:** quando `configuracoes.ignorar_grupos = true`, mensagens de grupos (`@g.us`) são **simplesmente puladas** (nada é gravado) — opção mais simples. Telefones em `contatos_ignorados` (recarregados a cada 60 s), broadcasts, status e newsletters também são pulados.
6. **Comandos:** tabela `comandos` lida por **polling a cada 10 s** (`comandos_pendentes`), um por vez:
   - `novo_qr`: se já conectado, marca `erro`; senão reinicia a conexão para gerar novo QR.
   - `reconectar`: fecha e reabre o socket mantendo a sessão.
   - `desconectar`: logout, apaga a sessão, `status = 'desconectado'`, `qr_code = null`.
7. **Heartbeat:** toda gravação em `conexao` carimba `ultimo_evento_em`. Além disso, a cada 60 s a ponte envia só `ultimo_evento_em`, sem mexer no `status`, para o app saber que ela está viva.
8. **Retry:** cada chamada à `ponte-api` tem timeout de 30 s e até 3 tentativas com backoff exponencial e jitter (0,5 s e 1,5 s). Repetem-se só falhas de rede, timeout, 408, 429 e 5xx; outros 4xx falham na hora. Quedas do WhatsApp têm backoff próprio (item 3).
9. **Healthcheck:** `GET /health` → `200 { "status": "ok", "conexao": "<status>" }`. Não há outros endpoints.
10. **SIGTERM:** conclui o lote em andamento, fecha o socket sem logout e grava `status = 'reiniciando'`.

## Extração gradual (fila de conversas)

A ponte separa **captura** de **processamento**:

1. **Captura:** ao parear o QR, o histórico e as mensagens em tempo real são gravados em `conversas` e `mensagens` (como descrito acima).
2. **Fila:** toda conversa individual (não grupo) e não ignorada entra em `fila_conversas` como `pendente`. Conversas já existentes são enfileiradas na inicialização.
3. **Lotes:** com a captura ociosa (sem histórico chegando), a ponte reserva `tamanho_lote` conversas pendentes (`fila_proximos`), da `ultima_mensagem_em` mais recente para a mais antiga, já marcadas `em_processamento`, recalcula `total_mensagens`, `ultima_mensagem_em` e `ultima_mensagem_autor` a partir do banco e marca `processada` com `lote_numero` e `processada_em`. O próximo lote só começa depois de `intervalo_entre_lotes_min`.
4. **Pausa e retomada:** com `extracao_pausada = true` nenhum lote novo começa. Ao reiniciar, conversas em `em_processamento` voltam para `pendente`.
5. **Falhas:** erro numa conversa (em `fila_processada`) não trava o lote; `tentativas` é incrementado e, na 3ª falha, o status vira `erro`.
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

A ponte só conversa com o Supabase por esta função. Ela deve ser implementada no projeto Supabase (por exemplo, pelo Lovable).

### Requisição e resposta

```http
POST {PONTE_API_URL}
Authorization: Bearer {PONTE_TOKEN}
Content-Type: application/json

{ "acao": "<nome>", "dados": { ... } }
```

- **Sucesso:** HTTP `200` com `{ "ok": true, "dados": { ... } }`.
- **Erro:** HTTP não-2xx com `{ "ok": false, "erro": "<codigo>" }`, onde `<codigo>` é curto, em `snake_case` e **sem conteúdo**: `nao_autorizado` (401), `acao_invalida` (400), `dados_invalidos` (422), `erro_interno` (500). A ponte só registra códigos nesse formato.
- A ponte repete falhas de rede, timeout, 408, 429 e 5xx. Por isso, **toda ação precisa ser idempotente**.

### Requisitos da função

- **Autenticação:** publique com `verify_jwt = false` (em `supabase/config.toml`: `[functions.ponte-api]` `verify_jwt = false`), porque o token não é um JWT. Compare o `Bearer` com o segredo `PONTE_TOKEN` em tempo constante e responda `401` se não bater.
- **Dono:** o `owner_id` vem do segredo `PONTE_OWNER_ID` da função (uuid do usuário no Supabase Auth), **nunca** da requisição. Toda leitura e escrita filtra por esse `owner_id`.
- **Banco:** use `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, que já existem no ambiente das Edge Functions. A chave service role fica só no Supabase.
- **Privacidade:** não registre `dados` nem conteúdo de mensagens nos logs da função.
- **Segredos:** `supabase secrets set PONTE_TOKEN=... PONTE_OWNER_ID=...` (o mesmo `PONTE_TOKEN` da ponte).

### Ações

| Categoria | Ação | `dados` enviados | O que a função faz | `dados` da resposta |
|---|---|---|---|---|
| estado | `estado` | `{}` | Lê `conexao` (`status`, `consentimento_aceito_em`), `configuracoes` (`ignorar_grupos`, `tamanho_lote`, `intervalo_entre_lotes_min`, `extracao_pausada`; colunas ausentes podem ser omitidas), os `telefone` de `contatos_ignorados` e `sincronizacao.mensagens_recebidas`. | `{ conexao: {status, consentimento_aceito_em} \| null, configuracoes: {...} \| null, contatos_ignorados: string[], sincronizacao: {mensagens_recebidas} \| null }` |
| conexão | `conexao` | qualquer subconjunto de `{ status, qr_code, qr_atualizado_em, conectado_em }` + sempre `ultimo_evento_em` | Upsert em `conexao` por `owner_id` **só com os campos enviados** (lista permitida acima; chave presente com `null` grava `null`). Só com `ultimo_evento_em` é o heartbeat. | `{}` |
| estado | `historico` | `{ concluida: boolean }` | Upsert de `sincronizacao.concluida` por `owner_id`. | `{}` |
| lotes | `lote` | `{ conversas: [{ jid, eh_grupo, telefone?, nome_contato? }], mensagens: [{ jid, id_externo, autor: 'eu'\|'contato', enviada_em, texto, tem_midia }], mensagens_recebidas: number }` | 1) Upsert em `conversas` por `(owner_id, jid)` com `origem = 'whatsapp'`; `telefone` e `nome_contato` só são gravados quando vierem (nunca apagar valor existente). 2) Upsert em `mensagens` por `(owner_id, id_externo)`, trocando `jid` pelo `conversa_id`. 3) Para cada conversa do lote, recalcula `total_mensagens`, `ultima_mensagem_em` e `ultima_mensagem_autor` a partir de `mensagens`. 4) Insere em `fila_conversas` (`status = 'pendente'`, `tentativas = 0`; `on conflict (conversa_id) do nothing`) as conversas do lote com `eh_grupo = false` e `ignorada` diferente de `true`. 5) Upsert em `sincronizacao` de `mensagens_recebidas` (valor absoluto enviado), `mensagens_gravadas` e `conversas_gravadas` (contagens do dono) e `ultimo_lote_em = now()`. Listas podem vir vazias (só contadores). | `{}` |
| fila | `fila_iniciar` | `{}` | Volta `em_processamento` → `pendente` e enfileira (como em `lote`, item 4) todas as conversas individuais e não ignoradas que ainda não estão na fila. | `{ ultimo_lote: number, enfileiradas: number }` (`ultimo_lote` = maior `lote_numero`, ou 0) |
| fila | `fila_proximos` | `{ limite: number }` (1 a 50) | Seleciona até `limite` itens `pendente` cuja conversa é individual e não ignorada, ordenados por `conversas.ultima_mensagem_em desc nulls last`, e os marca `em_processamento`. | `{ itens: [{ fila_id, conversa_id, tentativas }] }` |
| fila | `fila_processada` | `{ fila_id, lote_numero }` | Recalcula a conversa do item (como em `lote`, item 3) e marca `status = 'processada'`, `processada_em = now()`, `lote_numero`. | `{}` |
| fila | `fila_falha` | `{ fila_id, tentativas, status: 'pendente'\|'erro' }` | Grava `tentativas` e `status` (valores absolutos) no item. | `{}` |
| fila | `fila_progresso` | `{ lote_atual, proximo_lote_em: string \| null }` | Upsert em `sincronizacao` de `lote_atual`, `proximo_lote_em`, `conversas_total_fila` (total da fila do dono) e `conversas_processadas` (itens `processada`). | `{}` |
| comandos | `comandos_pendentes` | `{}` | Lista `comandos` com `status = 'pendente'`, por `criado_em` crescente. | `{ comandos: [{ id, tipo }] }` |
| comandos | `comando_status` | `{ id, status: 'executado'\|'erro' }` | Atualiza o `status` do comando `id` (do dono). | `{}` |

Correspondência com o acesso direto anterior: leituras de `conexao`/`configuracoes`/`contatos_ignorados`/`sincronizacao` → `estado`; upserts de `conexao` → `conexao`; `sincronizacao.concluida` → `historico`; upserts de `conversas` e `mensagens`, recálculo, enfileiramento e contadores → `lote`; retomada e preenchimento inicial da fila → `fila_iniciar`; seleção e marcação do lote → `fila_proximos`; recálculo e conclusão de cada conversa → `fila_processada`; falhas → `fila_falha`; progresso → `fila_progresso`; Realtime e polling de `comandos` → `comandos_pendentes` (polling de 10 s) e `comando_status`.

## Desenvolvimento local

```bash
npm ci
cp .env.example .env   # preencha os valores
npm run build
set -a; . ./.env; set +a
DATA_DIR=./data npm start
```

## Deploy no Railway

1. Crie um projeto no Railway e um serviço a partir deste repositório (o `railway.json` já define o builder Dockerfile e `restartPolicyType = ON_FAILURE`).
2. Em **Settings → Volumes**, crie um volume montado em **`/data`** (guarda a sessão do WhatsApp entre deploys).
3. Mantenha **exatamente 1 réplica**. Duas instâncias com a mesma sessão derrubam uma à outra.
4. Publique a Edge Function `ponte-api` (veja o contrato acima) com os segredos `PONTE_TOKEN` e `PONTE_OWNER_ID`.
5. Em **Variables**, defina `PONTE_API_URL` e `PONTE_TOKEN` (opcionalmente `LOG_LEVEL`). Remova `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OWNER_ID` se existirem. Não defina `PORT` manualmente se quiser usar a do Railway.
6. Faça o deploy e acompanhe em **Deployments → View logs**. Deve aparecer o healthcheck ouvindo e o status da conexão.
7. No app Radar, aceite o consentimento. O serviço gera o QR e grava em `conexao.qr_code`.
8. No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho** e escaneie o QR exibido no app.
9. Acompanhe o progresso em `sincronizacao` até `concluida = true`.

> A imagem roda como usuário `node` (não root). Se os logs indicarem falta de permissão de escrita em `/data/auth`, o volume foi montado como root: ajuste a permissão do volume no Railway e reinicie.

## Como testar

- `npm run build` — compila sem erros.
- `npm run verificar-envio` — falha se houver qualquer chamada de envio em `src/`.
- `curl localhost:3000/health` — deve devolver `200` com o status da conexão.
- Sem variáveis obrigatórias (ou com `PONTE_API_URL` em `http` fora de localhost), `npm start` deve sair com código 1 e listar o problema.
- Contra a função rodando localmente (`supabase functions serve ponte-api --no-verify-jwt`), use `PONTE_API_URL=http://127.0.0.1:54321/functions/v1/ponte-api`.
- Fluxo completo: aceitar consentimento → QR em `conexao` → escanear → `status = 'conectado'` → linhas em `conversas`/`mensagens` → inserir em `comandos` (`reconectar`, `desconectar`, `novo_qr`) e conferir o `status` do comando.