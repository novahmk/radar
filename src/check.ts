import { validarAmbiente } from './ambiente.js';

/**
 * `npm run check`: valida as variáveis e faz uma chamada de leitura (ação `estado`) à ponte-api.
 * Imprime OK ou FALHA com o motivo. Nunca imprime o token nem dados retornados pela função.
 */
const TIMEOUT_MS = 15_000;

const escrever = (linha: string) => process.stdout.write(`${linha}\n`);

function falhar(motivo: string): never {
  escrever(`FALHA: ${motivo}`);
  process.exit(1);
}

function motivoDoErro(erro: unknown): string {
  const e = erro as { name?: string; status?: number; code?: string };
  if (e?.name !== 'ErroPonteApi') return 'erro inesperado ao chamar a ponte-api';
  const { status, code } = e;
  if (status === 401 || status === 403) return `${status}: token errado (PONTE_TOKEN não confere com o segredo da função)`;
  if (status === 404) return '404: URL errada ou ação inexistente (confira PONTE_API_URL e se a função ponte-api está publicada com a ação "estado")';
  if (code === 'acao_invalida') return `${status}: ação inexistente na função (a ponte-api não reconhece "estado")`;
  if (code === 'timeout') return `timeout: serviço fora (sem resposta em ${TIMEOUT_MS / 1000} s)`;
  if (code === 'enotfound' || code === 'eai_again') return `${code}: host não encontrado (confira PONTE_API_URL)`;
  if (code === 'econnrefused') return 'econnrefused: conexão recusada (serviço fora)';
  if (status === undefined) return `${code ?? 'rede'}: serviço fora ou inacessível`;
  if (status >= 500) return `${status}: erro interno na função${code ? ` (${code})` : ''}`;
  if (status >= 200 && status < 300) return `${status}: resposta fora do contrato (esperado { "ok": true, "dados": ... })`;
  return `${status}: resposta inesperada${code ? ` (${code})` : ''}`;
}

async function main(): Promise<void> {
  const ambiente = validarAmbiente(process.env);
  if (!ambiente.ok) falhar(`variáveis inválidas\n${ambiente.problemas.map((p) => `  - ${p}`).join('\n')}`);
  escrever('Variáveis: OK');

  // Só depois de validar: ponte.js carrega a configuração ao ser importado.
  const { chamarUmaVez } = await import('./ponte.js');
  const host = new URL(ambiente.config.PONTE_API_URL).host;
  const inicio = Date.now();
  let dados: { conexao?: { status?: unknown; consentimento_aceito_em?: unknown } | null };
  try {
    dados = await chamarUmaVez('estado', {}, TIMEOUT_MS);
  } catch (erro) {
    falhar(`${motivoDoErro(erro)} [host ${host}]`);
  }
  const status = typeof dados?.conexao?.status === 'string' ? dados.conexao.status : 'sem linha em conexao';
  const consentido = dados?.conexao?.consentimento_aceito_em ? 'sim' : 'não';
  escrever(`ponte-api: OK em ${Date.now() - inicio} ms [host ${host}] (status da conexão: ${status}; consentimento: ${consentido})`);
  escrever('OK');
}

main().catch(() => falhar('erro inesperado no check'));
