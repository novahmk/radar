import { mkdir, access, rm, constants } from 'node:fs/promises';
import path from 'node:path';
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type Contact,
  type ConnectionState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from './config.js';
import { logger, loggerBaileys, resumoErro } from './logger.js';
import { atualizarConexao, type StatusConexao } from './supabase.js';
import { sincronizador, type ChatResolvido } from './sync.js';

const PASTA_AUTH = path.join(config.DATA_DIR, 'auth');
const BACKOFF_INICIAL_MS = 2_000;
const BACKOFF_MAXIMO_MS = 60_000;

export class ErroComando extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroComando';
  }
}

/** Garante que DATA_DIR/auth existe e aceita escrita; falha cedo com mensagem clara. */
async function prepararPastaAuth(): Promise<string> {
  try {
    await mkdir(PASTA_AUTH, { recursive: true, mode: 0o700 });
    await access(PASTA_AUTH, constants.R_OK | constants.W_OK);
  } catch (erro) {
    throw new Error(
      `Sem permissão de escrita em ${PASTA_AUTH}. Verifique o volume montado em DATA_DIR (${resumoErro(erro).codigo ?? 'erro'}).`,
    );
  }
  return PASTA_AUTH;
}

export async function sessaoSalvaExiste(): Promise<boolean> {
  return access(path.join(PASTA_AUTH, 'creds.json')).then(
    () => true,
    () => false,
  );
}

async function apagarSessao(): Promise<void> {
  await rm(PASTA_AUTH, { recursive: true, force: true });
  logger.info('Sessão local do WhatsApp apagada');
}

function nomeDeContato(c: Partial<Contact>): { ids: (string | undefined)[]; nome: string | undefined } {
  const ids = [c.id, c.lid, c.phoneNumber].map((j) => (j ? jidNormalizedUser(j) : undefined));
  return { ids, nome: c.notify || c.name || c.verifiedName };
}

/**
 * Conexão somente-leitura com o WhatsApp Web.
 * Este módulo apenas escuta eventos; não existe nenhum caminho de envio.
 */
class ConexaoWhatsApp {
  private sock?: WASocket;
  /** Incrementa a cada socket novo ou fechamento intencional; eventos de sockets antigos são ignorados. */
  private geracao = 0;
  private tentativas = 0;
  private timerReconexao?: NodeJS.Timeout;
  private statusAtual: StatusConexao = 'desconectado';
  private encerrando = false;

  get status(): StatusConexao {
    return this.statusAtual;
  }

  /** Reflete localmente um status já gravado no banco, sem abrir conexão. */
  definirStatusLocal(status: StatusConexao): void {
    this.statusAtual = status;
  }

  private async definirStatus(status: StatusConexao, extras: Parameters<typeof atualizarConexao>[0] = {}): Promise<void> {
    this.statusAtual = status;
    logger.info({ status }, 'Status da conexão');
    try {
      await atualizarConexao({ status, ...extras });
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao gravar status da conexão');
    }
  }

  async iniciar(): Promise<void> {
    if (this.encerrando) return;
    this.cancelarReconexao();
    const geracao = ++this.geracao;
    await this.definirStatus('conectando');

    const pasta = await prepararPastaAuth();
    const { state, saveCreds } = await useMultiFileAuthState(pasta);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (geracao !== this.geracao || this.encerrando) return;

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys) },
      logger: loggerBaileys,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      // Nunca reenviamos mensagens, então não há conteúdo a fornecer em pedidos de retry.
      getMessage: async () => undefined,
    });
    this.sock = sock;

    const atual = () => geracao === this.geracao;

    sock.ev.on('creds.update', () => void saveCreds().catch((e) => logger.error(resumoErro(e), 'Falha ao salvar credenciais')));

    sock.ev.on('connection.update', (u) => {
      if (atual()) void this.aoAtualizarConexao(u, geracao);
    });

    sock.ev.on('messaging-history.set', ({ messages, contacts, chats, syncType }) => {
      if (!atual()) return;
      sincronizador.registrarNomes(contacts.map(nomeDeContato));
      sincronizador.registrarNomes(chats.map((c) => ({ ids: [c.id ? jidNormalizedUser(c.id) : undefined], nome: c.name })));
      logger.info({ mensagens: messages.length, conversas: chats.length, tipo: syncType ?? null }, 'Lote de histórico recebido');
      sincronizador.enfileirar(messages, true);
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      if (atual()) sincronizador.enfileirar(messages, false);
    });

    sock.ev.on('contacts.upsert', (cs) => sincronizador.registrarNomes(cs.map(nomeDeContato)));
    sock.ev.on('contacts.update', (cs) => sincronizador.registrarNomes(cs.map(nomeDeContato)));
    sock.ev.on('chats.upsert', (chats) =>
      sincronizador.registrarNomes(chats.map((c) => ({ ids: [c.id ? jidNormalizedUser(c.id) : undefined], nome: c.name }))),
    );
    sock.ev.on('groups.upsert', (gs) => sincronizador.registrarNomes(gs.map((g) => ({ ids: [g.id], nome: g.subject }))));
  }

  private async aoAtualizarConexao(u: Partial<ConnectionState>, geracao: number): Promise<void> {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        if (geracao !== this.geracao) return;
        await this.definirStatus('aguardando_qr', { qr_code: dataUrl, qr_atualizado_em: new Date().toISOString() });
      } catch (erro) {
        logger.error(resumoErro(erro), 'Falha ao gerar QR');
      }
    }

    if (connection === 'open') {
      this.tentativas = 0;
      await this.definirStatus('conectado', { conectado_em: new Date().toISOString(), qr_code: null });
      return;
    }

    if (connection === 'close') {
      this.sock = undefined;
      const codigo = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      logger.warn({ codigo: codigo ?? null }, 'Conexão com o WhatsApp encerrada');
      if (this.encerrando) return;

      if (codigo === DisconnectReason.loggedOut) {
        this.geracao++;
        await apagarSessao();
        await this.definirStatus('sessao_encerrada', { qr_code: null });
        logger.info('Aguardando comando novo_qr');
        return;
      }
      if (codigo === DisconnectReason.restartRequired) {
        // Pedido normal do WhatsApp logo após o pareamento.
        await this.iniciarSeguro();
        return;
      }
      await this.agendarReconexao();
    }
  }

  private async iniciarSeguro(): Promise<void> {
    try {
      await this.iniciar();
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao iniciar a conexão');
      await this.definirStatus('erro');
      await this.agendarReconexao();
    }
  }

  private async agendarReconexao(): Promise<void> {
    if (this.encerrando) return;
    this.cancelarReconexao();
    const base = Math.min(BACKOFF_MAXIMO_MS, BACKOFF_INICIAL_MS * 2 ** this.tentativas);
    const atraso = Math.min(BACKOFF_MAXIMO_MS, Math.round(base * (0.75 + Math.random() * 0.5)));
    this.tentativas++;
    logger.info({ tentativa: this.tentativas, atrasoMs: atraso }, 'Reconexão agendada');
    await this.definirStatus('reconectando');
    this.timerReconexao = setTimeout(() => void this.iniciarSeguro(), atraso);
  }

  private cancelarReconexao(): void {
    if (this.timerReconexao) clearTimeout(this.timerReconexao);
    this.timerReconexao = undefined;
  }

  /** Fecha o socket sem logout (a sessão continua salva). */
  private async fecharSocket(): Promise<void> {
    this.geracao++;
    this.cancelarReconexao();
    const s = this.sock;
    this.sock = undefined;
    if (s) {
      try {
        await s.end(undefined);
      } catch (erro) {
        logger.warn(resumoErro(erro), 'Erro ao fechar socket');
      }
    }
  }

  /** Resolve o jid para a identidade canônica da conversa (prefere o telefone quando o jid é @lid). */
  async resolverChat(jid: string, jidAlternativo?: string | null): Promise<ChatResolvido> {
    const base = { telefone: null, ehGrupo: false, descartar: false };
    if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) {
      return { ...base, jid, jidOriginal: jid, descartar: true };
    }
    const original = jidNormalizedUser(jid);
    if (isJidGroup(original)) return { ...base, jid: original, jidOriginal: original, ehGrupo: true };

    let pn: string | undefined;
    if (isPnUser(original)) {
      pn = original;
    } else if (isLidUser(original)) {
      if (jidAlternativo && isPnUser(jidAlternativo)) {
        pn = jidNormalizedUser(jidAlternativo);
      } else {
        const mapeado = await this.sock?.signalRepository.lidMapping.getPNForLID(original).catch(() => null);
        if (mapeado) pn = jidNormalizedUser(mapeado);
      }
    }
    if (pn) return { ...base, jid: pn, jidOriginal: original, telefone: jidDecode(pn)?.user ?? null };
    return { ...base, jid: original, jidOriginal: original };
  }

  // ---- Comandos vindos do app ----

  async novoQr(): Promise<void> {
    if (this.statusAtual === 'conectado') {
      throw new ErroComando('Já conectado: desconecte antes de pedir um novo QR');
    }
    await this.fecharSocket();
    this.tentativas = 0;
    await this.iniciar();
  }

  async reconectar(): Promise<void> {
    await this.fecharSocket();
    this.tentativas = 0;
    await this.iniciar();
  }

  async desconectar(): Promise<void> {
    const s = this.sock;
    const estavaConectado = this.statusAtual === 'conectado';
    this.geracao++;
    this.cancelarReconexao();
    this.sock = undefined;
    if (s) {
      try {
        // logout encerra a sessão deste aparelho vinculado; não envia mensagens.
        if (estavaConectado) await s.logout();
        else await s.end(undefined);
      } catch (erro) {
        logger.warn(resumoErro(erro), 'Erro ao encerrar sessão; apagando sessão local mesmo assim');
      }
    }
    await apagarSessao();
    await this.definirStatus('desconectado', { qr_code: null });
  }

  /** SIGTERM: fecha o socket sem logout para retomar a mesma sessão após o reinício. */
  async encerrarParaReinicio(): Promise<void> {
    this.encerrando = true;
    await this.fecharSocket();
    await this.definirStatus('reiniciando');
  }
}

export const whatsapp = new ConexaoWhatsApp();
sincronizador.definirResolvedor((jid, alt) => whatsapp.resolverChat(jid, alt));
