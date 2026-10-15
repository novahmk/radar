import { logger, resumoErro } from './logger.js';
import { chamar, lerEstado } from './ponte.js';
import { sincronizador } from './sync.js';

const TAMANHO_LOTE_PADRAO = 5;
const TAMANHO_LOTE_MAXIMO = 50;
const INTERVALO_PADRAO_MIN = 10;
const MAX_TENTATIVAS = 3;
const ESPERA_OCIOSA_MS = 15_000;

interface ConfigExtracao {
  tamanhoLote: number;
  intervaloMs: number;
  pausada: boolean;
}

interface ItemLote {
  filaId: string;
  tentativas: number;
}

function inteiroOu(valor: unknown, padrao: number, min: number, max: number): number {
  const n = Number(valor);
  if (valor === null || valor === undefined || !Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Processamento gradual das conversas capturadas, em lotes de N conversas com intervalo entre eles.
 * Só lê o que já foi capturado no banco: pedir histórico ao celular exigiria enviar algo ao WhatsApp.
 */
class FilaConversas {
  private parando = false;
  private loop?: Promise<void>;
  private acordar?: () => void;
  private loteNumero = 0;
  private ultimoEstado?: 'pausada' | 'ociosa' | 'aguardando_captura';

  /**
   * No servidor: conversas que ficaram 'em_processamento' quando o serviço caiu voltam para 'pendente'
   * e conversas capturadas antes da fila existir (ou de uma falha) são enfileiradas.
   */
  async iniciar(): Promise<void> {
    const { ultimo_lote, enfileiradas } = await chamar<{ ultimo_lote?: unknown; enfileiradas?: unknown }>('fila_iniciar');
    this.loteNumero = inteiroOu(ultimo_lote, 0, 0, Number.MAX_SAFE_INTEGER);
    logger.info({ enfileiradas: inteiroOu(enfileiradas, 0, 0, Number.MAX_SAFE_INTEGER) }, 'Fila de conversas sincronizada com as conversas existentes');
    this.loop = this.executar();
  }

  /** Espera o lote em andamento terminar (com limite de tempo). */
  async parar(limiteMs: number): Promise<void> {
    this.parando = true;
    this.acordar?.();
    if (this.loop) await Promise.race([this.loop, new Promise((r) => setTimeout(r, limiteMs))]);
  }

  private async lerConfig(): Promise<ConfigExtracao> {
    // Colunas que o app ainda não criou chegam ausentes e caem no padrão.
    const c = (await lerEstado()).configuracoes;
    return {
      tamanhoLote: inteiroOu(c.tamanho_lote, TAMANHO_LOTE_PADRAO, 1, TAMANHO_LOTE_MAXIMO),
      intervaloMs: inteiroOu(c.intervalo_entre_lotes_min, INTERVALO_PADRAO_MIN, 0, 24 * 60) * 60_000,
      pausada: c.extracao_pausada === true,
    };
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.acordar = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private registrarEstado(estado: NonNullable<FilaConversas['ultimoEstado']>): void {
    if (this.ultimoEstado !== estado) logger.info({ estado }, 'Fila de conversas aguardando');
    this.ultimoEstado = estado;
  }

  private async executar(): Promise<void> {
    while (!this.parando) {
      try {
        const cfg = await this.lerConfig();
        if (cfg.pausada) {
          this.registrarEstado('pausada');
          await this.atualizarProgresso(null);
          await this.esperar(ESPERA_OCIOSA_MS);
          continue;
        }
        // Só processa com a captura parada, para que as mensagens já estejam todas no banco.
        if (!sincronizador.capturaOciosa()) {
          this.registrarEstado('aguardando_captura');
          await this.esperar(ESPERA_OCIOSA_MS);
          continue;
        }
        const itens = await this.reservarProximos(cfg.tamanhoLote);
        if (itens.length === 0) {
          this.registrarEstado('ociosa');
          await this.atualizarProgresso(null);
          await this.esperar(ESPERA_OCIOSA_MS);
          continue;
        }
        this.ultimoEstado = undefined;
        await this.processarLote(itens);
        if (this.parando) break;
        const proximo = new Date(Date.now() + cfg.intervaloMs);
        await this.atualizarProgresso(proximo.toISOString());
        await this.esperar(cfg.intervaloMs);
      } catch (erro) {
        logger.error(resumoErro(erro), 'Falha no ciclo da fila de conversas');
        await this.esperar(ESPERA_OCIOSA_MS);
      }
    }
  }

  /** Pendentes da conversa mais recente para a mais antiga; o servidor já as marca como 'em_processamento'. */
  private async reservarProximos(limite: number): Promise<ItemLote[]> {
    type Linha = { fila_id?: unknown; tentativas?: unknown };
    const { itens } = await chamar<{ itens?: Linha[] }>('fila_proximos', { limite });
    return (itens ?? []).flatMap((l) =>
      typeof l.fila_id === 'string'
        ? [{ filaId: l.fila_id, tentativas: inteiroOu(l.tentativas, 0, 0, MAX_TENTATIVAS) }]
        : [],
    );
  }

  private async processarLote(itens: ItemLote[]): Promise<void> {
    const lote = this.loteNumero + 1;
    this.loteNumero = lote;
    await this.atualizarProgresso(null);

    let processadas = 0;
    let falhas = 0;
    for (const item of itens) {
      try {
        // Recalcula total_mensagens e última mensagem da conversa e marca 'processada' com o número do lote.
        await chamar('fila_processada', { fila_id: item.filaId, lote_numero: lote });
        processadas++;
      } catch (erro) {
        falhas++;
        await this.registrarFalha(item, erro);
      }
    }
    logger.info({ lote, processadas, falhas }, 'Lote de conversas processado');
  }

  private async registrarFalha(item: ItemLote, erro: unknown): Promise<void> {
    const tentativas = item.tentativas + 1;
    const status = tentativas >= MAX_TENTATIVAS ? 'erro' : 'pendente';
    logger.warn({ tentativas, status, ...resumoErro(erro) }, 'Falha ao processar conversa da fila');
    try {
      await chamar('fila_falha', { fila_id: item.filaId, tentativas, status });
    } catch (e) {
      // Se nem isso gravar, a conversa volta a 'pendente' no próximo reinício.
      logger.error(resumoErro(e), 'Falha ao registrar erro da conversa na fila');
    }
  }

  private async atualizarProgresso(proximoLoteEm: string | null): Promise<void> {
    try {
      // O servidor conta conversas_total_fila e conversas_processadas.
      await chamar('fila_progresso', { lote_atual: this.loteNumero, proximo_lote_em: proximoLoteEm });
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao atualizar progresso da fila');
    }
  }
}

export const filaConversas = new FilaConversas();
