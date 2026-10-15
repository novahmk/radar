import { z } from 'zod';

/** O token viaja no header; fora de localhost só aceitamos https. */
function urlSegura(valor: string): boolean {
  const url = new URL(valor);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const esquema = z.object({
  PONTE_API_URL: z
    .url({ message: 'PONTE_API_URL deve ser a URL da Edge Function ponte-api' })
    .refine(urlSegura, { message: 'PONTE_API_URL deve usar https (http só para localhost)' }),
  PONTE_TOKEN: z
    .string({ message: 'PONTE_TOKEN ausente' })
    .trim()
    .min(32, { message: 'PONTE_TOKEN curto demais (mínimo 32 caracteres)' }),
  DATA_DIR: z.string().min(1).default('/data'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = z.infer<typeof esquema>;

/** Variáveis do acesso direto ao Supabase, que não são mais usadas e não devem ficar no ambiente. */
export const VARIAVEIS_OBSOLETAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OWNER_ID'].filter((v) => process.env[v]);

/** Valida o ambiente sem efeitos colaterais. Os problemas trazem só nomes e motivos, nunca valores. */
export function validarAmbiente(env: NodeJS.ProcessEnv): { ok: true; config: Config } | { ok: false; problemas: string[] } {
  const resultado = esquema.safeParse(env);
  if (resultado.success) return { ok: true, config: resultado.data };
  return {
    ok: false,
    problemas: resultado.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`),
  };
}
