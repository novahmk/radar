import type { RealtimeChannel } from '@supabase/supabase-js';
import { logger, resumoErro } from './logger.js';
import { comRetry, OWNER_ID, supabase } from './supabase.js';
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

/** Fila de comandos do app: Realtime para reagir rápido e polling como garantia. Um comando por vez. */
class Comandos {
  private canal?: RealtimeChannel;
  private timer?: NodeJS.Timeout;
  private executando = false;
  private repetir = false;
  private parado = false;

  iniciar(): void {
    this.canal = supabase
      .channel(`comandos-${OWNER_ID}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'comandos', filter: `owner_id=eq.${OWNER_ID}` },
        () => void this.processarPendentes(),
      )
      .subscribe((status) => logger.info({ status }, 'Realtime de comandos'));
    this.timer = setInterval(() => void this.processarPendentes(), INTERVALO_POLLING_MS);
    void this.processarPendentes();
  }

  async parar(): Promise<void> {
    this.parado = true;
    if (this.timer) clearInterval(this.timer);
    if (this.canal) await supabase.removeChannel(this.canal).catch(() => undefined);
  }

  async processarPendentes(): Promise<void> {
    if (this.parado) return;
    if (this.executando) {
      this.repetir = true;
      return;
    }
    this.executando = true;
    try {
      do {
        this.repetir = false;
        const { data } = await comRetry('ler_comandos', () =>
          supabase
            .from('comandos')
            .select('id, tipo')
            .eq('owner_id', OWNER_ID)
            .eq('status', 'pendente')
            .order('criado_em', { ascending: true }),
        );
        for (const cmd of (data as Comando[] | null) ?? []) {
          if (this.parado) return;
          await this.executar(cmd);
        }
      } while (this.repetir && !this.parado);
    } catch (erro) {
      logger.error(resumoErro(erro), 'Falha ao processar comandos');
    } finally {
      this.executando = false;
    }
  }

  private async executar(cmd: Comando): Promise<void> {
    let status: 'executado' | 'erro' = 'executado';
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
    try {
      await comRetry('atualizar_comando', () =>
        supabase.from('comandos').update({ status }).eq('id', cmd.id).eq('owner_id', OWNER_ID),
      );
    } catch (erro) {
      logger.error({ comando: cmd.id, ...resumoErro(erro) }, 'Falha ao atualizar status do comando');
    }
  }
}

export const comandos = new Comandos();
