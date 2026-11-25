// agenda-web: remédios de cada pessoa. Cadastro (nome, dose por vez, horários, unidades por caixa), estoque,
// compras, o check-in do dia (tomei / não tomei em cada horário) e o relatório de faltas.
//
// É dado de saúde: fica só aqui (SQLite no StateDirectory, por pessoa), nunca vai para a agenda Google nem para o
// repositório. Desconectar o Google apaga tudo (apagarTudo).
//
// - Horário: "manha", "tarde", "noite" ou "HH:MM". Manhã, tarde e noite valem 08:00, 14:00 e 20:00 para os avisos.
// - Estoque = soma dos movimentos (estoque inicial, compras, acertos de contagem) menos as doses marcadas como
//   tomadas. Assim desmarcar uma dose devolve o remédio ao estoque sem conta à parte.
// - Mudar a dose ou os horários guarda uma versão nova (historico), que vale a partir daquele dia: o relatório
//   dos dias antigos continua contando com os horários de antes.
import { randomBytes } from "node:crypto";
import { ErroHttp } from "./agenda.ts";
import { db } from "./banco.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS remedios (id TEXT PRIMARY KEY, usuario TEXT NOT NULL, nome TEXT NOT NULL,
    unidade TEXT NOT NULL, por_caixa REAL, obs TEXT NOT NULL DEFAULT '', inicio TEXT NOT NULL, fim TEXT,
    historico TEXT NOT NULL, criado INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS remedios_usuario ON remedios (usuario);
  CREATE TABLE IF NOT EXISTS remedio_mov (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL, remedio TEXT NOT NULL,
    quando INTEGER NOT NULL, dia TEXT NOT NULL, delta REAL NOT NULL, motivo TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS remedio_mov_remedio ON remedio_mov (remedio);
  CREATE TABLE IF NOT EXISTS remedio_doses (usuario TEXT NOT NULL, remedio TEXT NOT NULL, dia TEXT NOT NULL, horario TEXT NOT NULL,
    qtd REAL NOT NULL, quando INTEGER NOT NULL, PRIMARY KEY (remedio, dia, horario));
  CREATE INDEX IF NOT EXISTS remedio_doses_usuario ON remedio_doses (usuario, dia);
`);
// O que foi lido da foto da caixa (a foto não fica guardada, só o texto).
try { db.exec("ALTER TABLE remedios ADD COLUMN caixa TEXT NOT NULL DEFAULT '{}'"); } catch { /* já existe */ }

// Campos da caixa: nome no rótulo, e o que a pessoa vê na tela.
export const CAMPOS_CAIXA: Record<string, string> = {
  principio: "Princípio ativo", concentracao: "Concentração", forma: "Forma", apresentacao: "Apresentação",
  laboratorio: "Laboratório", lote: "Lote", fabricacao: "Fabricação", validade: "Validade", registro: "Registro MS",
  tarja: "Tarja", receita: "Receita", generico: "Genérico", uso: "Uso", conservacao: "Conservação",
};
function caixaValida(v: unknown): Record<string, string> {
  if (v == null || v === "") return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ErroHttp(400, "campo", "Dados da caixa inválidos.");
  const saida: Record<string, string> = {};
  for (const k of Object.keys(CAMPOS_CAIXA)) {
    const t = textoCurto((v as any)[k], 120, CAMPOS_CAIXA[k].toLowerCase());
    if (t) saida[k] = t;
  }
  // Validade sempre como AAAA-MM ou AAAA-MM-DD (o aviso de vencimento usa).
  if (saida.validade && !/^\d{4}-\d{2}(-\d{2})?$/.test(saida.validade)) {
    const m = saida.validade.match(/^(\d{1,2})[\/.-](\d{4})$/) ?? saida.validade.match(/^\d{1,2}[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (m) saida.validade = `${m[2]}-${m[1].padStart(2, "0")}`;
  }
  return saida;
}

export const MAX_REMEDIOS = 30;
const PERIODOS: Record<string, string> = { manha: "08:00", tarde: "14:00", noite: "20:00" };
const NOME_PERIODO: Record<string, string> = { manha: "manhã", tarde: "tarde", noite: "noite" };
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIA_MS = 24 * 3600_000;
const somarDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (a: string, b: string) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / DIA_MS);

type Versao = { desde: string; dose: number; horarios: string[] };
type Linha = { id: string; usuario: string; nome: string; unidade: string; por_caixa: number | null; obs: string;
  inicio: string; fim: string | null; historico: string; criado: number; caixa: string };

// ---------- validação ----------
function textoCurto(v: unknown, max: number, campo: string, obrigatorio = false): string {
  const t = typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (obrigatorio && !t) throw new ErroHttp(400, "campo", `Falta ${campo}.`);
  if (t.length > max) throw new ErroHttp(400, "campo", `${campo[0].toUpperCase() + campo.slice(1)} longo demais (até ${max} letras).`);
  return t;
}
function numero(v: unknown, campo: string, min: number, max: number): number {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ErroHttp(400, "campo", `${campo} inválido.`);
  return Math.round(n * 100) / 100;
}
function data(v: unknown, campo: string): string {
  if (typeof v !== "string" || !RE_DATA.test(v) || Number.isNaN(Date.parse(v + "T12:00:00Z"))) throw new ErroHttp(400, "campo", `${campo} inválida.`);
  return v;
}
// "manhã", "Manha", "8:00", "08h" -> "manha" ou "08:00"
export function horarioValido(v: unknown): string {
  const t = String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  if (t in PERIODOS) return t;
  const m = t.match(/^(\d{1,2})(?:[:h](\d{2})?)?h?$/);
  if (m) {
    const h = `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
    if (RE_HORA.test(h)) return h;
  }
  throw new ErroHttp(400, "campo", "Horário inválido: use manhã, tarde, noite ou HH:MM.");
}
function horarios(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new ErroHttp(400, "campo", "Diga pelo menos um horário (manhã, tarde, noite ou HH:MM).");
  const lista = [...new Set(v.map(horarioValido))];
  if (lista.length > 12) throw new ErroHttp(400, "campo", "No máximo 12 horários por dia.");
  return lista.sort((a, b) => horaDe(a).localeCompare(horaDe(b)));
}
export const horaDe = (h: string) => PERIODOS[h] ?? h;
export const nomeHorario = (h: string) => NOME_PERIODO[h] ?? h;

// ---------- leitura ----------
function linhas(usuario: string): Linha[] {
  return db.prepare("SELECT * FROM remedios WHERE usuario = ? ORDER BY nome COLLATE NOCASE").all(usuario) as Linha[];
}
function linha(usuario: string, id: string): Linha {
  const l = typeof id === "string" && /^[a-f0-9]{16}$/.test(id)
    ? db.prepare("SELECT * FROM remedios WHERE usuario = ? AND id = ?").get(usuario, id) as Linha | undefined : undefined;
  if (!l) throw new ErroHttp(404, "remedio", "Não achei esse remédio.");
  return l;
}
const versoes = (l: Linha) => JSON.parse(l.historico) as Versao[];
// A versão (dose e horários) que valia num dia.
function versaoNo(l: Linha, dia: string): Versao {
  const vs = versoes(l);
  let v = vs[0];
  for (const x of vs) if (x.desde <= dia) v = x;
  return v;
}
const ativoNo = (l: Linha, dia: string) => l.inicio <= dia && (!l.fim || dia <= l.fim);

function estoque(l: Linha): number | null {
  const m = db.prepare("SELECT count(*) n, coalesce(sum(delta), 0) s FROM remedio_mov WHERE remedio = ?").get(l.id) as any;
  if (!m.n) return null;   // estoque nunca informado: sem previsão
  const t = db.prepare("SELECT coalesce(sum(qtd), 0) s FROM remedio_doses WHERE remedio = ?").get(l.id) as any;
  return Math.round((m.s - t.s) * 100) / 100;
}

export type Remedio = ReturnType<typeof paraTela>;
function paraTela(l: Linha, hoje: string) {
  const v = versaoNo(l, hoje);
  const porDia = v.dose * v.horarios.length;
  const est = estoque(l);
  const ativo = ativoNo(l, hoje) || l.inicio > hoje;
  // Dias que o estoque cobre, contando as doses de hoje que ainda faltam tomar.
  let dias: number | null = null, acabaEm: string | null = null;
  if (est !== null && porDia > 0 && ativo) {
    const tomadasHoje = (db.prepare("SELECT count(*) n FROM remedio_doses WHERE remedio = ? AND dia = ?").get(l.id, hoje) as any).n as number;
    const faltaHoje = Math.max(0, v.horarios.length - tomadasHoje) * v.dose;
    if (est < faltaHoje) { dias = 0; acabaEm = hoje; }
    else { dias = Math.floor((est - faltaHoje) / porDia); acabaEm = somarDias(hoje, dias + 1); }
  }
  const caixa = JSON.parse(l.caixa || "{}") as Record<string, string>;
  // Validade "AAAA-MM" vale até o fim do mês.
  const val = caixa.validade ? (caixa.validade.length === 7 ? somarDias(caixa.validade + "-01", 31).slice(0, 7) + "-01" : caixa.validade) : null;
  return {
    id: l.id, nome: l.nome, unidade: l.unidade, dose: v.dose, horarios: v.horarios, porDia, porCaixa: l.por_caixa,
    obs: l.obs, inicio: l.inicio, fim: l.fim, ativo, estoque: est, caixa, temCaixa: Object.keys(caixa).length > 0,
    vencido: val !== null && val <= hoje, venceLogo: val !== null && val > hoje && diasEntre(hoje, val) <= 30,
    caixas: est !== null && l.por_caixa ? Math.round((est / l.por_caixa) * 10) / 10 : null,
    dias, acabaEm, acabando: dias !== null && dias <= 7,
  };
}

export function listar(usuario: string, hoje: string) {
  return linhas(usuario).map((l) => paraTela(l, hoje));
}

// As doses de um dia, com o que já foi marcado.
export function dosesDoDia(usuario: string, dia: string) {
  const feitas = new Map((db.prepare("SELECT remedio, horario, quando FROM remedio_doses WHERE usuario = ? AND dia = ?")
    .all(usuario, dia) as any[]).map((d) => [`${d.remedio}|${d.horario}`, d.quando as number]));
  const saida: { remedio: string; nome: string; dose: number; unidade: string; horario: string; hora: string; tomado: boolean; quando: number | null }[] = [];
  for (const l of linhas(usuario)) {
    if (!ativoNo(l, dia)) continue;
    const v = versaoNo(l, dia);
    for (const h of v.horarios) {
      const q = feitas.get(`${l.id}|${h}`) ?? null;
      saida.push({ remedio: l.id, nome: l.nome, dose: v.dose, unidade: l.unidade, horario: h, hora: horaDe(h), tomado: q !== null, quando: q });
    }
  }
  return saida.sort((a, b) => a.hora.localeCompare(b.hora) || a.nome.localeCompare(b.nome));
}

export function painel(usuario: string, hoje: string, dia = hoje) {
  return { hoje, dia, remedios: listar(usuario, hoje), doses: dosesDoDia(usuario, dia) };
}

// ---------- escrita ----------
export function cadastrar(usuario: string, hoje: string, b: any) {
  if ((db.prepare("SELECT count(*) n FROM remedios WHERE usuario = ?").get(usuario) as any).n >= MAX_REMEDIOS)
    throw new ErroHttp(400, "limite", `No máximo ${MAX_REMEDIOS} remédios.`);
  const nome = textoCurto(b.nome, 80, "o nome", true);
  const igual = linhas(usuario).find((l) => l.nome.toLowerCase() === nome.toLowerCase() && (!l.fim || l.fim >= hoje));
  if (igual) throw new ErroHttp(409, "repetido", `Já tem “${igual.nome}” na lista. Para mudar, edite o que já existe.`);
  const inicio = b.inicio ? data(b.inicio, "Data de início") : hoje;
  const fim = b.fim ? data(b.fim, "Data de fim") : null;
  if (fim && fim < inicio) throw new ErroHttp(400, "campo", "O fim vem antes do início.");
  const v: Versao = { desde: inicio, dose: numero(b.dose ?? 1, "Dose", 0.05, 100), horarios: horarios(b.horarios) };
  const id = randomBytes(8).toString("hex");
  db.prepare(`INSERT INTO remedios (id, usuario, nome, unidade, por_caixa, obs, inicio, fim, historico, criado, caixa)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, usuario, nome, textoCurto(b.unidade, 30, "a unidade") || "comprimido",
    b.porCaixa != null && b.porCaixa !== "" ? numero(b.porCaixa, "Quantidade por caixa", 1, 10000) : null,
    textoCurto(b.obs, 200, "a observação"), inicio, fim, JSON.stringify([v]), Date.now(), JSON.stringify(caixaValida(b.caixa)));
  const l = linha(usuario, id);
  // Estoque inicial: em unidades, ou em caixas (com a quantidade por caixa).
  const unidades = estoqueInformado(l, b);
  if (unidades !== null) mover(l, hoje, unidades, "inicial");
  return paraTela(linha(usuario, id), hoje);
}

function estoqueInformado(l: Linha, b: any): number | null {
  const temU = b.estoque != null && b.estoque !== "";
  const temC = b.caixas != null && b.caixas !== "";
  if (!temU && !temC) return null;
  let n = temU ? numero(b.estoque, "Estoque", 0, 100000) : 0;
  if (temC) {
    if (!l.por_caixa) throw new ErroHttp(400, "campo", "Para contar em caixas, diga quantas unidades vêm em cada caixa.");
    n += numero(b.caixas, "Caixas", 0, 1000) * l.por_caixa;
  }
  return n;
}
function mover(l: Linha, dia: string, delta: number, motivo: string) {
  db.prepare("INSERT INTO remedio_mov (usuario, remedio, quando, dia, delta, motivo) VALUES (?, ?, ?, ?, ?, ?)")
    .run(l.usuario, l.id, Date.now(), dia, delta, motivo);
}

export function editar(usuario: string, hoje: string, id: string, b: any) {
  const l = linha(usuario, id);
  const nome = b.nome !== undefined ? textoCurto(b.nome, 80, "o nome", true) : l.nome;
  const unidade = b.unidade !== undefined ? (textoCurto(b.unidade, 30, "a unidade") || "comprimido") : l.unidade;
  const porCaixa = b.porCaixa !== undefined ? (b.porCaixa === null || b.porCaixa === "" ? null : numero(b.porCaixa, "Quantidade por caixa", 1, 10000)) : l.por_caixa;
  const obs = b.obs !== undefined ? textoCurto(b.obs, 200, "a observação") : l.obs;
  const fim = b.fim !== undefined ? (b.fim ? data(b.fim, "Data de fim") : null) : l.fim;
  if (fim && fim < l.inicio) throw new ErroHttp(400, "campo", "O fim vem antes do início.");
  let hist = versoes(l);
  if (b.dose !== undefined || b.horarios !== undefined) {
    const atual = versaoNo(l, hoje);
    const nova: Versao = { desde: l.inicio > hoje ? l.inicio : hoje,
      dose: b.dose !== undefined ? numero(b.dose, "Dose", 0.05, 100) : atual.dose,
      horarios: b.horarios !== undefined ? horarios(b.horarios) : atual.horarios };
    hist = hist.filter((x) => x.desde < nova.desde).concat(nova);
  }
  // Caixa: os campos enviados se somam aos que já tinha (foto nova de outra caixa atualiza lote e validade).
  const caixa = b.caixa !== undefined ? { ...JSON.parse(l.caixa || "{}"), ...caixaValida(b.caixa) } : JSON.parse(l.caixa || "{}");
  db.prepare("UPDATE remedios SET nome = ?, unidade = ?, por_caixa = ?, obs = ?, fim = ?, historico = ?, caixa = ? WHERE id = ?")
    .run(nome, unidade, porCaixa, obs, fim, JSON.stringify(hist), JSON.stringify(caixa), l.id);
  return paraTela(linha(usuario, id), hoje);
}

// Comprei: soma ao estoque, em caixas e/ou unidades.
export function comprar(usuario: string, hoje: string, id: string, b: any) {
  const l = linha(usuario, id);
  const n = estoqueInformado(l, b);
  if (!n) throw new ErroHttp(400, "campo", "Diga quantas caixas ou unidades comprou.");
  mover(l, hoje, n, "compra");
  return paraTela(linha(usuario, id), hoje);
}

// Contei o que tenho: acerta o estoque para esse número (a diferença vira um movimento de acerto).
export function acertarEstoque(usuario: string, hoje: string, id: string, b: any) {
  const l = linha(usuario, id);
  const alvo = estoqueInformado(l, b);
  if (alvo === null) throw new ErroHttp(400, "campo", "Diga quantas unidades (ou caixas) tem agora.");
  const atual = estoque(l) ?? 0;
  if (estoque(l) === null || alvo !== atual) mover(l, hoje, alvo - atual, "acerto");
  return paraTela(linha(usuario, id), hoje);
}

// Tomei / não tomei uma dose. Só de hoje para trás, até 60 dias.
export function marcarDose(usuario: string, hoje: string, b: any) {
  const l = linha(usuario, String(b.remedio ?? ""));
  const dia = data(b.dia ?? hoje, "Data");
  if (dia > hoje) throw new ErroHttp(400, "campo", "Não dá para marcar dose de um dia que ainda não chegou.");
  if (diasEntre(dia, hoje) > 60) throw new ErroHttp(400, "campo", "Só dá para marcar até 60 dias para trás.");
  if (!ativoNo(l, dia)) throw new ErroHttp(400, "campo", `“${l.nome}” não estava em uso nesse dia.`);
  const v = versaoNo(l, dia);
  const h = horarioValido(b.horario);
  if (!v.horarios.includes(h)) throw new ErroHttp(400, "campo", `“${l.nome}” não tem dose em ${nomeHorario(h)}. Horários: ${v.horarios.map(nomeHorario).join(", ")}.`);
  if (b.tomado === false) db.prepare("DELETE FROM remedio_doses WHERE remedio = ? AND dia = ? AND horario = ?").run(l.id, dia, h);
  else db.prepare(`INSERT INTO remedio_doses (usuario, remedio, dia, horario, qtd, quando) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (remedio, dia, horario) DO NOTHING`).run(usuario, l.id, dia, h, v.dose, Date.now());
  return { remedio: paraTela(linha(usuario, l.id), hoje), doses: dosesDoDia(usuario, dia) };
}

export function apagar(usuario: string, id: string) {
  const l = linha(usuario, id);
  for (const t of ["remedio_doses", "remedio_mov"]) db.prepare(`DELETE FROM ${t} WHERE remedio = ?`).run(l.id);
  db.prepare("DELETE FROM remedios WHERE id = ?").run(l.id);
  return l.nome;
}
export function nomeDe(usuario: string, id: string) { return linha(usuario, id).nome; }

export function apagarTudo(usuario: string) {
  if (!usuario) return;
  for (const t of ["remedio_doses", "remedio_mov", "remedios"]) db.prepare(`DELETE FROM ${t} WHERE usuario = ?`).run(usuario);
}

// ---------- relatório ----------
// Dia a dia, de "de" até "ate" (no máximo 92 dias): quantas doses eram, quantas foram tomadas e quais faltaram.
// Hoje entra com as doses ainda abertas como "pendentes", não como falta.
export function relatorio(usuario: string, hoje: string, de: string, ate: string) {
  de = data(de, "Data inicial");
  ate = data(ate, "Data final");
  if (ate > hoje) ate = hoje;
  if (ate < de) throw new ErroHttp(400, "campo", "Período inválido.");
  if (diasEntre(de, ate) > 92) throw new ErroHttp(400, "campo", "No máximo 3 meses por vez.");
  const ls = linhas(usuario);
  const feitas = new Set((db.prepare("SELECT remedio, dia, horario FROM remedio_doses WHERE usuario = ? AND dia BETWEEN ? AND ?")
    .all(usuario, de, ate) as any[]).map((d) => `${d.remedio}|${d.dia}|${d.horario}`));
  const porRemedio = new Map(ls.map((l) => [l.id, { id: l.id, nome: l.nome, previstas: 0, tomadas: 0, faltas: 0, pendentes: 0 }]));
  const dias: { dia: string; previstas: number; tomadas: number; pendentes: number; faltas: { remedio: string; nome: string; horario: string }[] }[] = [];
  for (let d = de; d <= ate; d = somarDias(d, 1)) {
    const r = { dia: d, previstas: 0, tomadas: 0, pendentes: 0, faltas: [] as { remedio: string; nome: string; horario: string }[] };
    for (const l of ls) {
      if (!ativoNo(l, d)) continue;
      const pr = porRemedio.get(l.id)!;
      for (const h of versaoNo(l, d).horarios) {
        r.previstas++;
        if (feitas.has(`${l.id}|${d}|${h}`)) { r.tomadas++; pr.tomadas++; pr.previstas++; }
        else if (d === hoje) { r.pendentes++; pr.pendentes++; }
        else { r.faltas.push({ remedio: l.id, nome: l.nome, horario: h }); pr.faltas++; pr.previstas++; }
      }
    }
    if (r.previstas) dias.push(r);
  }
  const previstas = dias.reduce((s, d) => s + d.previstas - d.pendentes, 0);
  const tomadas = dias.reduce((s, d) => s + d.tomadas, 0);
  return {
    de, ate, dias,
    remedios: [...porRemedio.values()].filter((r) => r.previstas || r.pendentes),
    total: { previstas, tomadas, faltas: previstas - tomadas,
      diasCompletos: dias.filter((d) => !d.faltas.length && !d.pendentes).length,
      diasComFalta: dias.filter((d) => d.faltas.length).length,
      adesao: previstas ? Math.round((tomadas / previstas) * 100) : null },
  };
}

// ---------- avisos (push.ts) ----------
// Na hora de cada horário (até 2 horas depois), o que ainda não foi tomado; de manhã, o que está acabando.
export function avisosDeRemedio(usuario: string, hoje: string, hora: string, jaFoi: (chave: string) => boolean) {
  const saida: { chave: string; aviso: { titulo: string; texto: string; tag: string; url: string } | null }[] = [];
  const doses = dosesDoDia(usuario, hoje).filter((d) => !d.tomado);
  const minutos = (h: string) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  const agoraMin = minutos(hora);
  const porHora = new Map<string, typeof doses>();
  for (const d of doses) {
    const m = minutos(d.hora);
    if (agoraMin >= m && agoraMin < m + 120) porHora.set(d.horario, [...(porHora.get(d.horario) ?? []), d]);
  }
  for (const [h, ds] of porHora) {
    const chave = `remedio|${hoje}|${h}`;
    if (jaFoi(chave)) continue;
    const quando = h in PERIODOS ? `da ${nomeHorario(h)}` : `das ${h}`;
    saida.push({ chave, aviso: { titulo: `Remédios ${quando}`, texto: ds.map((d) => `${d.nome} (${fmt(d.dose)} ${d.unidade})`).join(" · "),
      tag: `remedio-${h}`, url: "/#remedios" } });
  }
  if (agoraMin >= 8 * 60 && agoraMin < 12 * 60 && !jaFoi(`remedio-acabando|${hoje}`)) {
    const todos = listar(usuario, hoje).filter((r) => r.ativo);
    const acabando = todos.filter((r) => r.dias !== null && r.dias <= 5);
    const vencendo = todos.filter((r) => r.vencido);
    const partes = [
      ...acabando.map((r) => `${r.nome}: ${r.dias === 0 ? "acaba hoje" : r.dias === 1 ? "dá até amanhã" : `dá para ${r.dias} dias`}`),
      ...vencendo.map((r) => `${r.nome}: caixa vencida`),
    ];
    saida.push({ chave: `remedio-acabando|${hoje}`, aviso: partes.length ? {
      titulo: acabando.length ? "Remédio acabando" : "Remédio vencido", tag: "remedio-acabando", url: "/#remedios",
      texto: partes.join(" · ") + (acabando.length ? ". Hora de comprar." : "."),
    } : null });
  }
  return saida;
}
export const fmt = (n: number) => String(n).replace(".", ",");
