# radar-ponte

Serviço Node.js + TypeScript que funciona como **ponte somente-leitura** entre o WhatsApp de uma única pessoa e o banco Supabase do app Radar. Ele lê as conversas (histórico e tempo real) e grava em `conversas` e `mensagens`. **Ele nunca envia mensagens**, presença, confirmações de leitura nem nada para o WhatsApp.

> **Aviso:** a conexão usa o WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys), que **não é oficial**. O uso pode violar os termos do WhatsApp e **pode causar bloqueio do número**. Use por sua conta e risco.

## Garantias de privacidade

- Nenhuma função de envio é chamada (verificável com `npm run verificar-envio`).
- Logs contêm apenas contagens, status e códigos de erro — nunca texto, nomes ou telefones.
- Mídia nunca é baixada; grava-se apenas `tem_midia = true`.
- A `SUPABASE_SERVICE_ROLE_KEY` só existe em variável de ambiente.

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `SUPABASE_URL` | sim | — | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | sim | — | Chave service role (secreta) |
| `OWNER_ID` | sim | — | uuid do usuário no Supabase Auth; todas as linhas levam esse `owner_id` |
| `DATA_DIR` | não | `/data` | Pasta da sessão do WhatsApp (`DATA_DIR/auth`) |
| `LOG_LEVEL` | não | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `PORT` | não | `3000` | Porta do healthcheck |

Se alguma variável obrigatória faltar ou for inválida, o processo sai com código 1 e uma mensagem listando o problema (sem mostrar valores). Veja `.env.example`.

## Como funciona

1. **Consentimento:** só conecta se `conexao.consentimento_aceito_em` estiver preenchido; senão mantém `status = 'aguardando_consentimento'` e verifica de novo a cada 15 s.
2. **QR:** cada QR novo vira data URL PNG em `conexao.qr_code` (`status = 'aguardando_qr'`). Ao conectar: `status = 'conectado'`, `qr_code = null`.
3. **Reconexão:** quedas comuns reconectam com backoff exponencial (2 s a 60 s, com jitter). Em logout, a sessão é apagada, `status = 'sessao_encerrada'` e o serviço aguarda um comando `novo_qr`.
4. **Sincronização:** histórico completo (`messaging-history.set`) e tempo real (`messages.upsert`) em lotes de 200, com upsert idempotente. A tabela `sincronizacao` é atualizada a cada lote; `concluida = true` após 60 s sem novos lotes de histórico.
5. **Filtros:** quando `configuracoes.ignorar_grupos = true`, mensagens de grupos (`@g.us`) são **simplesmente puladas** (nada é gravado) — opção mais simples. Telefones em `contatos_ignorados` (recarregados a cada 60 s), broadcasts, status e newsletters também são pulados.
6. **Comandos:** tabela `comandos` via Realtime + polling a cada 10 s, um por vez:
   - `novo_qr`: se já conectado, marca `erro`; senão reinicia a conexão para gerar novo QR.
   - `reconectar`: fecha e reabre o socket mantendo a sessão.
   - `desconectar`: logout, apaga a sessão, `status = 'desconectado'`, `qr_code = null`.
7. **Healthcheck:** `GET /health` → `200 { "status": "ok", "conexao": "<status>" }`. Não há outros endpoints.
8. **SIGTERM:** conclui o lote em andamento, fecha o socket sem logout e grava `status = 'reiniciando'`.

## Extração gradual (fila de conversas)

A ponte separa **captura** de **processamento**:

1. **Captura:** ao parear o QR, o histórico e as mensagens em tempo real são gravados em `conversas` e `mensagens` (como descrito acima).
2. **Fila:** toda conversa individual (não grupo) e não ignorada entra em `fila_conversas` como `pendente`. Conversas já existentes são enfileiradas na inicialização.
3. **Lotes:** com a captura ociosa (sem histórico chegando), a ponte pega `tamanho_lote` conversas pendentes, da `ultima_mensagem_em` mais recente para a mais antiga, marca `em_processamento`, recalcula `total_mensagens`, `ultima_mensagem_em` e `ultima_mensagem_autor` a partir do banco e marca `processada` com `lote_numero` e `processada_em`. O próximo lote só começa depois de `intervalo_entre_lotes_min`.
4. **Pausa e retomada:** com `extracao_pausada = true` nenhum lote novo começa. Ao reiniciar, conversas em `em_processamento` voltam para `pendente`.
5. **Falhas:** erro numa conversa não trava o lote; `tentativas` é incrementado e, na 3ª falha, o status vira `erro`.
6. **Progresso:** `sincronizacao` recebe `conversas_total_fila`, `conversas_processadas`, `lote_atual` e `proximo_lote_em`.

> "Garantir que as mensagens estão gravadas" significa esperar a captura terminar antes de processar. A ponte **não** pede histórico adicional ao celular, porque isso exigiria enviar uma solicitação ao WhatsApp.

### Schema necessário

A tabela `fila_conversas` está em [supabase/migrations/20261014000000_fila_conversas.sql](supabase/migrations/20261014000000_fila_conversas.sql) (aplique pelo Lovable ou pelo SQL Editor; a ponte não executa DDL). Ela assume `conversas.id` do tipo `uuid` e precisa da chave estrangeira `conversa_id → conversas.id`, usada para ordenar a fila.

As colunas abaixo são **criadas pelo Lovable**; a ponte apenas lê e escreve nelas:

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
4. Em **Variables**, defina `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `OWNER_ID` (opcionalmente `LOG_LEVEL`). Não defina `PORT` manualmente se quiser usar a do Railway.
5. Faça o deploy e acompanhe em **Deployments → View logs**. Deve aparecer o healthcheck ouvindo e o status da conexão.
6. No app Radar, aceite o consentimento. O serviço gera o QR e grava em `conexao.qr_code`.
7. No celular: **WhatsApp → Aparelhos conectados → Conectar um aparelho** e escaneie o QR exibido no app.
8. Acompanhe o progresso em `sincronizacao` até `concluida = true`.

> A imagem roda como usuário `node` (não root). Se os logs indicarem falta de permissão de escrita em `/data/auth`, o volume foi montado como root: ajuste a permissão do volume no Railway e reinicie.

## Como testar

- `npm run build` — compila sem erros.
- `npm run verificar-envio` — falha se houver qualquer chamada de envio em `src/`.
- `curl localhost:3000/health` — deve devolver `200` com o status da conexão.
- Sem variáveis obrigatórias, `npm start` deve sair com código 1 e listar o que falta.
- Fluxo completo: aceitar consentimento → QR em `conexao` → escanear → `status = 'conectado'` → linhas em `conversas`/`mensagens` → inserir em `comandos` (`reconectar`, `desconectar`, `novo_qr`) e conferir o `status` do comando.