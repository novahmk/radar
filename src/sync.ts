import { normalizeMessageContent, type WAMessage, type proto } from '@whiskeysockets/baileys';
import { filtros } from './filtros.js';
import { identidades, type Unificacao } from './identidades.js';
import { logger, resumoErro } from './logger.js';
import { backoffComJitter, chamar, erroPermanente, esperarOuParar, lerEstado } from './ponte.js';

const TAMANHO_LOTE = 200;
const OCIOSIDADE_HISTORICO_MS = 60_000;
/** Teto de mensagens mapeadas aguardando confirmação da ponte-api (protege a memória). */
const MAX_MENSAGENS_PENDENTES = 50_000;
/** Recusas definitivas (400/413/422) do mesmo lote antes de descartá-lo, para não travar a fila. */
const MAX_RECUSAS = 3;
const INTERVALO_AVISO_DESCARTE_MS = 60_000;

/** Identidade canônica de uma conversa, resolvida pela camada do WhatsApp. */
export interface ChatResolvido {
  /** Chave estável da conversa (para individuais, veja identidades.ts). */
  jid: string;
  /** Jid como veio na mensagem (pode ser @lid). */
  jidOriginal: string;
  /** Todos os jids conhecidos da conversa (chave, original, telefone, @lid), para procurar nomes. */
  jidsConhecidos: string[];
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

interface MensagemLote {
  jid: string;
  id_externo: string;
  autor: Registro['autor'];
  enviada_em: string;
  texto: string;
  tem_midia: boolean;
}

/** Lote já mapeado, guardado em memória até a ponte-api confirmar a gravação. */
interface LotePendente {
  conversas: Map<string, Record<string, unknown>>;
  mensagens: Map<string, MensagemLote>;
  /** Conversas cujo telefone, ao ser resolvido, está em contatos_ignorados. */
  ignoradas: Set<string>;
  unificar: Unificacao[];
  recebidas: number;
  /** Valor acumulado de mensagens_recebidas no momento do mapeamento (absoluto, idempotente). */
  mensagensRecebidas: number;
  historico: boolean;
  recusas: number;
}

function novoLote(): LotePendente {
  return {
    conversas: new Map(),
    mensagens: new Map(),
    ignoradas: new Set(),
    unificar: [],
    recebidas: 0,
    mensagensRecebidas: 0,
    historico: false,
    recusas: 0,
  };
}

/** Uma linha por jid. Campos opcionais só entram quando têm valor, para não apagar dados já gravados. */
function adicionarRegistro(lote: LotePendente, r: Registro): void {
  const conversa = lote.conversas.get(r.chat.jid) ?? { jid: r.chat.jid, eh_grupo: r.chat.ehGrupo };
  if (r.chat.telefone) conversa.telefone = r.chat.telefone;
  if (r.nome) conversa.nome_contato = r.nome;
  lote.conversas.set(r.chat.jid, conversa);
  lote.mensagens.set(r.id_externo, {
    jid: r.chat.jid,
    id_externo: r.id_externo,
    autor: r.autor,
    enviada_em: r.enviada_em,
    texto: r.texto,
    tem_midia: r.tem_midia,
  });
}

function juntarLotes(destino: LotePendente, origem: LotePendente): void {
  for (const [jid, c] of origem.conversas) destino.conversas.set(jid, { ...destino.conversas.get(jid), ...c });
  for (const [id, m] of origem.mensagens) destino.mensagens.set(id, m);
  for (const j of origem.ignoradas) destino.ignoradas.add(j);
  destino.unificar.push(...origem.unificar);
  destino.recebidas += origem.recebidas;
  destino.mensagensRecebidas = origem.mensagensRecebidas;
  destino.historico ||= origem.historico;
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
  /** Mensagens brutas recebidas do WhatsApp, ainda não mapeadas. */
  private fila: ItemFila[] = [];
  /** Lotes mapeados aguardando confirmação; só saem daqui depois que a ponte-api confirma. */
  private pendentes: LotePendente[] = [];
  private mensagensPendentes = 0;
  private mapeando = false;
  private enviando = false;
  private emVoo?: LotePendente;
  private envioAtual?: Promise<unknown>;
  private parando = false;
  private resolvedor?: ResolvedorChat;
  private nomes = new Map<string, string>();
  private ignoradasConfirmadas = new Set<string>();

  private mensagensRecebidas = 0;
  private timerHistorico?: NodeJS.Timeout;
  private historicoEmAndamento = false;

  private falhasSeguidas = 0;
  private descartadas = 0;
  private ultimoAvisoDescarte = 0;

  /** Carrega o contador acumulado para continuar somando após reinícios. */
  async iniciar(): Promise<void> {
    this.mensagensRecebidas = (await lerEstado()).mensagensRecebidas;
  }

  definirResolvedor(fn: ResolvedorChat): void {
    this.resolvedor = fn;
  }

  /** true quando não há mensagens na memória (brutas ou aguardando confirmação) nem histórico chegando. */
  capturaOciosa(): boolean {
    return (
      this.fila.length === 0 &&
      this.pendentes.length === 0 &&
      !this.mapeando &&
      !this.enviando &&
      !this.historicoEmAndamento
    );
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
    void this.mapearFila();
  }

  /** Para de aceitar mensagens e espera o envio em andamento terminar (com limite de tempo). */
  async encerrar(limiteMs: number): Promise<void> {
    this.parando = true;
    if (this.timerHistorico) clearTimeout(this.timerHistorico);
    if (this.envioAtual) {
      await Promise.race([this.envioAtual.catch(() => undefined), new Promise((r) => setTimeout(r, limiteMs))]);
    }
    if (this.fila.length > 0 || this.pendentes.length > 0) {
      logger.warn(
        { naFila: this.fila.length, lotesPendentes: this.pendentes.length, mensagensPendentes: this.mensagensPendentes },
        'Mensagens não confirmadas no encerramento',
      );
    }
  }

  /** Etapa 1: transforma mensagens brutas em lotes compactos (só dados locais, sem rede). */
  private async mapearFila(): Promise<void> {
    if (this.mapeando) return;
    this.mapeando = true;
    try {
      while (this.fila.length > 0 && !this.parando) {
        const bruto = this.fila.splice(0, TAMANHO_LOTE);
        this.adicionarPendente(await this.mapearLote(bruto));
        void this.enviarPendentes();
      }
    } finally {
      this.mapeando = false;
    }
  }

  private async mapearLote(bruto: ItemFila[]): Promise<LotePendente> {
    const lote = novoLote();
    for (const { msg, historico } of bruto) {
      if (historico) lote.historico = true;
      try {
        const r = await this.mapear(msg);
        if (!r) continue;
        if ('ignorada' in r) {
          if (!this.ignoradasConfirmadas.has(r.ignorada)) lote.ignoradas.add(r.ignorada);
          continue;
        }
        adicionarRegistro(lote, r);
      } catch (erro) {
        logger.warn(resumoErro(erro), 'Mensagem ignorada por erro de mapeamento');
      }
    }
    this.mensagensRecebidas += bruto.length;
    lote.recebidas = bruto.length;
    lote.mensagensRecebidas = this.mensagensRecebidas;
    // Unificações vão no lote mapeado logo depois delas, então chegam depois das mensagens com a chave antiga.
    lote.unificar = identidades.tomarNovas();
    return lote;
  }

  private adicionarPendente(lote: LotePendente): void {
    const n = lote.mensagens.size;
    if (n > 0 && this.mensagensPendentes + n > MAX_MENSAGENS_PENDENTES) {
      this.descartadas += n;
      identidades.devolver(lote.unificar);
      this.avisarDescarte();
      return;
    }
    // Junta lotes pequenos (comum em tempo real com a ponte-api fora) enquanto couberem em um lote.
    const cauda = this.pendentes.at(-1);
    if (cauda && cauda !== this.emVoo && cauda.mensagens.size + n <= TAMANHO_LOTE) {
      const antes = cauda.mensagens.size;
      juntarLotes(cauda, lote);
      this.mensagensPendentes += cauda.mensagens.size - antes;
    } else {
      this.pendentes.push(lote);
      this.mensagensPendentes += n;
    }
  }

  private avisarDescarte(): void {
    const agora = Date.now();
    if (agora - this.ultimoAvisoDescarte < INTERVALO_AVISO_DESCARTE_MS) return;
    this.ultimoAvisoDescarte = agora;
    logger.warn(
      { descartadas: this.descartadas, mensagensPendentes: this.mensagensPendentes, limite: MAX_MENSAGENS_PENDENTES },
      'Fila em memória cheia; mensagens novas descartadas até a ponte-api voltar',
    );
  }

  /** Etapa 2: envia o lote mais antigo; em falha mantém o lote e tenta de novo com backoff (2 s a 60 s). */
  private async enviarPendentes(): Promise<void> {
    if (this.enviando) return;
    this.enviando = true;
    try {
      while (this.pendentes.length > 0 && !this.parando) {
        const lote = this.pendentes[0]!;
        let esperaMs = 0;
        this.emVoo = lote;
        try {
          this.envioAtual = chamar('lote', {
            conversas: [...lote.conversas.values()],
            mensagens: [...lote.mensagens.values()],
            conversas_ignoradas: [...lote.ignoradas],
            unificar: lote.unificar,
            mensagens_recebidas: lote.mensagensRecebidas,
          });
          await this.envioAtual;
          this.confirmar(lote);
        } catch (erro) {
          esperaMs = this.registrarFalhaEnvio(lote, erro);
        } finally {
          this.emVoo = undefined;
          this.envioAtual = undefined;
        }
        if (esperaMs > 0) await esperarOuParar(esperaMs, () => this.parando);
      }
    } finally {
      this.enviando = false;
    }
  }

  private removerCabeca(lote: LotePendente): void {
    if (this.pendentes[0] !== lote) return;
    this.pendentes.shift();
    this.mensagensPendentes -= lote.mensagens.size;
  }

  private confirmar(lote: LotePendente): void {
    this.removerCabeca(lote);
    identidades.confirmar(lote.unificar);
    for (const j of lote.ignoradas) this.ignoradasConfirmadas.add(j);
    if (this.falhasSeguidas > 0) {
      logger.info({ falhasSeguidas: this.falhasSeguidas, lotesPendentes: this.pendentes.length }, 'Envio de lotes restabelecido');
    }
    this.falhasSeguidas = 0;
    logger.info(
      {
        recebidas: lote.recebidas,
        gravadas: lote.mensagens.size,
        historico: lote.historico,
        naFila: this.fila.length,
        lotesPendentes: this.pendentes.length,
      },
      'Lote processado',
    );
    if (lote.historico) this.rearmarTimerHistorico();
  }

  /** Retorna quanto esperar antes da próxima tentativa (0 = seguir já). */
  private registrarFalhaEnvio(lote: LotePendente, erro: unknown): number {
    if (erroPermanente(erro)) {
      lote.recusas++;
      if (lote.recusas >= MAX_RECUSAS) {
        this.removerCabeca(lote);
        identidades.devolver(lote.unificar);
        this.falhasSeguidas = 0;
        logger.error(
          { mensagens: lote.mensagens.size, recusas: lote.recusas, ...resumoErro(erro) },
          'ponte-api recusou o mesmo lote repetidamente; lote descartado',
        );
        return 0;
      }
    }
    this.falhasSeguidas++;
    const esperaMs = backoffComJitter(this.falhasSeguidas);
    logger.warn(
      {
        tentativa: this.falhasSeguidas,
        esperaMs,
        lotesPendentes: this.pendentes.length,
        mensagensPendentes: this.mensagensPendentes,
        ...resumoErro(erro),
      },
      'Falha ao enviar lote; mantido em memória para nova tentativa',
    );
    return esperaMs;
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
    if (this.fila.some((i) => i.historico) || this.pendentes.some((l) => l.historico)) {
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

  private async mapear(m: WAMessage): Promise<Registro | { ignorada: string } | null> {
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
    // Reaplicado a cada mensagem: um @lid gravado antes de ter telefone é marcado como ignorado quando o telefone aparece.
    if (filtros.telefoneIgnorado(chat.telefone)) return { ignorada: chat.jid };

    const fromMe = Boolean(m.key.fromMe);
    let nome: string | undefined;
    for (const j of chat.jidsConhecidos) {
      nome = this.nomes.get(j);
      if (nome) break;
    }
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
}

export const sincronizador = new Sincronizador();
