import { z } from 'zod';

const esquema = z.object({
  SUPABASE_URL: z.url({ message: 'SUPABASE_URL deve ser uma URL válida' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, { message: 'SUPABASE_SERVICE_ROLE_KEY ausente ou inválida' }),
  OWNER_ID: z.uuid({ message: 'OWNER_ID deve ser o uuid do usuário no Supabase Auth' }),
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
