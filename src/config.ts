import { z } from 'zod';

/** O token viaja no header; fora de localhost só aceitamos https. */
function urlSegura(valor: string): boolean {
  const url = new URL(valor);
  return url.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** Variáveis do acesso direto ao Supabase, que não são mais usadas e não devem ficar no ambiente. */
export const VARIAVEIS_OBSOLETAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OWNER_ID'].filter((v) => process.env[v]);

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

function carregarConfig(): Config {
  const resultado = esquema.safeParse(process.env);
  if (!resultado.success) {
    // Só os nomes das variáveis e o motivo; nunca os valores.
    const problemas = resultado.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    process.stderr.write(`[radar-ponte] Configuração inválida. Verifique as variáveis de ambiente:\n${problemas}\n`);
    process.exit(1);
  }
  return resultado.data;
}

export const config = carregarConfig();
