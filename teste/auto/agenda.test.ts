import "./ambiente.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { valorValido, dataValida, texto, idValido, montarEvento, normalizar, partesNoFuso, ErroHttp } from "../../agenda.ts";

const TZ = "America/Sao_Paulo";
const erro400 = (f: () => unknown) => assert.throws(f, (e: any) => e instanceof ErroHttp && e.status === 400);

test("valorValido aceita os jeitos comuns de escrever dinheiro", () => {
  assert.equal(valorValido("1.234,56"), 1234.56);
  assert.equal(valorValido("R$ 99,90"), 99.9);
  assert.equal(valorValido("1234.5"), 1234.5);
  assert.equal(valorValido(99), 99);
  assert.equal(valorValido(10.005), 10.01);
});

test("valorValido recusa zero, negativo, texto e valores absurdos", () => {
  for (const v of [0, -5, "abc", "1,2,3", "", null, undefined, 20_000_000, "12.345"]) erro400(() => valorValido(v));
});

test("dataValida confere o calendário de verdade", () => {
  assert.equal(dataValida("2026-02-28", "data"), "2026-02-28");
  assert.equal(dataValida("2028-02-29", "data"), "2028-02-29");
  for (const d of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", 20260101, "2026-02-29"]) erro400(() => dataValida(d, "data"));
});

test("texto tira caracteres de controle e respeita o tamanho", () => {
  assert.equal(texto("  oi\u0000\u0007 ", 10, "x"), "oi");
  assert.equal(texto(null, 10, "x"), "");
  erro400(() => texto("x".repeat(11), 10, "x"));
  erro400(() => texto(42, 10, "x"));
});

test("idValido barra caminhos e caracteres estranhos", () => {
  assert.equal(idValido("abc_20261125"), "abc_20261125");
  for (const id of ["../x", "a/b", "a b", "", "a%2F", "x".repeat(251)]) erro400(() => idValido(id));
});

test("montarEvento: dia inteiro termina no dia seguinte (fim exclusivo, como no Google)", () => {
  const ev = montarEvento({ titulo: "Viagem", data: "2026-12-20", dataFim: "2026-12-22" }, TZ, true);
  assert.deepEqual(ev.start, { date: "2026-12-20" });
  assert.deepEqual(ev.end, { date: "2026-12-23" });
  assert.equal(ev.extendedProperties.private.icarusCriado, "1");
});

test("montarEvento: com hora, sem fim, dura 1 hora; lembretes 1 dia e 1 hora antes", () => {
  const ev = montarEvento({ titulo: "Dentista", data: "2026-12-01", diaInteiro: false, hora: "15:00" }, TZ, true);
  assert.deepEqual(ev.start, { dateTime: "2026-12-01T15:00:00", timeZone: TZ });
  assert.deepEqual(ev.end, { dateTime: "2026-12-01T16:00:00", timeZone: TZ });
  assert.deepEqual(ev.reminders.overrides.map((o: any) => o.minutes), [1440, 60]);
});

test("montarEvento: conta é de dia inteiro, com valor e categoria na marca particular", () => {
  const ev = montarEvento({ tipo: "conta", titulo: "Luz", data: "2026-12-10", diaInteiro: false, hora: "10:00", valor: "180,50", categoria: "Casa", repetir: "mensal" }, TZ, true);
  assert.deepEqual(ev.start, { date: "2026-12-10" });
  assert.deepEqual(ev.recurrence, ["RRULE:FREQ=MONTHLY"]);
  assert.equal(ev.extendedProperties.private.icarusTipo, "conta");
  assert.equal(ev.extendedProperties.private.icarusValor, "180.50");
  assert.equal(ev.extendedProperties.private.icarusCategoria, "Casa");
  const outra = montarEvento({ tipo: "conta", titulo: "X", data: "2026-12-10", valor: 5, categoria: "Inventada" }, TZ, true);
  assert.equal(outra.extendedProperties.private.icarusCategoria, "Outros");
});

test("montarEvento recusa o que não faz sentido", () => {
  erro400(() => montarEvento({ titulo: "", data: "2026-12-01" }, TZ, true));
  erro400(() => montarEvento({ titulo: "a", data: "2026-12-05", dataFim: "2026-12-01" }, TZ, true));
  erro400(() => montarEvento({ titulo: "a", data: "2026-12-01", diaInteiro: false }, TZ, true));
  erro400(() => montarEvento({ titulo: "a", data: "2026-12-01", diaInteiro: false, hora: "15:00", horaFim: "14:00" }, TZ, true));
  erro400(() => montarEvento({ titulo: "a", data: "2026-12-01", repetir: "quinzenal" }, TZ, true));
  erro400(() => montarEvento({ tipo: "conta", titulo: "a", data: "2026-12-01" }, TZ, true));
});

test("normalizar tira o ✓ do título, lê o feito, a conta e o HTML da descrição", () => {
  const e = normalizar({
    id: "x1", summary: "✓ Luz", start: { date: "2026-12-10" }, end: { date: "2026-12-11" }, organizer: { self: true },
    description: "<b>código</b><br>123 &amp; 456",
    extendedProperties: { private: { icarusTipo: "conta", icarusValor: "180.50", icarusCategoria: "Casa" } },
  });
  assert.equal(e.titulo, "Luz");
  assert.equal(e.feito, true);
  assert.equal(e.tipo, "conta");
  assert.equal(e.valor, 180.5);
  assert.equal(e.descricao, "código\n123 & 456");
  assert.equal(e.podeEditar, true);
});

test("normalizar: convite de outra pessoa não é editável e mostra quem organizou", () => {
  const e = normalizar({ id: "x2", summary: "Reunião", start: { dateTime: "2026-12-01T10:00:00-03:00" }, end: { dateTime: "2026-12-01T11:00:00-03:00" }, organizer: { email: "chefe@empresa.exemplo", displayName: "Chefe" } });
  assert.equal(e.podeEditar, false);
  assert.equal(e.organizador, "Chefe");
  assert.equal(e.feito, false);
  // "✓" no título, mas desmarcado de propósito na marca particular: vale a marca.
  assert.equal(normalizar({ id: "x", summary: "✓ a", start: { date: "2026-01-01" }, extendedProperties: { private: { icarusFeito: "0" } } }).feito, false);
});

test("partesNoFuso converte o instante para o fuso da agenda", () => {
  assert.deepEqual(partesNoFuso("2026-12-01T02:30:00Z", TZ), { data: "2026-11-30", hora: "23:30" });
  assert.deepEqual(partesNoFuso("2026-07-01T12:00:00Z", "America/New_York"), { data: "2026-07-01", hora: "08:00" });
});
