import "./ambiente.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as remedios from "../../remedios.ts";
import * as auth from "../../auth.ts";
import * as fn from "../../funcoes.ts";
import { ErroHttp } from "../../agenda.ts";
import { db } from "../../banco.ts";

// ---------- remédios ----------
const HOJE = "2026-12-10";
test("estoque desce com as doses e avisa quando está acabando", () => {
  const u = "rem-1";
  const r = remedios.cadastrar(u, HOJE, { nome: "Losartana 50 mg", dose: 1, horarios: ["manha", "noite"], porCaixa: 30, estoque: 10, inicio: "2026-12-08" });
  assert.equal(r.estoque, 10);
  assert.equal(r.dias, 4);          // 10 comprimidos, 2 por dia, contando as 2 de hoje ainda abertas
  remedios.marcarDose(u, HOJE, { remedio: r.id, dia: HOJE, horario: "manha", tomado: true });
  const depois = remedios.listar(u, HOJE)[0];
  assert.equal(depois.estoque, 9);
  assert.equal(depois.acabando, true);
  // Desmarcar devolve ao estoque.
  remedios.marcarDose(u, HOJE, { remedio: r.id, dia: HOJE, horario: "manha", tomado: false });
  assert.equal(remedios.listar(u, HOJE)[0].estoque, 10);
  remedios.comprar(u, HOJE, r.id, { caixas: 1 });
  assert.equal(remedios.listar(u, HOJE)[0].estoque, 40);
});

test("relatório: falta é o que passou sem marcar; hoje fica como pendente", () => {
  const u = "rem-2";
  const r = remedios.cadastrar(u, HOJE, { nome: "Vitamina D", dose: 1, horarios: ["manha"], inicio: "2026-12-07" });
  for (const dia of ["2026-12-07", "2026-12-09"]) remedios.marcarDose(u, HOJE, { remedio: r.id, dia, horario: "manha", tomado: true });
  const rel = remedios.relatorio(u, HOJE, "2026-12-07", HOJE);
  assert.deepEqual(rel.dias.map((d) => [d.dia, d.faltas.length, d.pendentes]), [["2026-12-07", 0, 0], ["2026-12-08", 1, 0], ["2026-12-09", 0, 0], ["2026-12-10", 0, 1]]);
  assert.equal(rel.total.adesao, 67);
});

test("remédios: validações", () => {
  const u = "rem-3";
  const bad = (f: () => unknown) => assert.throws(f, ErroHttp);
  bad(() => remedios.cadastrar(u, HOJE, { nome: "", horarios: ["manha"] }));
  bad(() => remedios.cadastrar(u, HOJE, { nome: "X", horarios: [] }));
  bad(() => remedios.cadastrar(u, HOJE, { nome: "X", horarios: ["25:00"] }));
  const r = remedios.cadastrar(u, HOJE, { nome: "X", horarios: ["manha"] });
  bad(() => remedios.cadastrar(u, HOJE, { nome: "x", horarios: ["noite"] }));   // nome repetido
  bad(() => remedios.marcarDose(u, HOJE, { remedio: r.id, dia: "2026-12-11", horario: "manha" }));   // amanhã
  bad(() => remedios.marcarDose(u, HOJE, { remedio: r.id, dia: HOJE, horario: "noite" }));   // horário que não tem
  bad(() => remedios.marcarDose("outra-pessoa", HOJE, { remedio: r.id, dia: HOJE, horario: "manha" }));
});

test("funções: padrão, mudar e recusar valor que não é sim/não", () => {
  assert.deepEqual(fn.funcoes("f-1"), { compromissos: true, contas: true, remedios: false });
  assert.deepEqual(fn.mudar("f-1", { remedios: true }), { compromissos: true, contas: true, remedios: true });
  assert.throws(() => fn.mudar("f-1", { contas: "sim" }), ErroHttp);
  assert.throws(() => fn.exigir(fn.funcoes("f-2"), "remedios"), (e: any) => e.status === 403);
});

// ---------- sessões e login ----------
test("sessão: o banco guarda só o hash, e ela vence", () => {
  const uid = auth.criarVisitante("Teste");
  const valor = auth.abrirSessao(uid);
  assert.match(valor, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(auth.lerSessao(valor)?.id, uid);
  const guardado = db.prepare("SELECT hash FROM sessoes WHERE usuario = ?").get(uid) as any;
  assert.notEqual(guardado.hash, valor);
  assert.equal(auth.lerSessao(valor.slice(0, -1) + (valor.endsWith("A") ? "B" : "A")), null);
  assert.equal(auth.lerSessao("curto"), null);
  auth.fecharSessao(valor);
  assert.equal(auth.lerSessao(valor), null);
  const vencida = auth.abrirSessao(uid, -1000);
  assert.equal(auth.lerSessao(vencida), null);
});

test("visitante da demonstração é marcado e fica fora da lista de pessoas", () => {
  const uid = auth.criarVisitante("Visitante");
  assert.equal(auth.ehDemo(uid), true);
  assert.equal(auth.listar().usuarios.some((u: any) => u.id === uid), false);
  assert.ok(auth.listar().visitantes >= 1);
  assert.equal(auth.ehDemo("nao-existe"), false);
});

test("convites: variável de ambiente, banco e tirar", () => {
  assert.equal(auth.convidado("Fulana@Gmail.com "), true);
  assert.equal(auth.convidado("beltrano@gmail.com"), false);
  auth.convidar("beltrano@gmail.com");
  assert.equal(auth.convidado("beltrano@gmail.com"), true);
  auth.tirarConvite("beltrano@gmail.com");
  assert.equal(auth.convidado("beltrano@gmail.com"), false);
  assert.throws(() => auth.convidar("não é e-mail"));
});

test("início do login: PKCE S256, state aleatório, acesso offline e só o escopo da agenda", () => {
  const a = auth.inicio(false), b = auth.inicio(true);
  const q = new URL(a.url).searchParams;
  assert.notEqual(a.state, b.state);
  assert.equal(q.get("state"), a.state);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:8091/auth/google/retorno");
  assert.deepEqual(q.get("scope")!.split(" ").sort(), ["email", "https://www.googleapis.com/auth/calendar.events", "openid", "profile"]);
  assert.equal(new URL(b.url).searchParams.get("prompt"), "consent select_account");
});

test("volta do login: sem o cookie certo, cancelado ou com state desconhecido não entra", async () => {
  const { state } = auth.inicio(false);
  const codigo = async (q: Record<string, string>, cookie: string | null) => {
    try { await auth.retorno(new URLSearchParams(q), cookie); return "entrou"; } catch (e) { return (e as Error).message; }
  };
  assert.equal(await codigo({ state, code: "x" }, null), "expirou");
  assert.equal(await codigo({ state, code: "x" }, "outro-state"), "expirou");
  assert.equal(await codigo({ state: "inventado", code: "x" }, "inventado"), "expirou");
  assert.equal(await codigo({ error: "access_denied", state }, state), "cancelado");
});
