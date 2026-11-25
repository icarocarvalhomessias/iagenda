// agenda-web: as funções que cada pessoa liga ou desliga no menu do perfil (Compromissos, Contas, Remédios).
// Desligada, a função some da página, do chat e dos avisos; os dados continuam (na agenda Google ou aqui) e voltam
// ao religar. Padrão: compromissos e contas ligados, remédios desligado (quem quiser, liga).
import { ErroHttp, type Evento } from "./agenda.ts";
import { db } from "./banco.ts";

export type Funcoes = { compromissos: boolean; contas: boolean; remedios: boolean };
export const PADRAO: Funcoes = { compromissos: true, contas: true, remedios: false };
export const NOMES: Record<keyof Funcoes, string> = { compromissos: "Compromissos", contas: "Contas", remedios: "Remédios" };

db.exec(`CREATE TABLE IF NOT EXISTS funcoes (usuario TEXT PRIMARY KEY, compromissos INTEGER NOT NULL,
  contas INTEGER NOT NULL, remedios INTEGER NOT NULL, mudou INTEGER NOT NULL)`);

export function funcoes(usuario: string): Funcoes {
  const l = db.prepare("SELECT compromissos, contas, remedios FROM funcoes WHERE usuario = ?").get(usuario) as any;
  return l ? { compromissos: !!l.compromissos, contas: !!l.contas, remedios: !!l.remedios } : { ...PADRAO };
}

export function mudar(usuario: string, b: any): Funcoes {
  const f = funcoes(usuario);
  for (const k of Object.keys(PADRAO) as (keyof Funcoes)[]) {
    if (b?.[k] === undefined) continue;
    if (typeof b[k] !== "boolean") throw new ErroHttp(400, "campo", "Valor inválido.");
    f[k] = b[k];
  }
  db.prepare(`INSERT INTO funcoes (usuario, compromissos, contas, remedios, mudou) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (usuario) DO UPDATE SET compromissos = excluded.compromissos, contas = excluded.contas,
      remedios = excluded.remedios, mudou = excluded.mudou`)
    .run(usuario, f.compromissos ? 1 : 0, f.contas ? 1 : 0, f.remedios ? 1 : 0, Date.now());
  return f;
}

// Conta é das "Contas"; todo o resto da agenda é "Compromissos".
export const funcaoDoEvento = (ev: { tipo?: string }): keyof Funcoes => (ev.tipo === "conta" ? "contas" : "compromissos");
export const visiveis = (evs: Evento[], f: Funcoes) => evs.filter((e) => f[funcaoDoEvento(e)]);

export function exigir(f: Funcoes, k: keyof Funcoes) {
  if (!f[k]) throw new ErroHttp(403, "funcao", `${NOMES[k]} está desligado. Para ligar, toque na letra do seu perfil, em Funções.`);
}

export function apagarTudo(usuario: string) {
  if (usuario) db.prepare("DELETE FROM funcoes WHERE usuario = ?").run(usuario);
}
