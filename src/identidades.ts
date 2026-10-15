import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLidUser, isPnUser, jidNormalizedUser } from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger, resumoErro } from './logger.js';

const ARQUIVO = path.join(config.DATA_DIR, 'identidades.json');
const ATRASO_GRAVACAO_MS = 2_000;

/** Pedido para a ponte-api juntar a conversa `jid_de` na conversa `jid_para`. */
export interface Unificacao {
  jid_de: string;
  jid_para: string;
}

interface Persistido {
  versao: 1;
  chaves: Record<string, string>;
  pares: Record<string, string>;
  unificar: Unificacao[];
}

function normalizar(jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  const n = jidNormalizedUser(jid);
  return isPnUser(n) || isLidUser(n) ? n : undefined;
}

/**
 * Chave estável das conversas individuais.
 *
 * A primeira vez que uma conversa aparece, a chave é o jid do telefone (se já conhecido) ou o jid @lid.
 * Depois disso a chave nunca muda: quando o telefone de um @lid é descoberto, ele só é registrado como
 * alias e enviado no campo `telefone`. Se o mesmo contato tiver ganhado duas chaves (o @lid e o telefone
 * apareceram separados antes de o par ser conhecido), as duas são unificadas e a ponte-api é avisada.
 *
 * Fica em DATA_DIR/identidades.json (mesmo volume e mesma sensibilidade da sessão do WhatsApp).
 * Só usa pares entregues pelo próprio WhatsApp; nunca consulta o servidor para descobrir um par.
 */
class Identidades {
  private chaves = new Map<string, string>();
  private pares = new Map<string, string>();
  /** Unificações ainda não confirmadas pela ponte-api; `anexada` = já está num lote em memória. */
  private unificar = new Map<string, { para: string; anexada: boolean }>();
  private timer?: NodeJS.Timeout;
  private gravacao: Promise<void> = Promise.resolve();

  async carregar(): Promise<void> {
    try {
      const dados = JSON.parse(await readFile(ARQUIVO, 'utf8')) as Partial<Persistido>;
      for (const [k, v] of Object.entries(dados.chaves ?? {})) this.chaves.set(k, v);
      for (const [k, v] of Object.entries(dados.pares ?? {})) this.pares.set(k, v);
      for (const u of dados.unificar ?? []) this.unificar.set(u.jid_de, { para: u.jid_para, anexada: false });
      logger.info({ chaves: this.chaves.size, unificacoesPendentes: this.unificar.size }, 'Identidades carregadas');
    } catch (erro) {
      if ((erro as { code?: string }).code !== 'ENOENT') logger.error(resumoErro(erro), 'Falha ao ler identidades; começando vazio');
    }
  }

  /** Jid do outro lado do par (telefone ↔ @lid), se conhecido. */
  parDe(jid: string | undefined): string | undefined {
    return jid ? this.pares.get(jid) : undefined;
  }

  /** Registra um par @lid ↔ telefone vindo do WhatsApp e junta as chaves, se preciso. */
  registrarPar(lidBruto: string | null | undefined, pnBruto: string | null | undefined): void {
    const lid = normalizar(lidBruto);
    const pn = normalizar(pnBruto);
    if (!lid || !pn || !isLidUser(lid) || !isPnUser(pn)) return;
    if (this.pares.get(lid) === pn && this.pares.get(pn) === lid) return;
    this.pares.set(lid, pn);
    this.pares.set(pn, lid);
    const cLid = this.chaves.get(lid);
    const cPn = this.chaves.get(pn);
    if (cLid && cPn && cLid !== cPn) this.juntar([cLid, cPn], cPn);
    else if (cLid && !cPn) this.chaves.set(pn, cLid);
    else if (cPn && !cLid) this.chaves.set(lid, cPn);
    this.agendarGravacao();
  }

  /**
   * Chave estável para a conversa identificada por estes jids.
   * `preferida` é usada só se nenhum deles tiver chave ainda (telefone quando conhecido, senão o jid original).
   */
  chaveDe(jids: (string | undefined)[], preferida: string): string {
    const todos = new Set<string>();
    for (const j of jids) {
      if (!j) continue;
      todos.add(j);
      const par = this.pares.get(j);
      if (par) todos.add(par);
    }
    const existentes = [...new Set([...todos].map((j) => this.chaves.get(j)).filter((c): c is string => !!c))];
    let chave: string;
    if (existentes.length === 0) chave = preferida;
    else if (existentes.length === 1) chave = existentes[0]!;
    else chave = this.juntar(existentes, existentes.includes(preferida) ? preferida : existentes[0]!);

    let mudou = false;
    for (const j of todos) {
      if (this.chaves.get(j) !== chave) {
        this.chaves.set(j, chave);
        mudou = true;
      }
    }
    if (mudou) this.agendarGravacao();
    return chave;
  }

  /** Aponta todas as chaves para `canonica` e registra as unificações para a ponte-api. */
  private juntar(chaves: string[], canonica: string): string {
    const outras = new Set(chaves.filter((c) => c !== canonica));
    for (const [jid, c] of this.chaves) if (outras.has(c)) this.chaves.set(jid, canonica);
    for (const u of this.unificar.values()) if (outras.has(u.para)) u.para = canonica;
    for (const de of outras) this.unificar.set(de, { para: canonica, anexada: false });
    this.unificar.delete(canonica);
    logger.info({ unificadas: outras.size }, 'Conversas duplicadas do mesmo contato serão unificadas');
    this.agendarGravacao();
    return canonica;
  }

  /** Unificações ainda não anexadas a nenhum lote; passam a ser responsabilidade do lote que as recebe. */
  tomarNovas(): Unificacao[] {
    const novas: Unificacao[] = [];
    for (const [de, u] of this.unificar) {
      if (u.anexada) continue;
      u.anexada = true;
      novas.push({ jid_de: de, jid_para: u.para });
    }
    return novas;
  }

  /** O lote que levava estas unificações foi confirmado pela ponte-api. */
  confirmar(lista: Unificacao[]): void {
    let mudou = false;
    for (const u of lista) {
      const atual = this.unificar.get(u.jid_de);
      if (atual && atual.para === u.jid_para) {
        this.unificar.delete(u.jid_de);
        mudou = true;
      } else if (atual) {
        // O destino mudou depois do envio (nova unificação em cadeia): reenviar no próximo lote.
        atual.anexada = false;
      }
    }
    if (mudou) this.agendarGravacao();
  }

  /** O lote que levava estas unificações foi descartado: elas voltam para o próximo lote. */
  devolver(lista: Unificacao[]): void {
    for (const u of lista) {
      const atual = this.unificar.get(u.jid_de);
      if (atual) atual.anexada = false;
    }
  }

  private agendarGravacao(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.gravar();
    }, ATRASO_GRAVACAO_MS);
    this.timer.unref();
  }

  /** Grava já (usado no encerramento). */
  async gravarAgora(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.gravar();
  }

  private gravar(): Promise<void> {
    this.gravacao = this.gravacao.then(async () => {
      const dados: Persistido = {
        versao: 1,
        chaves: Object.fromEntries(this.chaves),
        pares: Object.fromEntries(this.pares),
        unificar: [...this.unificar].map(([de, u]) => ({ jid_de: de, jid_para: u.para })),
      };
      try {
        await mkdir(config.DATA_DIR, { recursive: true });
        const temporario = `${ARQUIVO}.tmp`;
        await writeFile(temporario, JSON.stringify(dados), { mode: 0o600 });
        await rename(temporario, ARQUIVO);
      } catch (erro) {
        logger.error(resumoErro(erro), 'Falha ao gravar identidades');
      }
    });
    return this.gravacao;
  }
}

export const identidades = new Identidades();
