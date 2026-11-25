// A agenda local (usada pela demonstração) tem de se comportar como o Google Calendar no que a IAgenda usa.
import "./ambiente.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarioLocal, semear, apagarTudo, ErroLimite } from "../../calendario-local.ts";
import { montarEvento } from "../../agenda.ts";

const TZ = "America/Sao_Paulo";
let n = 0;
const nova = () => `pessoa-${++n}`;
const api = (uid: string, metodo: string, caminho: string, corpo?: any, tz = TZ) => calendarioLocal(uid, metodo, caminho, corpo, tz);
const criar = (uid: string, b: any, tz = TZ) => api(uid, "POST", "/calendars/primary/events", montarEvento(b, tz, true), tz).corpo as any;
const listar = (uid: string, de: string, ate: string, extra = "", tz = TZ) =>
  (api(uid, "GET", `/calendars/primary/events?timeMin=${de}T00:00:00-03:00&timeMax=${ate}T00:00:00-03:00&singleEvents=true${extra}`, undefined, tz).corpo as any).items as any[];
const ev = (id: string) => `/calendars/primary/events/${encodeURIComponent(id)}`;

test("devolve o fuso da agenda", () => {
  assert.deepEqual(api(nova(), "GET", "/calendars/primary").corpo, { id: "primary", timeZone: TZ });
});

test("evento com hora ganha o desvio do fuso e aparece só no período certo", () => {
  const u = nova();
  const e = criar(u, { titulo: "Dentista", data: "2026-12-01", diaInteiro: false, hora: "23:30", horaFim: "23:59" });
  assert.equal(e.start.dateTime, "2026-12-01T23:30:00-03:00");
  assert.equal(e.organizer.self, true);
  assert.equal(listar(u, "2026-12-01", "2026-12-02").length, 1);
  assert.equal(listar(u, "2026-12-02", "2026-12-03").length, 0);
});

test("série semanal: abre as repetições, uma mudada vira exceção e apagar uma não apaga as outras", () => {
  const u = nova();
  const s = criar(u, { titulo: "Academia", data: "2026-11-02", diaInteiro: false, hora: "07:00", repetir: "semanal" });
  let itens = listar(u, "2026-11-01", "2026-12-01");
  assert.deepEqual(itens.map((i) => i.start.dateTime.slice(0, 10)), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.ok(itens.every((i) => i.recurringEventId === s.id && i.id === `${s.id}_${i.start.dateTime.slice(0, 10).replace(/-/g, "")}`));

  const mudada = api(u, "PATCH", ev(`${s.id}_20261109`), { summary: "Academia (perna)", start: { dateTime: "2026-11-10T18:00:00", timeZone: TZ }, end: { dateTime: "2026-11-10T19:00:00", timeZone: TZ } });
  assert.equal(mudada.status, 200);
  assert.equal(api(u, "DELETE", ev(`${s.id}_20261116`)).status, 204);
  itens = listar(u, "2026-11-01", "2026-12-01");
  assert.deepEqual(itens.map((i) => `${i.start.dateTime.slice(0, 16)} ${i.summary}`), [
    "2026-11-02T07:00 Academia", "2026-11-10T18:00 Academia (perna)", "2026-11-23T07:00 Academia", "2026-11-30T07:00 Academia",
  ]);
  assert.equal(api(u, "GET", ev(`${s.id}_20261116`)).status, 404);
  // Uma data que não é da série não existe.
  assert.equal(api(u, "GET", ev(`${s.id}_20261105`)).status, 404);

  // Apagar a série leva junto as exceções.
  assert.equal(api(u, "DELETE", ev(s.id)).status, 204);
  assert.equal(listar(u, "2026-11-01", "2026-12-01").length, 0);
});

test("mensal no dia 31 pula os meses que não têm 31, como no Google", () => {
  const u = nova();
  criar(u, { tipo: "conta", titulo: "Cartão", data: "2026-01-31", valor: 100, repetir: "mensal" });
  const datas = listar(u, "2026-01-01", "2026-06-01").map((i) => i.start.date);
  assert.deepEqual(datas, ["2026-01-31", "2026-03-31", "2026-05-31"]);
});

test("série diária antiga não demora: pula direto para o período pedido", () => {
  const u = nova();
  criar(u, { titulo: "Remédio", data: "2020-01-01", repetir: "diario" });
  const t = performance.now();
  assert.equal(listar(u, "2026-11-01", "2026-11-08").length, 7);
  assert.ok(performance.now() - t < 500);
});

test("horário de verão: a hora local se mantém nas repetições", () => {
  const u = nova();
  const NY = "America/New_York";
  criar(u, { titulo: "Aula", data: "2026-10-26", diaInteiro: false, hora: "09:00", repetir: "semanal" }, NY);
  const q = (a: string, b: string) => (api(u, "GET", `/calendars/primary/events?timeMin=${a}T00:00:00Z&timeMax=${b}T00:00:00Z`, undefined, NY).corpo as any).items;
  const horas = q("2026-10-25", "2026-11-12").map((i: any) => i.start.dateTime);
  assert.deepEqual(horas, ["2026-10-26T09:00:00-04:00", "2026-11-02T09:00:00-05:00", "2026-11-09T09:00:00-05:00"]);
});

test("filtro por marca particular (só as contas)", () => {
  const u = nova();
  criar(u, { titulo: "Reunião", data: "2026-12-01" });
  criar(u, { tipo: "conta", titulo: "Luz", data: "2026-12-01", valor: 10 });
  const contas = listar(u, "2026-12-01", "2026-12-02", "&privateExtendedProperty=icarusTipo%3Dconta");
  assert.deepEqual(contas.map((c) => c.summary), ["Luz"]);
});

test("PATCH junta a marca particular em vez de trocar", () => {
  const u = nova();
  const c = criar(u, { tipo: "conta", titulo: "Luz", data: "2026-12-01", valor: 10, categoria: "Casa" });
  const r = api(u, "PATCH", ev(c.id), { extendedProperties: { private: { icarusFeito: "1" } } }).corpo as any;
  assert.deepEqual(r.extendedProperties.private, { icarusTipo: "conta", icarusValor: "10.00", icarusCategoria: "Casa", icarusCriado: "1", icarusFeito: "1" });
});

test("convite de outra pessoa: dá para marcar feito, não dá para mudar nome nem hora", () => {
  const u = nova();
  semear(u, { id: "convite1", summary: "Planejamento", start: { dateTime: "2026-12-03T09:30:00", timeZone: TZ }, end: { dateTime: "2026-12-03T10:30:00", timeZone: TZ }, organizer: { email: "x@empresa.exemplo" } }, TZ);
  assert.equal(api(u, "PATCH", ev("convite1"), { summary: "hackeado" }).status, 403);
  assert.equal(api(u, "PATCH", ev("convite1"), { extendedProperties: { private: { icarusFeito: "1" } } }).status, 200);
});

test("cada pessoa só vê a própria agenda", () => {
  const a = nova(), b = nova();
  const e = criar(a, { titulo: "Segredo", data: "2026-12-01" });
  assert.equal(listar(b, "2026-11-01", "2027-01-01").length, 0);
  assert.equal(api(b, "GET", ev(e.id)).status, 404);
  assert.equal(api(b, "DELETE", ev(e.id)).status, 404);
  assert.equal(listar(a, "2026-11-01", "2027-01-01").length, 1);
});

test("apagar com curinga do SQL no id não apaga o que não devia", () => {
  const u = nova();
  criar(u, { titulo: "Fica", data: "2026-12-01" });
  assert.equal(api(u, "DELETE", ev("%")).status, 404);
  assert.equal(api(u, "DELETE", ev("_")).status, 404);
  assert.equal(listar(u, "2026-11-01", "2027-01-01").length, 1);
});

test("limite de eventos por pessoa", () => {
  const u = nova();
  for (let i = 0; i < 300; i++) criar(u, { titulo: "e" + i, data: "2026-12-01" });
  assert.throws(() => criar(u, { titulo: "um a mais", data: "2026-12-01" }), ErroLimite);
  apagarTudo(u);
  assert.equal(listar(u, "2026-11-01", "2027-01-01").length, 0);
});
