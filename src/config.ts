import { validarAmbiente, type Config } from './ambiente.js';

export { VARIAVEIS_OBSOLETAS, type Config } from './ambiente.js';

function carregarConfig(): Config {
  const resultado = validarAmbiente(process.env);
  if (!resultado.ok) {
    const problemas = resultado.problemas.map((p) => `  - ${p}`).join('\n');
    process.stderr.write(`[radar-ponte] Configuração inválida. Verifique as variáveis de ambiente:\n${problemas}\n`);
    process.exit(1);
  }
  return resultado.config;
}

export const config = carregarConfig();
