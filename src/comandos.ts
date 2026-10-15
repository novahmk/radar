import { logger, resumoErro } from './logger.js';
import { chamar } from './ponte.js';
import { ErroComando, whatsapp } from './whatsapp.js';

const INTERVALO_POLLING_MS = 10_000;

type TipoComando = 'desconectar' | 'novo_qr' | 'reconectar';
interface Comando {
  id: string;
  tipo: TipoComando | string;
}

const acoes: Record<TipoComando, () => Promise<void>> = {
  novo_qr: () => whatsapp.novoQr(),
  reconectar: () => whatsapp.reconectar(),
  desconectar: () => whatsapp.desconectar(),
};

type StatusComando = 'executado' | 'erro';

/** Fila de comandos do app, lida por polling na ponte-api a cada 10 s. Um comando por vez. */
class Comandos {
  private timer?: NodeJS.Timeout;
  private executando = false;
  private parado = false;
  /**
   * Comandos já executados cujo status ainda não foi gravado. Eles não são executados de novo:
   * o status é reenviado a cada ciclo de polling até a ponte-api confirmar.
   */
  private statusAGravar = new Map<string, StatusComando>();

  iniciar(): void {
    this.timer = setInterval(() => void this.processarPendentes(), INTERVALO_POLLING_MS);
    void this.processarPendentes();
  }

  async parar(): Promise<void> {
    this.parado = true;
    if (this.timer) clearInterval(this.timer);
  }

  async processarPendentes(): Promise<void> {
    if (this.parado || this.executando) return;
    this.executando = true;
    try {
      await this.gravarStatusPendentes();
      const { comandos } = await chamar<{ comandos?: Comando[] }>('comandos_pendentes');
      for (const cmd of comandos ?? []) {
        if (this.parado) return;
        if (this.statusAGravar.has(cmd.id)) continue;
        await this.executar(cmd);
      }
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao processar comandos');
    } finally {
      this.executando = false;
    }
  }

  private async gravarStatusPendentes(): Promise<void> {
    for (const [id, status] of this.statusAGravar) {
      try {
        await chamar('comando_status', { id, status });
        this.statusAGravar.delete(id);
      } catch (erro) {
        logger.warn({ comando: id, aguardando: this.statusAGravar.size, ...resumoErro(erro) }, 'Status do comando ainda não gravado; nova tentativa no próximo ciclo');
      }
    }
  }

  private async executar(cmd: Comando): Promise<void> {
    let status: StatusComando = 'executado';
    const acao = acoes[cmd.tipo as TipoComando];
    logger.info({ comando: cmd.id, tipoComando: cmd.tipo }, 'Executando comando');
    try {
      if (!acao) throw new ErroComando('Tipo de comando desconhecido');
      await acao();
    } catch (erro) {
      status = 'erro';
      const motivo = erro instanceof ErroComando ? erro.message : undefined;
      logger.warn({ comando: cmd.id, tipoComando: cmd.tipo, motivo, ...resumoErro(erro) }, 'Comando falhou');
    }
    this.statusAGravar.set(cmd.id, status);
    await this.gravarStatusPendentes();
  }
}

export const comandos = new Comandos();
