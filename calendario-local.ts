// agenda-web: uma agenda guardada aqui mesmo (SQLite), que responde como a API do Google Calendar no pedaço que a
// IAgenda usa. Serve às pessoas do modo demonstração (demo.ts): agenda.ts manda para cá, no lugar do Google, os
// pedidos delas, e o resto do código (página, chat, avisos) não sabe a diferença.
//
// Cobre: GET /calendars/primary; GET e POST /calendars/primary/events (timeMin, timeMax, singleEvents,
// privateExtendedProperty); GET, PATCH e DELETE /calendars/primary/events/:id. Repetição: RRULE:FREQ=DAILY, WEEKLY,
// MONTHLY ou YEARLY, sem fim. Uma repetição mudada ou apagada vira uma exceção, como no Google.
import { randomBytes } from "node:crypto";
import { db } from "./banco.ts";

const DIA = 24 * 3600_000;
const MAX_EVENTOS = 300;   // por pessoa, contando exceções

db.exec(`CREATE TABLE IF NOT EXISTS cal_eventos (usuario TEXT NOT NULL, id TEXT NOT NULL, dados TEXT NOT NULL,
  PRIMARY KEY (usuario, id))`);

export class ErroLimite extends Error {}
export type Resposta = { status: number; corpo?: unknown };
type Ev = any;

// ---------- horas no fuso ----------
function partes(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}` };
}
const desvio = (t: number, tz: string) => { const p = partes(t, tz); return (Date.parse(`${p.data}T${p.hora}Z`) - t) / 60_000; };
// "2026-11-25T15:00:00" no fuso tz -> instante (ms).
function instante(local: string, tz: string): number {
  const base = Date.parse(local.slice(0, 19) + "Z");
  let t = base - desvio(base, tz) * 60_000;
  const d2 = desvio(t, tz);
  if (base - d2 * 60_000 !== t) t = base - d2 * 60_000;
  return t;
}
// Instante -> "2026-11-25T15:00:00-03:00" (como o Google devolve).
function comDesvio(t: number, tz: string): string {
  const p = partes(t, tz);
  const d = desvio(t, tz);
  const s = d < 0 ? "-" : "+";
  const a = Math.abs(d);
  return `${p.data}T${p.hora}${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const temDesvio = (s: string) => /([+-]\d{2}:\d{2}|Z)$/.test(s);
// Começo e fim (ms) de um evento: dia inteiro conta da meia-noite no fuso.
function intervalo(e: Ev, tz: string): [number, number] {
  const ini = e.start?.date ? instante(e.start.date + "T00:00:00", tz) : Date.parse(e.start?.dateTime);
  const fim = e.end?.date ? instante(e.end.date + "T00:00:00", tz) : Date.parse(e.end?.dateTime);
  return [ini, fim];
}
// start/end vindos de montarEvento ({ dateTime sem desvio, timeZone }) -> com o desvio do fuso.
function acertarHoras(e: Ev, tz: string) {
  for (const k of ["start", "end"]) {
    const x = e[k];
    if (x?.dateTime && !temDesvio(x.dateTime)) e[k] = { dateTime: comDesvio(instante(x.dateTime, x.timeZone || tz), x.timeZone || tz), timeZone: x.timeZone || tz };
  }
  return e;
}

// ---------- guardar ----------
function ler(uid: string, id: string): Ev | null {
  const l = db.prepare("SELECT dados FROM cal_eventos WHERE usuario = ? AND id = ?").get(uid, id) as any;
  return l ? JSON.parse(l.dados) : null;
}
function gravar(uid: string, e: Ev, novo = false) {
  if (novo && (db.prepare("SELECT count(*) n FROM cal_eventos WHERE usuario = ?").get(uid) as any).n >= MAX_EVENTOS) throw new ErroLimite();
  db.prepare("INSERT OR REPLACE INTO cal_eventos (usuario, id, dados) VALUES (?, ?, ?)").run(uid, e.id, JSON.stringify(e));
}
function todos(uid: string): Ev[] {
  return (db.prepare("SELECT dados FROM cal_eventos WHERE usuario = ?").all(uid) as any[]).map((l) => JSON.parse(l.dados));
}
export function apagarTudo(uid: string) { db.prepare("DELETE FROM cal_eventos WHERE usuario = ?").run(uid); }

// Para semear (demo.ts): grava um evento já no formato do Google.
export function semear(uid: string, e: Ev, tz: string) {
  gravar(uid, acertarHoras({ organizer: { self: true }, ...e, id: e.id ?? novoId() }, tz));
}
const novoId = () => "l" + randomBytes(10).toString("hex");

// ---------- repetição ----------
const ymd = (d: string) => d.replace(/-/g, "");
function somarDias(d: string, n: number) { return new Date(Date.parse(d + "T12:00:00Z") + n * DIA).toISOString().slice(0, 10); }
// i-ésima repetição (data) a partir de d; null se esse mês ou ano não tem o dia (31, 29 de fevereiro), como no Google.
function repeticao(d: string, freq: string, i: number): string | null {
  if (freq === "DAILY") return somarDias(d, i);
  if (freq === "WEEKLY") return somarDias(d, 7 * i);
  const [a, m, dd] = d.split("-").map(Number);
  const x = freq === "MONTHLY" ? new Date(Date.UTC(a, m - 1 + i, dd)) : new Date(Date.UTC(a + i, m - 1, dd));
  return x.getUTCDate() === dd ? x.toISOString().slice(0, 10) : null;
}
function instancia(base: Ev, data: string, tz: string): Ev {
  const id = `${base.id}_${ymd(data)}`;
  const inst: Ev = { ...base, id, recurringEventId: base.id, recurrence: undefined };
  if (base.start.date) {
    const dias = Math.round((Date.parse(base.end.date) - Date.parse(base.start.date)) / DIA);
    inst.start = { date: data };
    inst.end = { date: somarDias(data, dias) };
    inst.originalStartTime = { date: data };
  } else {
    const [ini, fim] = intervalo(base, tz);
    const t = instante(`${data}T${partes(ini, tz).hora}`, tz);
    inst.start = { dateTime: comDesvio(t, tz), timeZone: tz };
    inst.end = { dateTime: comDesvio(t + (fim - ini), tz), timeZone: tz };
    inst.originalStartTime = inst.start;
  }
  return inst;
}
// Data da série que corresponde ao id de uma instância ("abc_20261125"), se for mesmo uma repetição dela.
function dataDaInstancia(base: Ev, id: string, tz: string): string | null {
  const m = id.match(/_(\d{4})(\d{2})(\d{2})$/);
  if (!m || !base?.recurrence) return null;
  const alvo = `${m[1]}-${m[2]}-${m[3]}`;
  const freq = freqDe(base);
  const ini = base.start.date ?? partes(intervalo(base, tz)[0], tz).data;
  for (let i = 0; i < 5000; i++) {
    const d = repeticao(ini, freq, i);
    if (d === alvo) return d;
    if (d && d > alvo) return null;
  }
  return null;
}
const freqDe = (e: Ev) => (String(e.recurrence?.[0] ?? "").match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/)?.[1] ?? "WEEKLY");

function expandir(uid: string, de: number, ate: number, tz: string): Ev[] {
  const lista = todos(uid);
  const excecoes = new Map(lista.filter((e) => e.recurringEventId).map((e) => [e.id, e]));
  const saida: Ev[] = [];
  const dentro = (e: Ev) => { const [i, f] = intervalo(e, tz); return f > de && i < ate; };
  for (const e of lista) {
    if (e.recurringEventId) continue;
    if (!e.recurrence) { if (dentro(e)) saida.push(e); continue; }
    const freq = freqDe(e);
    const ini = e.start.date ?? partes(intervalo(e, tz)[0], tz).data;
    // Diária e semanal: pula direto para perto do período pedido.
    const passo = freq === "DAILY" ? 1 : freq === "WEEKLY" ? 7 : 0;
    let i = passo ? Math.max(0, Math.floor((de - Date.parse(ini + "T00:00:00Z")) / (passo * DIA)) - 2) : 0;
    for (let n = 0; n < 2000; n++, i++) {
      const d = repeticao(ini, freq, i);
      if (d === null) continue;
      if (instante(d + "T00:00:00", tz) >= ate) break;
      const x = excecoes.get(`${e.id}_${ymd(d)}`);
      if (x?.status === "cancelled") continue;
      const inst = x ?? instancia(e, d, tz);
      if (dentro(inst)) saida.push(inst);
    }
  }
  // Exceção que mudou de dia para dentro do período (a repetição original estava fora).
  for (const x of excecoes.values()) if (x.status !== "cancelled" && !saida.includes(x) && dentro(x)) saida.push(x);
  return saida.sort((a, b) => intervalo(a, tz)[0] - intervalo(b, tz)[0]);
}

function achar(uid: string, id: string, tz: string): { e: Ev; guardado: boolean } | null {
  const e = ler(uid, id);
  if (e) return e.status === "cancelled" ? null : { e, guardado: true };
  const m = id.match(/^(.+)_\d{8}$/);
  const base = m ? ler(uid, m[1]) : null;
  const d = base ? dataDaInstancia(base, id, tz) : null;
  return d ? { e: instancia(base, d, tz), guardado: false } : null;
}

// PATCH como no Google: troca os campos enviados; em extendedProperties.private, só as chaves enviadas.
function mesclar(a: Ev, b: Ev): Ev {
  const r = { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k === "id" || k === "organizer" || k === "recurringEventId") continue;
    if (k === "extendedProperties") r[k] = { private: { ...(a[k]?.private ?? {}), ...((v as any)?.private ?? {}) } };
    else r[k] = v;
  }
  return r;
}

// ---------- a "API" ----------
export function calendarioLocal(uid: string, metodo: string, caminho: string, corpo: any, tz: string): Resposta {
  const url = new URL(caminho, "http://x");
  const p = url.pathname;
  if (p === "/calendars/primary" && metodo === "GET") return { status: 200, corpo: { id: "primary", timeZone: tz } };
  if (p === "/calendars/primary/events" && metodo === "GET") {
    const de = Date.parse(url.searchParams.get("timeMin") ?? ""), ate = Date.parse(url.searchParams.get("timeMax") ?? "");
    if (!de || !ate) return { status: 400 };
    let itens = expandir(uid, de, ate, tz);
    const filtro = url.searchParams.get("privateExtendedProperty");
    if (filtro) { const [k, v] = filtro.split("="); itens = itens.filter((e) => e.extendedProperties?.private?.[k] === v); }
    return { status: 200, corpo: { items: itens.slice(0, 2500) } };
  }
  if (p === "/calendars/primary/events" && metodo === "POST") {
    const e = acertarHoras({ ...corpo, id: novoId(), organizer: { self: true }, created: new Date().toISOString() }, tz);
    gravar(uid, e, true);
    return { status: 200, corpo: e };
  }
  const m = p.match(/^\/calendars\/primary\/events\/([^/]+)$/);
  if (!m) return { status: 404 };
  const id = decodeURIComponent(m[1]);
  const achado = achar(uid, id, tz);
  if (!achado) return { status: 404 };
  const { e, guardado } = achado;
  if (metodo === "GET") return { status: 200, corpo: e };
  if (metodo === "PATCH") {
    if (!e.organizer?.self && (corpo?.summary !== undefined || corpo?.start)) return { status: 403 };
    const novo = acertarHoras(mesclar(e, corpo), tz);
    gravar(uid, novo, !guardado);
    return { status: 200, corpo: novo };
  }
  if (metodo === "DELETE") {
    if (guardado && !e.recurringEventId) {
      // Evento solto ou a série inteira (com as exceções dela).
      db.prepare("DELETE FROM cal_eventos WHERE usuario = ? AND (id = ? OR id LIKE ? ESCAPE '\\')").run(uid, id, id.replace(/[\\%_]/g, "\\$&") + "\\_%");
    } else gravar(uid, { id, recurringEventId: e.recurringEventId, status: "cancelled", start: e.start, end: e.end }, !guardado);
    return { status: 204 };
  }
  return { status: 405 };
}
