import { createClient, type SupabaseClientOptions } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { config } from './config.js';
import { logger, resumoErro } from './logger.js';

type TransporteRealtime = NonNullable<NonNullable<SupabaseClientOptions<'public'>['realtime']>['transport']>;

export const OWNER_ID = config.OWNER_ID;

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  // Node 20 não tem WebSocket global; o Realtime precisa de um transporte explícito.
  realtime: { transport: WebSocket as unknown as TransporteRealtime },
});

export class ErroSupabase extends Error {
  constructor(
    public readonly operacao: string,
    public readonly code: string | undefined,
  ) {
    super(`Falha no Supabase em "${operacao}" (código ${code ?? 'desconhecido'})`);
    this.name = 'ErroSupabase';
  }
}

type RespostaSupabase<T> = { data: T | null; error: { code?: string } | null; count?: number | null };

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Executa uma operação no Supabase com até 3 tentativas e backoff curto. */
export async function comRetry<T>(
  operacao: string,
  fn: () => PromiseLike<RespostaSupabase<T>>,
): Promise<RespostaSupabase<T>> {
  const tentativas = 3;
  let ultimoErro: unknown;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const resp = await fn();
      if (!resp.error) return resp;
      ultimoErro = new ErroSupabase(operacao, resp.error.code);
    } catch (erro) {
      ultimoErro = erro;
    }
    if (i < tentativas) {
      logger.warn({ operacao, tentativa: i, ...resumoErro(ultimoErro) }, 'Supabase falhou; tentando de novo');
      await esperar(300 * 3 ** (i - 1));
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
  const linha = { owner_id: OWNER_ID, ...campos, ultimo_evento_em: new Date().toISOString() };
  await comRetry('atualizar_conexao', () => supabase.from('conexao').upsert(linha, { onConflict: 'owner_id' }));
}

export async function lerConexao(): Promise<{ consentido: boolean; status: string | null }> {
  const { data } = await comRetry('ler_conexao', () =>
    supabase.from('conexao').select('status, consentimento_aceito_em').eq('owner_id', OWNER_ID).maybeSingle(),
  );
  const linha = data as { status?: string | null; consentimento_aceito_em?: string | null } | null;
  return { consentido: Boolean(linha?.consentimento_aceito_em), status: linha?.status ?? null };
}
