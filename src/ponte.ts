import { config } from './config.js';
import { logger, resumoErro } from './logger.js';

const TENTATIVAS = 3;
const BACKOFF_BASE_MS = 500;
const TIMEOUT_MS = 30_000;
const INTERVALO_HEARTBEAT_MS = 60_000;

/** Erro de uma chamada à Edge Function ponte-api. Nunca carrega o corpo da resposta. */
export class ErroPonteApi extends Error {
  constructor(
    public readonly acao: string,
    public readonly status: number | undefined,
    public readonly code: string | undefined,
    public readonly repetivel: boolean,
  ) {
    super(`Falha na ponte-api em "${acao}" (HTTP ${status ?? '-'}, código ${code ?? 'desconhecido'})`);
    this.name = 'ErroPonteApi';
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Só aceita códigos curtos em snake_case, para que nada vindo do servidor vaze conteúdo nos logs. */
function codigoSeguro(valor: unknown): string | undefined {
  return typeof valor === 'string' && /^[a-z0-9_]{1,40}$/.test(valor) ? valor : undefined;
}

function erroDeRede(acao: string, erro: unknown): ErroPonteApi {
  const e = erro as { name?: unknown; cause?: { code?: unknown } };
  const codigo = e?.name === 'TimeoutError' ? 'timeout' : (codigoSeguro(String(e?.cause?.code ?? '').toLowerCase()) ?? 'rede');
  return new ErroPonteApi(acao, undefined, codigo, true);
}

async function chamarUmaVez<T>(acao: string, dados: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(config.PONTE_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.PONTE_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ acao, dados }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (erro) {
    throw erroDeRede(acao, erro);
  }

  let corpo: { ok?: unknown; dados?: unknown; erro?: unknown } | undefined;
  try {
    corpo = (await resp.json()) as typeof corpo;
  } catch {
    corpo = undefined;
  }
  if (resp.ok && corpo?.ok === true) return (corpo.dados ?? {}) as T;

  const repetivel = resp.status >= 500 || resp.status === 408 || resp.status === 429 || (resp.ok && !corpo);
  throw new ErroPonteApi(acao, resp.status, codigoSeguro(corpo?.erro), repetivel);
}

/**
 * Executa uma ação da ponte-api com até 3 tentativas e backoff exponencial com jitter.
 * Erros 4xx (exceto 408/429) não são repetidos. Todas as ações são idempotentes no servidor.
 */
export async function chamar<T = Record<string, never>>(acao: string, dados: object = {}): Promise<T> {
  let ultimoErro: unknown;
  for (let i = 1; i <= TENTATIVAS; i++) {
    try {
      return await chamarUmaVez<T>(acao, dados);
    } catch (erro) {
      ultimoErro = erro;
      const repetivel = !(erro instanceof ErroPonteApi) || erro.repetivel;
      if (!repetivel || i === TENTATIVAS) break;
      logger.warn({ acao, tentativa: i, ...resumoErro(erro) }, 'ponte-api falhou; tentando de novo');
      const base = BACKOFF_BASE_MS * 3 ** (i - 1);
      await esperar(base + Math.floor(Math.random() * base * 0.3));
    }
  }
  throw ultimoErro;
}

export type StatusConexao =
  | 'aguardando_consentimento'
  | 'conectando'
  | 'aguardando_qr'
  | 'conectado'
  | 'reconectando'
  | 'desconectado'
  | 'erro'
  | 'sessao_encerrada'
  | 'reiniciando';

export interface CamposConexao {
  status?: StatusConexao;
  qr_code?: string | null;
  qr_atualizado_em?: string | null;
  conectado_em?: string | null;
}

/** Atualiza a linha de conexão do dono; sempre carimba ultimo_evento_em. */
export async function atualizarConexao(campos: CamposConexao): Promise<void> {
  await chamar('conexao', { ...campos, ultimo_evento_em: new Date().toISOString() });
}

/** Estado lido do banco pela ponte-api (só o que a ponte precisa). */
export interface Estado {
  conexao: { status: string | null; consentido: boolean };
  configuracoes: Record<string, unknown>;
  contatosIgnorados: string[];
  mensagensRecebidas: number;
}

export async function lerEstado(): Promise<Estado> {
  type Bruto = {
    conexao?: { status?: unknown; consentimento_aceito_em?: unknown } | null;
    configuracoes?: Record<string, unknown> | null;
    contatos_ignorados?: unknown;
    sincronizacao?: { mensagens_recebidas?: unknown } | null;
  };
  const d = await chamar<Bruto>('estado');
  const contatos = Array.isArray(d.contatos_ignorados) ? d.contatos_ignorados : [];
  const recebidas = Number(d.sincronizacao?.mensagens_recebidas ?? 0);
  return {
    conexao: {
      status: typeof d.conexao?.status === 'string' ? d.conexao.status : null,
      consentido: Boolean(d.conexao?.consentimento_aceito_em),
    },
    configuracoes: d.configuracoes && typeof d.configuracoes === 'object' ? d.configuracoes : {},
    contatosIgnorados: contatos.filter((t): t is string => typeof t === 'string'),
    mensagensRecebidas: Number.isFinite(recebidas) ? recebidas : 0,
  };
}

let timerHeartbeat: NodeJS.Timeout | undefined;

/** Carimba conexao.ultimo_evento_em periodicamente, sem alterar o status, para o app saber que a ponte está viva. */
export function iniciarHeartbeat(): void {
  pararHeartbeat();
  timerHeartbeat = setInterval(() => {
    chamar('conexao', { ultimo_evento_em: new Date().toISOString() }).catch((erro) =>
      logger.warn(resumoErro(erro), 'Falha no heartbeat da conexão'),
    );
  }, INTERVALO_HEARTBEAT_MS);
  timerHeartbeat.unref();
}

export function pararHeartbeat(): void {
  if (timerHeartbeat) clearInterval(timerHeartbeat);
  timerHeartbeat = undefined;
}
