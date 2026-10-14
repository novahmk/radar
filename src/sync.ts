import { normalizeMessageContent, type WAMessage, type proto } from '@whiskeysockets/baileys';
import { filtros } from './filtros.js';
import { logger, resumoErro } from './logger.js';
import { comRetry, OWNER_ID, supabase } from './supabase.js';

const TAMANHO_LOTE = 200;
const OCIOSIDADE_HISTORICO_MS = 60_000;
const CONCORRENCIA_RECALCULO = 5;

/** Identidade canônica de uma conversa, resolvida pela camada do WhatsApp. */
export interface ChatResolvido {
  jid: string;
  /** Jid original (pode ser @lid) para procurar nomes. */
  jidOriginal: string;
  telefone: string | null;
  ehGrupo: boolean;
  /** true para status@broadcast, listas de transmissão e newsletters. */
  descartar: boolean;
}

export type ResolvedorChat = (jid: string, jidAlternativo?: string | null) => Promise<ChatResolvido>;

interface ItemFila {
  msg: WAMessage;
  historico: boolean;
}

interface Registro {
  chat: ChatResolvido;
  id_externo: string;
  autor: 'eu' | 'contato';
  enviada_em: string;
  texto: string;
  tem_midia: boolean;
  nome?: string;
}

type Autor = Registro['autor'];

/** Extrai texto e indicador de mídia. Retorna null para tipos que não gravamos (sistema, protocolo, reação etc.). */
function extrairConteudo(m: WAMessage): { texto: string; temMidia: boolean } | null {
  if (m.messageStubType) return null;
  const c: proto.IMessage | undefined = normalizeMessageContent(m.message);
  if (!c) return null;

  const midia =
    c.imageMessage ?? c.videoMessage ?? c.ptvMessage ?? c.audioMessage ?? c.documentMessage ?? c.stickerMessage;
  if (midia) {
    const legenda = 'caption' in midia ? midia.caption : undefined;
    return { texto: legenda ?? '', temMidia: true };
  }
  if (typeof c.conversation === 'string') return { texto: c.conversation, temMidia: false };
  if (c.extendedTextMessage) return { texto: c.extendedTextMessage.text ?? '', temMidia: false };
  return null;
}

function timestampParaIso(ts: WAMessage['messageTimestamp']): string | null {
  if (ts === null || ts === undefined) return null;
  const segundos = typeof ts === 'number' ? ts : Number(ts.toString());
  if (!Number.isFinite(segundos) || segundos <= 0) return null;
  return new Date(segundos * 1000).toISOString();
}

async function emParalelo<T>(itens: T[], limite: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, itens.length) }, async () => {
    while (i < itens.length) await fn(itens[i++]!);
  });
  await Promise.all(trabalhadores);
}

class Sincronizador {
  private fila: ItemFila[] = [];
  private processando = false;
  private parando = false;
  private loteAtual?: Promise<void>;
  private resolvedor?: ResolvedorChat;
  private nomes = new Map<string, string>();

  private mensagensRecebidas = 0;
  private timerHistorico?: NodeJS.Timeout;
  private historicoEmAndamento = false;
  private aoGravarConversas?: (conversaIds: string[]) => Promise<void>;

  /** Carrega o contador acumulado para continuar somando após reinícios. */
  async iniciar(): Promise<void> {
    const { data } = await comRetry('ler_sincronizacao', () =>
      supabase.from('sincronizacao').select('mensagens_recebidas').eq('owner_id', OWNER_ID).maybeSingle(),
    );
    this.mensagensRecebidas = Number((data as { mensagens_recebidas?: number } | null)?.mensagens_recebidas ?? 0);
  }

  definirResolvedor(fn: ResolvedorChat): void {
    this.resolvedor = fn;
  }

  /** Chamado com as conversas individuais gravadas em cada lote (usado pela fila). */
  definirAoGravarConversas(fn: (conversaIds: string[]) => Promise<void>): void {
    this.aoGravarConversas = fn;
  }

  /** true quando não há mensagens na memória nem histórico chegando. */
  capturaOciosa(): boolean {
    return this.fila.length === 0 && !this.processando && !this.historicoEmAndamento;
  }

  /** Guarda nomes vindos de contatos/chats; nunca sobrescreve com vazio. */
  registrarNomes(itens: { ids: (string | null | undefined)[]; nome: string | null | undefined }[]): void {
    for (const { ids, nome } of itens) {
      const limpo = nome?.trim();
      if (!limpo) continue;
      for (const id of ids) if (id) this.nomes.set(id, limpo);
    }
  }

  enfileirar(msgs: WAMessage[], historico: boolean): void {
    if (this.parando || msgs.length === 0) return;
    for (const msg of msgs) this.fila.push({ msg, historico });
    if (historico) void this.marcarInicioHistorico();
    void this.bombear();
  }

  /** Para de aceitar lotes e espera o lote em andamento terminar (com limite de tempo). */
  async encerrar(limiteMs: number): Promise<void> {
    this.parando = true;
    if (this.timerHistorico) clearTimeout(this.timerHistorico);
    if (this.loteAtual) {
      await Promise.race([this.loteAtual.catch(() => undefined), new Promise((r) => setTimeout(r, limiteMs))]);
    }
    if (this.fila.length > 0) logger.warn({ pendentes: this.fila.length }, 'Mensagens na fila não processadas no encerramento');
  }

  private async bombear(): Promise<void> {
    if (this.processando) return;
    this.processando = true;
    try {
      while (this.fila.length > 0 && !this.parando) {
        const lote = this.fila.splice(0, TAMANHO_LOTE);
        this.loteAtual = this.processarLote(lote);
        try {
          await this.loteAtual;
        } catch (erro) {
          // Uma falha de lote não derruba o processo; o upsert idempotente permite regravar depois.
          logger.error({ tamanho: lote.length, ...resumoErro(erro) }, 'Falha ao processar lote');
        } finally {
          this.loteAtual = undefined;
        }
        if (lote.some((i) => i.historico)) this.rearmarTimerHistorico();
      }
    } finally {
      this.processando = false;
    }
  }

  private async marcarInicioHistorico(): Promise<void> {
    this.rearmarTimerHistorico();
    if (this.historicoEmAndamento) return;
    this.historicoEmAndamento = true;
    try {
      await comRetry('sincronizacao_inicio', () =>
        supabase.from('sincronizacao').upsert({ owner_id: OWNER_ID, concluida: false }, { onConflict: 'owner_id' }),
      );
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao marcar início do histórico');
    }
  }

  private rearmarTimerHistorico(): void {
    if (this.timerHistorico) clearTimeout(this.timerHistorico);
    this.timerHistorico = setTimeout(() => void this.concluirHistorico(), OCIOSIDADE_HISTORICO_MS);
  }

  private async concluirHistorico(): Promise<void> {
    if (this.parando) return;
    if (this.fila.some((i) => i.historico)) {
      this.rearmarTimerHistorico();
      return;
    }
    try {
      await comRetry('sincronizacao_concluida', () =>
        supabase.from('sincronizacao').upsert({ owner_id: OWNER_ID, concluida: true }, { onConflict: 'owner_id' }),
      );
      this.historicoEmAndamento = false;
      logger.info('Sincronização do histórico concluída (60 s sem novos lotes)');
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao marcar histórico como concluído');
      this.rearmarTimerHistorico();
    }
  }

  private async mapear(m: WAMessage): Promise<Registro | null> {
    const jidBruto = m.key?.remoteJid;
    const idMsg = m.key?.id;
    if (!jidBruto || !idMsg || !this.resolvedor) return null;

    const conteudo = extrairConteudo(m);
    if (!conteudo) return null;
    const enviadaEm = timestampParaIso(m.messageTimestamp);
    if (!enviadaEm) return null;

    const chat = await this.resolvedor(jidBruto, m.key.remoteJidAlt);
    if (chat.descartar) return null;
    if (chat.ehGrupo && filtros.deveIgnorarGrupos()) return null;
    if (filtros.telefoneIgnorado(chat.telefone)) return null;

    const fromMe = Boolean(m.key.fromMe);
    let nome = this.nomes.get(chat.jid) ?? this.nomes.get(chat.jidOriginal);
    // Em grupos o pushName é de quem escreveu, não do grupo.
    if (!nome && !chat.ehGrupo && !fromMe && m.pushName?.trim()) {
      nome = m.pushName.trim();
      this.nomes.set(chat.jid, nome);
    }

    return {
      chat,
      id_externo: `${chat.jid}:${idMsg}`,
      autor: fromMe ? 'eu' : 'contato',
      enviada_em: enviadaEm,
      texto: conteudo.texto,
      tem_midia: conteudo.temMidia,
      nome,
    };
  }

  private async processarLote(lote: ItemFila[]): Promise<void> {
    const porId = new Map<string, Registro>();
    for (const { msg } of lote) {
      try {
        const r = await this.mapear(msg);
        if (r) porId.set(r.id_externo, r);
      } catch (erro) {
        logger.warn(resumoErro(erro), 'Mensagem ignorada por erro de mapeamento');
      }
    }
    const registros = [...porId.values()];

    if (registros.length > 0) {
      const idsConversas = await this.gravarConversas(registros);
      const linhas = registros.flatMap((r) => {
        const conversaId = idsConversas.get(r.chat.jid);
        if (!conversaId) return [];
        return [
          {
            owner_id: OWNER_ID,
            conversa_id: conversaId,
            id_externo: r.id_externo,
            autor: r.autor,
            enviada_em: r.enviada_em,
            texto: r.texto,
            tem_midia: r.tem_midia,
          },
        ];
      });
      await comRetry('gravar_mensagens', () =>
        supabase.from('mensagens').upsert(linhas, { onConflict: 'owner_id,id_externo' }),
      );
      await this.recalcularConversas([...new Set(linhas.map((l) => l.conversa_id))]);

      const individuais = new Set<string>();
      for (const r of registros) {
        const id = idsConversas.get(r.chat.jid);
        if (id && !r.chat.ehGrupo) individuais.add(id);
      }
      if (this.aoGravarConversas && individuais.size > 0) {
        try {
          await this.aoGravarConversas([...individuais]);
        } catch (erro) {
          // A conversa entra na fila no próximo reinício (backfill).
          logger.error(resumoErro(erro), 'Falha ao enfileirar conversas');
        }
      }
    }

    this.mensagensRecebidas += lote.length;
    await this.atualizarContadores();
    logger.info(
      { recebidas: lote.length, gravadas: registros.length, historico: lote.some((i) => i.historico), naFila: this.fila.length },
      'Lote processado',
    );
  }

  /** Upsert por (owner_id, jid). Campos opcionais só entram quando têm valor, para não apagar dados já gravados. */
  private async gravarConversas(registros: Registro[]): Promise<Map<string, string>> {
    const porJid = new Map<string, Record<string, unknown>>();
    for (const r of registros) {
      const atual = porJid.get(r.chat.jid) ?? {
        owner_id: OWNER_ID,
        jid: r.chat.jid,
        eh_grupo: r.chat.ehGrupo,
        origem: 'whatsapp',
      };
      if (r.chat.telefone) atual.telefone = r.chat.telefone;
      if (r.nome) atual.nome_contato = r.nome;
      porJid.set(r.chat.jid, atual);
    }

    // O upsert em massa exige o mesmo conjunto de colunas em todas as linhas.
    const grupos = new Map<string, Record<string, unknown>[]>();
    for (const linha of porJid.values()) {
      const chave = Object.keys(linha).sort().join(',');
      grupos.set(chave, [...(grupos.get(chave) ?? []), linha]);
    }

    const ids = new Map<string, string>();
    for (const linhas of grupos.values()) {
      const { data } = await comRetry('gravar_conversas', () =>
        supabase.from('conversas').upsert(linhas, { onConflict: 'owner_id,jid' }).select('id, jid'),
      );
      for (const c of (data as { id: string; jid: string }[] | null) ?? []) ids.set(c.jid, c.id);
    }
    return ids;
  }

  /** Recalcula total e última mensagem a partir do banco, o que mantém os números consistentes mesmo com regravações. */
  async recalcularConversas(conversaIds: string[]): Promise<void> {
    await emParalelo(conversaIds, CONCORRENCIA_RECALCULO, async (id) => {
      const [ultima, total] = await Promise.all([
        comRetry('ultima_mensagem', () =>
          supabase
            .from('mensagens')
            .select('enviada_em, autor')
            .eq('owner_id', OWNER_ID)
            .eq('conversa_id', id)
            .order('enviada_em', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ),
        comRetry('total_mensagens', () =>
          supabase
            .from('mensagens')
            .select('id', { count: 'exact', head: true })
            .eq('owner_id', OWNER_ID)
            .eq('conversa_id', id),
        ),
      ]);
      const u = ultima.data as { enviada_em: string; autor: Autor } | null;
      await comRetry('atualizar_conversa', () =>
        supabase
          .from('conversas')
          .update({
            ultima_mensagem_em: u?.enviada_em ?? null,
            ultima_mensagem_autor: u?.autor ?? null,
            total_mensagens: total.count ?? 0,
          })
          .eq('owner_id', OWNER_ID)
          .eq('id', id),
      );
    });
  }

  private async atualizarContadores(): Promise<void> {
    const [msgs, convs] = await Promise.all([
      comRetry('contar_mensagens', () =>
        supabase.from('mensagens').select('id', { count: 'exact', head: true }).eq('owner_id', OWNER_ID),
      ),
      comRetry('contar_conversas', () =>
        supabase.from('conversas').select('id', { count: 'exact', head: true }).eq('owner_id', OWNER_ID),
      ),
    ]);
    await comRetry('atualizar_sincronizacao', () =>
      supabase.from('sincronizacao').upsert(
        {
          owner_id: OWNER_ID,
          mensagens_recebidas: this.mensagensRecebidas,
          mensagens_gravadas: msgs.count ?? 0,
          conversas_gravadas: convs.count ?? 0,
          ultimo_lote_em: new Date().toISOString(),
        },
        { onConflict: 'owner_id' },
      ),
    );
  }
}

export const sincronizador = new Sincronizador();
