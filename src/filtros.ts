import { comRetry, OWNER_ID, supabase } from './supabase.js';
import { logger, resumoErro } from './logger.js';

const INTERVALO_RECARGA_MS = 60_000;

/** Mantém só os dígitos, para comparar telefones gravados em formatos diferentes. */
export function normalizarTelefone(telefone: string | null | undefined): string | null {
  const digitos = (telefone ?? '').replace(/\D/g, '');
  return digitos.length > 0 ? digitos : null;
}

/**
 * Filtros de privacidade definidos pelo usuário no app.
 * Grupos: quando configuracoes.ignorar_grupos = true, mensagens de jids @g.us são
 * simplesmente puladas (não gravamos nada), que é a opção mais simples.
 */
class Filtros {
  private ignorarGrupos = false;
  private telefonesIgnorados = new Set<string>();
  private timer?: NodeJS.Timeout;

  async iniciar(): Promise<void> {
    await this.recarregar();
    this.timer = setInterval(() => void this.recarregar(), INTERVALO_RECARGA_MS);
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recarregar(): Promise<void> {
    try {
      const [cfg, ignorados] = await Promise.all([
        comRetry('ler_configuracoes', () =>
          supabase.from('configuracoes').select('ignorar_grupos').eq('owner_id', OWNER_ID).maybeSingle(),
        ),
        comRetry('ler_contatos_ignorados', () =>
          supabase.from('contatos_ignorados').select('telefone').eq('owner_id', OWNER_ID),
        ),
      ]);
      this.ignorarGrupos = Boolean((cfg.data as { ignorar_grupos?: boolean } | null)?.ignorar_grupos);
      const lista = (ignorados.data as { telefone: string | null }[] | null) ?? [];
      this.telefonesIgnorados = new Set(lista.map((l) => normalizarTelefone(l.telefone)).filter((t): t is string => !!t));
      logger.debug({ ignorarGrupos: this.ignorarGrupos, contatosIgnorados: this.telefonesIgnorados.size }, 'Filtros recarregados');
    } catch (erro) {
      // Mantém os filtros anteriores se a recarga falhar.
      logger.error(resumoErro(erro), 'Falha ao recarregar filtros');
    }
  }

  deveIgnorarGrupos(): boolean {
    return this.ignorarGrupos;
  }

  telefoneIgnorado(telefone: string | null): boolean {
    const t = normalizarTelefone(telefone);
    return t !== null && this.telefonesIgnorados.has(t);
  }
}

export const filtros = new Filtros();
