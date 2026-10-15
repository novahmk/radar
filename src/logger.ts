import pino from 'pino';
import { config } from './config.js';

const FUSO = 'America/Sao_Paulo';

function horarioSaoPaulo(): string {
  // Formato "AAAA-MM-DD HH:mm:ss" no fuso de São Paulo.
  return `,"time":"${new Date().toLocaleString('sv-SE', { timeZone: FUSO })}"`;
}

/**
 * Logger da aplicação. Regra: só contagens, status e códigos de erro.
 * Nunca texto de mensagens, nomes, telefones ou jids.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { servico: 'radar-ponte' },
  timestamp: horarioSaoPaulo,
  redact: {
    paths: ['texto', 'nome', 'nome_contato', 'telefone', 'jid', 'qr', 'qr_code', '*.texto', '*.telefone', '*.jid'],
    censor: '[oculto]',
  },
});

/** Logger silencioso entregue ao Baileys, cujos logs internos podem conter jids e conteúdo. */
export const loggerBaileys = pino({ level: 'silent' });

/** Erro cuja mensagem é escrita pela ponte e não contém dados pessoais: pode ir para o log como `detalhe`. */
export class ErroSeguro extends Error {
  constructor(
    mensagem: string,
    nome = 'ErroSeguro',
    public readonly code?: string,
  ) {
    super(mensagem);
    this.name = nome;
  }
}

/** Resume um erro sem expor conteúdo: apenas tipo e código (e a mensagem, só para ErroSeguro). */
export function resumoErro(erro: unknown): { tipo: string; codigo?: string | number; detalhe?: string } {
  if (erro && typeof erro === 'object') {
    const e = erro as { name?: unknown; code?: unknown; output?: { statusCode?: unknown }; status?: unknown };
    const codigo = e.code ?? e.output?.statusCode ?? e.status;
    return {
      tipo: typeof e.name === 'string' ? e.name : 'Erro',
      codigo: typeof codigo === 'string' || typeof codigo === 'number' ? codigo : undefined,
      detalhe: erro instanceof ErroSeguro ? erro.message : undefined,
    };
  }
  return { tipo: typeof erro };
}
