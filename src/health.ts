import http from 'node:http';
import { logger } from './logger.js';

/** Único endpoint HTTP do serviço: GET /health. Não expõe dados sensíveis. */
export function iniciarHealth(porta: number, obterStatusConexao: () => string): http.Server {
  const servidor = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', conexao: obterStatusConexao() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'nao_encontrado' }));
  });
  servidor.listen(porta, () => logger.info({ porta }, 'Healthcheck ouvindo'));
  return servidor;
}
