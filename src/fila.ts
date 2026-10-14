import { logger, resumoErro } from './logger.js';
import { comRetry, OWNER_ID, supabase } from './supabase.js';
import { sincronizador } from './sync.js';

const TAMANHO_LOTE_PADRAO = 5;
const TAMANHO_LOTE_MAXIMO = 50;
const INTERVALO_PADRAO_MIN = 10;
const MAX_TENTATIVAS = 3;
const ESPERA_OCIOSA_MS = 15_000;
const PAGINA_BACKFILL = 500;

interface ConfigExtracao {
  tamanhoLote: number;
  intervaloMs: number;
  pausada: boolean;
}

interface ItemLote {
  filaId: string;
  conversaId: string;
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

  async iniciar(): Promise<void> {
    // Conversas que ficaram no meio de um lote quando o serviço caiu voltam para a fila.
    await comRetry('fila_retomar', () =>
      supabase
        .from('fila_conversas')
        .update({ status: 'pendente' })
        .eq('owner_id', OWNER_ID)
        .eq('status', 'em_processamento'),
    );
    const { data } = await comRetry('fila_ultimo_lote', () =>
      supabase
        .from('fila_conversas')
        .select('lote_numero')
        .eq('owner_id', OWNER_ID)
        .not('lote_numero', 'is', null)
        .order('lote_numero', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    this.loteNumero = Number((data as { lote_numero?: number } | null)?.lote_numero ?? 0);
    await this.enfileirarExistentes();
    this.loop = this.executar();
  }

  /** Espera o lote em andamento terminar (com limite de tempo). */
  async parar(limiteMs: number): Promise<void> {
    this.parando = true;
    this.acordar?.();
    if (this.loop) await Promise.race([this.loop, new Promise((r) => setTimeout(r, limiteMs))]);
  }

  /** Coloca como 'pendente' as conversas individuais e não ignoradas que ainda não estão na fila. */
  async enfileirar(conversaIds: string[]): Promise<void> {
    if (conversaIds.length === 0) return;
    const { data } = await comRetry('fila_elegiveis', () =>
      supabase
        .from('conversas')
        .select('id')
        .eq('owner_id', OWNER_ID)
        .in('id', conversaIds)
        .eq('eh_grupo', false)
        .not('ignorada', 'is', true),
    );
    await this.inserir(((data as { id: string }[] | null) ?? []).map((c) => c.id));
  }

  private async inserir(conversaIds: string[]): Promise<void> {
    if (conversaIds.length === 0) return;
    const agora = new Date().toISOString();
    const linhas = conversaIds.map((id) => ({
      owner_id: OWNER_ID,
      conversa_id: id,
      status: 'pendente',
      tentativas: 0,
      enfileirada_em: agora,
    }));
    await comRetry('fila_inserir', () =>
      supabase.from('fila_conversas').upsert(linhas, { onConflict: 'conversa_id', ignoreDuplicates: true }),
    );
  }

  /** Garante que conversas capturadas antes da fila existir (ou de uma falha) também entrem nela. */
  private async enfileirarExistentes(): Promise<void> {
    let total = 0;
    for (let inicio = 0; ; inicio += PAGINA_BACKFILL) {
      const { data } = await comRetry('fila_backfill', () =>
        supabase
          .from('conversas')
          .select('id')
          .eq('owner_id', OWNER_ID)
          .eq('eh_grupo', false)
          .not('ignorada', 'is', true)
          .order('id')
          .range(inicio, inicio + PAGINA_BACKFILL - 1),
      );
      const ids = ((data as { id: string }[] | null) ?? []).map((c) => c.id);
      await this.inserir(ids);
      total += ids.length;
      if (ids.length < PAGINA_BACKFILL) break;
    }
    logger.info({ conversasVerificadas: total }, 'Fila de conversas sincronizada com as conversas existentes');
  }

  private async lerConfig(): Promise<ConfigExtracao> {
    // select('*') tolera colunas que o app ainda não criou.
    const { data } = await comRetry('ler_config_extracao', () =>
      supabase.from('configuracoes').select('*').eq('owner_id', OWNER_ID).maybeSingle(),
    );
    const c = (data as Record<string, unknown> | null) ?? {};
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
        const itens = await this.proximosPendentes(cfg.tamanhoLote);
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

  /** Pendentes da conversa mais recente para a mais antiga. */
  private async proximosPendentes(limite: number): Promise<ItemLote[]> {
    const { data } = await comRetry('fila_pendentes', () =>
      supabase
        .from('conversas')
        .select('id, fila_conversas!inner(id, tentativas)')
        .eq('owner_id', OWNER_ID)
        .eq('eh_grupo', false)
        .not('ignorada', 'is', true)
        .eq('fila_conversas.status', 'pendente')
        .order('ultima_mensagem_em', { ascending: false, nullsFirst: false })
        .limit(limite),
    );
    type Linha = { id: string; fila_conversas: { id: string; tentativas: number | null } | { id: string; tentativas: number | null }[] };
    return ((data as Linha[] | null) ?? []).flatMap((l) => {
      const f = Array.isArray(l.fila_conversas) ? l.fila_conversas[0] : l.fila_conversas;
      return f ? [{ filaId: f.id, conversaId: l.id, tentativas: f.tentativas ?? 0 }] : [];
    });
  }

  private async processarLote(itens: ItemLote[]): Promise<void> {
    const lote = this.loteNumero + 1;
    await comRetry('fila_em_processamento', () =>
      supabase
        .from('fila_conversas')
        .update({ status: 'em_processamento' })
        .eq('owner_id', OWNER_ID)
        .in('id', itens.map((i) => i.filaId)),
    );
    this.loteNumero = lote;
    await this.atualizarProgresso(null);

    let processadas = 0;
    let falhas = 0;
    for (const item of itens) {
      try {
        await sincronizador.recalcularConversas([item.conversaId]);
        await comRetry('fila_processada', () =>
          supabase
            .from('fila_conversas')
            .update({ status: 'processada', processada_em: new Date().toISOString(), lote_numero: lote })
            .eq('owner_id', OWNER_ID)
            .eq('id', item.filaId),
        );
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
      await comRetry('fila_falha', () =>
        supabase.from('fila_conversas').update({ status, tentativas }).eq('owner_id', OWNER_ID).eq('id', item.filaId),
      );
    } catch (e) {
      // Se nem isso gravar, a conversa volta a 'pendente' no próximo reinício.
      logger.error(resumoErro(e), 'Falha ao registrar erro da conversa na fila');
    }
  }

  private async atualizarProgresso(proximoLoteEm: string | null): Promise<void> {
    try {
      const [total, processadas] = await Promise.all([
        comRetry('fila_total', () =>
          supabase.from('fila_conversas').select('id', { count: 'exact', head: true }).eq('owner_id', OWNER_ID),
        ),
        comRetry('fila_processadas', () =>
          supabase
            .from('fila_conversas')
            .select('id', { count: 'exact', head: true })
            .eq('owner_id', OWNER_ID)
            .eq('status', 'processada'),
        ),
      ]);
      await comRetry('fila_progresso', () =>
        supabase.from('sincronizacao').upsert(
          {
            owner_id: OWNER_ID,
            conversas_total_fila: total.count ?? 0,
            conversas_processadas: processadas.count ?? 0,
            lote_atual: this.loteNumero,
            proximo_lote_em: proximoLoteEm,
          },
          { onConflict: 'owner_id' },
        ),
      );
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao atualizar progresso da fila');
    }
  }
}

export const filaConversas = new FilaConversas();
