import { normalizeMessageContent, type WAMessage, type proto } from '@whiskeysockets/baileys';
import { filtros } from './filtros.js';
import { logger, resumoErro } from './logger.js';
import { chamar, lerEstado } from './ponte.js';

const TAMANHO_LOTE = 200;
const OCIOSIDADE_HISTORICO_MS = 60_000;

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

  /** Carrega o contador acumulado para continuar somando após reinícios. */
  async iniciar(): Promise<void> {
    this.mensagensRecebidas = (await lerEstado()).mensagensRecebidas;
  }

  definirResolvedor(fn: ResolvedorChat): void {
    this.resolvedor = fn;
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
      await chamar('historico', { concluida: false });
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
      await chamar('historico', { concluida: true });
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
    const recebidas = this.mensagensRecebidas + lote.length;

    // Uma única ação idempotente: upsert de conversas e mensagens, recálculo, fila e contadores ficam no servidor.
    await chamar('lote', {
      conversas: this.conversasDoLote(registros),
      mensagens: registros.map((r) => ({
        jid: r.chat.jid,
        id_externo: r.id_externo,
        autor: r.autor,
        enviada_em: r.enviada_em,
        texto: r.texto,
        tem_midia: r.tem_midia,
      })),
      mensagens_recebidas: recebidas,
    });
    this.mensagensRecebidas = recebidas;
    logger.info(
      { recebidas: lote.length, gravadas: registros.length, historico: lote.some((i) => i.historico), naFila: this.fila.length },
      'Lote processado',
    );
  }

  /** Uma linha por jid. Campos opcionais só vão quando têm valor, para não apagar dados já gravados. */
  private conversasDoLote(registros: Registro[]): Record<string, unknown>[] {
    const porJid = new Map<string, Record<string, unknown>>();
    for (const r of registros) {
      const atual = porJid.get(r.chat.jid) ?? { jid: r.chat.jid, eh_grupo: r.chat.ehGrupo };
      if (r.chat.telefone) atual.telefone = r.chat.telefone;
      if (r.nome) atual.nome_contato = r.nome;
      porJid.set(r.chat.jid, atual);
    }
    return [...porJid.values()];
  }
}

export const sincronizador = new Sincronizador();
