import { config, VARIAVEIS_OBSOLETAS } from './config.js';
import { logger, resumoErro } from './logger.js';
import { atualizarConexao, iniciarHeartbeat, lerEstado, pararHeartbeat } from './ponte.js';
import { filtros } from './filtros.js';
import { sincronizador } from './sync.js';
import { sessaoSalvaExiste, whatsapp } from './whatsapp.js';
import { comandos } from './comandos.js';
import { filaConversas } from './fila.js';
import { iniciarHealth } from './health.js';

process.env.TZ ??= 'America/Sao_Paulo';

const INTERVALO_CONSENTIMENTO_MS = 15_000;
const LIMITE_LOTE_NO_ENCERRAMENTO_MS = 20_000;

let encerrando = false;

process.on('uncaughtException', (erro) => {
  logger.fatal(resumoErro(erro), 'Exceção não tratada; saindo para o Railway reiniciar');
  process.exit(1);
});
process.on('unhandledRejection', (erro) => {
  logger.fatal(resumoErro(erro), 'Promise rejeitada sem tratamento; saindo para o Railway reiniciar');
  process.exit(1);
});

const servidor = iniciarHealth(config.PORT, () => whatsapp.status);

async function aguardarConsentimento(): Promise<string | null> {
  let avisado = false;
  for (;;) {
    if (encerrando) return null;
    try {
      const { consentido, status } = (await lerEstado()).conexao;
      if (consentido) return status;
      if (!avisado) {
        whatsapp.definirStatusLocal('aguardando_consentimento');
        await atualizarConexao({ status: 'aguardando_consentimento' });
        logger.info('Consentimento ainda não aceito no app; verificando a cada 15 s');
        avisado = true;
      }
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao verificar consentimento');
    }
    await new Promise((r) => setTimeout(r, INTERVALO_CONSENTIMENTO_MS));
  }
}

async function main(): Promise<void> {
  logger.info('Iniciando radar-ponte (somente leitura)');
  if (VARIAVEIS_OBSOLETAS.length > 0) {
    logger.warn({ variaveis: VARIAVEIS_OBSOLETAS }, 'Variáveis obsoletas no ambiente (não são mais usadas); remova-as');
  }
  iniciarHeartbeat();
  await sincronizador.iniciar();
  await filtros.iniciar();

  const statusAnterior = await aguardarConsentimento();
  if (encerrando) return;
  logger.info('Consentimento confirmado');

  comandos.iniciar();
  try {
    await filaConversas.iniciar();
  } catch (erro) {
    // Sem a fila a captura continua; o processamento volta no próximo reinício.
    logger.error(resumoErro(erro), 'Falha ao iniciar a fila de conversas');
  }

  // Após logout/desconexão a sessão foi apagada: só gera QR quando o app pedir (comando novo_qr).
  if (!(await sessaoSalvaExiste()) && (statusAnterior === 'sessao_encerrada' || statusAnterior === 'desconectado')) {
    whatsapp.definirStatusLocal(statusAnterior);
    logger.info({ status: statusAnterior }, 'Sem sessão salva; aguardando comando novo_qr');
    return;
  }
  await whatsapp.iniciar();
}

async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  logger.info({ sinal }, 'Encerrando com limpeza');
  setTimeout(() => process.exit(0), 30_000).unref();
  try {
    pararHeartbeat();
    await comandos.parar();
    filtros.parar();
    await filaConversas.parar(LIMITE_LOTE_NO_ENCERRAMENTO_MS);
    await sincronizador.encerrar(LIMITE_LOTE_NO_ENCERRAMENTO_MS);
    await whatsapp.encerrarParaReinicio();
  } catch (erro) {
    logger.error(resumoErro(erro), 'Erro durante o encerramento');
  }
  servidor.close();
  process.exit(0);
}

process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));

main().catch((erro) => {
  logger.fatal({ ...resumoErro(erro), detalhe: erro instanceof Error && erro.message.startsWith('Sem permissão') ? erro.message : undefined }, 'Falha na inicialização');
  process.exit(1);
});
