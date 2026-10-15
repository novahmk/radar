# Contrato da Edge Function `ponte-api`

A radar-ponte não acessa o banco diretamente: toda leitura e escrita passa por esta Edge Function do projeto Supabase. Este documento lista **todas** as ações que a ponte chama, o que ela envia, o que espera receber e como trata cada erro.

## 1. Transporte

```http
POST {PONTE_API_URL}
Authorization: Bearer {PONTE_TOKEN}
Content-Type: application/json
Accept: application/json

{ "acao": "<nome>", "dados": { ... } }
```

| Situação | HTTP | Corpo |
|---|---|---|
| Sucesso | `200` | `{ "ok": true, "dados": { ... } }` (`dados` pode ser `{}`) |
| Erro | não-2xx | `{ "ok": false, "erro": "<codigo>" }` |

`<codigo>` deve ser curto, em `snake_case` (`^[a-z0-9_]{1,40}$`) e **sem conteúdo** (nada de texto de mensagem, nome ou telefone). A ponte descarta qualquer outro formato antes de logar. Um `200` sem `"ok": true` é tratado como erro repetível.

### Códigos de erro

| HTTP | `erro` | Quando | Como a ponte trata |
|---|---|---|---|
| 401 / 403 | `nao_autorizado` | `Bearer` ausente ou diferente do segredo `PONTE_TOKEN` | Não repete na hora; lotes de captura ficam em memória e são reenviados com backoff (2 s a 60 s). `npm run check` mostra "token errado". |
| 404 | (qualquer) | URL errada ou função não publicada | Igual ao 401. `npm run check` mostra "URL errada ou ação inexistente". |
| 400 | `acao_invalida` | `acao` desconhecida | Recusa definitiva (ver abaixo). `npm run check` mostra "ação inexistente". |
| 400 / 422 | `dados_invalidos` | `dados` fora do formato | **Recusa definitiva:** um lote recusado 3 vezes é descartado (log só com contagens); `fila_falha` desiste; as demais ações tentam de novo no próximo ciclo. |
| 413 | (qualquer) | Corpo grande demais | Recusa definitiva. |
| 408 / 429 | (qualquer) | Timeout ou limite de taxa | Repetido. |
| 5xx | `erro_interno` | Falha no banco ou na função | Repetido. |
| — | — | Sem resposta em 30 s ou falha de rede | Repetido. `npm run check` mostra "timeout: serviço fora". |

**Retentativas:** cada chamada tem timeout de 30 s e até 3 tentativas rápidas (0,5 s e 1,5 s, com jitter) para rede, timeout, 408, 429 e 5xx. Por cima disso, `lote`, `fila_iniciar`, `fila_falha` e `comando_status` têm retentativa longa (detalhes em cada ação). **Toda ação precisa ser idempotente**: a mesma requisição pode chegar mais de uma vez.

## 2. Requisitos da função

- **Autenticação:** publique com `verify_jwt = false` (em `supabase/config.toml`: `[functions.ponte-api]` → `verify_jwt = false`), porque o token não é JWT. Compare o `Bearer` com o segredo `PONTE_TOKEN` em **tempo constante**.
- **Dono:** o `owner_id` vem do segredo `PONTE_OWNER_ID` (uuid do usuário no Supabase Auth), **nunca** da requisição. Toda leitura e escrita filtra por esse `owner_id`.
- **Banco:** use `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, já presentes no ambiente das Edge Functions. A chave service role fica só no Supabase.
- **Privacidade:** não registre `dados` nem respostas nos logs da função.
- **Segredos:** `supabase secrets set PONTE_TOKEN=<o mesmo da ponte> PONTE_OWNER_ID=<uuid>`.

Tipos: data/hora = `string` ISO 8601 em UTC (ex.: `2026-10-15T14:00:00.000Z`). `jid` = identificador do WhatsApp já normalizado (`5511999990000@s.whatsapp.net`, `123456789@lid` ou `...@g.us`). Em conversas individuais, `jid` é a **chave estável** da conversa (veja "Conversas @lid" no README): pode ser um `@lid` com `telefone` preenchido depois.

## 3. Ações

### 3.1 `estado` (leitura)

Usada no início, no consentimento (a cada 15 s, inclusive depois de conectado), nos filtros (a cada 60 s), na configuração da fila (a cada ciclo) e no `npm run check`.

**Envia:** `{}`

**Resposta (`dados`):**

| Campo | Tipo | Origem |
|---|---|---|
| `conexao` | `{ status: string \| null, consentimento_aceito_em: string \| null } \| null` | linha de `conexao` do dono |
| `configuracoes` | `{ ignorar_grupos?: boolean, tamanho_lote?: number, intervalo_entre_lotes_min?: number, extracao_pausada?: boolean } \| null` | linha de `configuracoes` (colunas inexistentes podem ser omitidas; a ponte usa 5, 10 min e `false`) |
| `contatos_ignorados` | `string[]` | coluna `telefone` de `contatos_ignorados` (qualquer formato; a ponte compara só os dígitos) |
| `sincronizacao` | `{ mensagens_recebidas: number \| null } \| null` | linha de `sincronizacao` |

`consentimento_aceito_em = null` depois de conectado = consentimento revogado: a ponte desconecta sem logout e sem apagar nada até ele voltar.

### 3.2 `conexao` (escrita)

Mudanças de status, QR e heartbeat a cada 60 s.

**Envia:** qualquer subconjunto de

| Campo | Tipo |
|---|---|
| `status` | `'aguardando_consentimento' \| 'conectando' \| 'aguardando_qr' \| 'conectado' \| 'reconectando' \| 'desconectado' \| 'erro' \| 'sessao_encerrada' \| 'reiniciando'` |
| `qr_code` | `string \| null` (data URL PNG) |
| `qr_atualizado_em` | `string \| null` |
| `conectado_em` | `string \| null` |
| `ultimo_evento_em` | `string` (**sempre enviado**) |

**Função:** upsert em `conexao` por `owner_id` **só com os campos presentes** (lista permitida acima; chave presente com `null` grava `null`). Só com `ultimo_evento_em` = heartbeat.

**Resposta:** `{}`

### 3.3 `historico` (escrita)

**Envia:** `{ concluida: boolean }`

**Função:** upsert de `sincronizacao.concluida` por `owner_id`.

**Resposta:** `{}`

### 3.4 `lote` (escrita, captura)

Enviado a cada lote de até 200 mensagens. Se falhar, a ponte **guarda o lote em memória** e reenvia com backoff (2 s a 60 s) até confirmar, enquanto o serviço estiver vivo, com teto de 50.000 mensagens pendentes. Lotes pequenos acumulados durante a falha podem chegar juntos (até 200 mensagens).

**Envia:**

| Campo | Tipo | Descrição |
|---|---|---|
| `conversas` | `{ jid: string, eh_grupo: boolean, telefone?: string, nome_contato?: string }[]` | uma por `jid`; `telefone` (só dígitos) e `nome_contato` só vêm quando conhecidos |
| `mensagens` | `{ jid: string, id_externo: string, autor: 'eu' \| 'contato', enviada_em: string, texto: string, tem_midia: boolean }[]` | `id_externo` = `<jid>:<id da mensagem>`; mídia nunca é enviada, só `tem_midia` e a legenda em `texto` |
| `conversas_ignoradas` | `string[]` | jids de conversas cujo telefone, ao ser resolvido, está em `contatos_ignorados` |
| `unificar` | `{ jid_de: string, jid_para: string }[]` | a mesma pessoa ganhou duas conversas (`@lid` e telefone) antes de o par ser conhecido |
| `mensagens_recebidas` | `number` | total acumulado (valor absoluto) |

**Função, nesta ordem:**

1. Upsert em `conversas` por `(owner_id, jid)` com `origem = 'whatsapp'`. `telefone` e `nome_contato` só são gravados quando vierem; **nunca** apagar valor existente.
2. Upsert em `mensagens` por `(owner_id, id_externo)`, trocando `jid` pelo `conversa_id`.
3. Para cada item de `unificar` (se a conversa `jid_de` existir): se `jid_para` não existir, apenas renomear `jid_de` para `jid_para` (e o prefixo de `id_externo`); senão mover as mensagens para `jid_para` trocando o prefixo `jid_de:` por `jid_para:` em `id_externo` (em conflito, manter a de `jid_para` e apagar a outra), copiar `telefone`/`nome_contato` que faltarem, remover o item de `fila_conversas` de `jid_de` e apagar a conversa `jid_de`. Precisa vir **depois** dos passos 1 e 2, porque o mesmo lote pode trazer mensagens com a chave antiga.
4. Recalcular `total_mensagens`, `ultima_mensagem_em` e `ultima_mensagem_autor` das conversas tocadas (incluindo cada `jid_para`).
5. `update conversas set ignorada = true` onde `jid` está em `conversas_ignoradas` (só as que já existem; nunca criar).
6. Inserir em `fila_conversas` (`status = 'pendente'`, `tentativas = 0`, `on conflict (conversa_id) do nothing`) as conversas do lote com `eh_grupo = false` e `ignorada` diferente de `true`.
7. Upsert em `sincronizacao`: `mensagens_recebidas` (valor enviado), `mensagens_gravadas` e `conversas_gravadas` (contagens do dono) e `ultimo_lote_em = now()`.

Listas podem vir vazias (só contadores). **Resposta:** `{}`

### 3.5 `fila_iniciar`

Chamada ao iniciar; se falhar, a ponte repete com backoff (2 s a 60 s) até conseguir, sem bloquear a captura.

**Envia:** `{}`

**Função:** volta itens `em_processamento` para `pendente` e enfileira (como no passo 6 de `lote`) todas as conversas individuais e não ignoradas que ainda não estão na fila.

**Resposta:** `{ ultimo_lote: number, enfileiradas: number }` (`ultimo_lote` = maior `lote_numero` já usado, ou `0`).

### 3.6 `fila_proximos`

**Envia:** `{ limite: number }` (inteiro de 1 a 50)

**Função:** seleciona até `limite` itens `pendente` cuja conversa é individual e não ignorada, por `conversas.ultima_mensagem_em desc nulls last`, e os marca `em_processamento`.

**Resposta:** `{ itens: { fila_id: string, conversa_id: string, tentativas: number }[] }`

### 3.7 `fila_processada`

**Envia:** `{ fila_id: string, lote_numero: number }`

**Função:** recalcula a conversa do item (como no passo 4 de `lote`) e marca `status = 'processada'`, `processada_em = now()` e `lote_numero`.

**Resposta:** `{}`. Qualquer erro conta como falha do item (ver `fila_falha`).

### 3.8 `fila_falha`

**Envia:** `{ fila_id: string, tentativas: number, status: 'pendente' | 'erro' }` (valores absolutos; `erro` na 3ª tentativa)

**Função:** grava `tentativas` e `status` no item.

**Resposta:** `{}`. Se falhar, a ponte repete com backoff (2 s a 60 s) até conseguir; desiste só em recusa definitiva (400/413/422) ou no encerramento. Nesses casos o item volta a `pendente` no próximo `fila_iniciar`.

### 3.9 `fila_progresso`

**Envia:** `{ lote_atual: number, proximo_lote_em: string | null }`

**Função:** upsert em `sincronizacao` de `lote_atual`, `proximo_lote_em`, `conversas_total_fila` (total da fila do dono) e `conversas_processadas` (itens `processada`).

**Resposta:** `{}`

### 3.10 `comandos_pendentes`

Chamada a cada 10 s (substitui o Realtime).

**Envia:** `{}`

**Função:** lista `comandos` do dono com `status = 'pendente'`, por `criado_em` crescente.

**Resposta:** `{ comandos: { id: string, tipo: 'novo_qr' | 'reconectar' | 'desconectar' | string }[] }`

### 3.11 `comando_status`

**Envia:** `{ id: string, status: 'executado' | 'erro' }`

**Função:** atualiza o `status` do comando `id` do dono.

**Resposta:** `{}`. Se falhar, a ponte **não executa o comando de novo**: guarda o status em memória e o reenvia a cada ciclo de 10 s até confirmar. (Se o serviço reiniciar antes disso, o comando ainda `pendente` é executado de novo; os três comandos toleram isso.)

## 4. Correspondência com o acesso direto anterior

| Operação antiga (supabase-js) | Ação |
|---|---|
| ler `conexao`, `configuracoes`, `contatos_ignorados`, `sincronizacao.mensagens_recebidas` | `estado` |
| upsert em `conexao` | `conexao` |
| upsert de `sincronizacao.concluida` | `historico` |
| upsert de `conversas` e `mensagens`, recálculo, enfileiramento e contadores | `lote` |
| retomada e preenchimento inicial da fila | `fila_iniciar` |
| seleção e marcação do lote | `fila_proximos` |
| recálculo e conclusão de cada conversa | `fila_processada` |
| falha de uma conversa | `fila_falha` |
| progresso da fila | `fila_progresso` |
| Realtime e polling de `comandos` | `comandos_pendentes` (polling de 10 s) |
| status do comando | `comando_status` |
