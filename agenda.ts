// agenda-web: o que fala com a agenda Google da pessoa. Usado pela página (servidor.ts), pelo chat (chat.ts)
// e pelos avisos (push.ts), para os três mexerem na agenda do mesmo jeito e com as mesmas conferências.
import { acessoGoogle as pedirAcesso, ErroAcesso, esquecerAcesso, usuario, ehDemo } from "./auth.ts";
import { calendarioLocal, ErroLimite } from "./calendario-local.ts";

const GOOGLE = (process.env.AGENDA_GOOGLE ?? "https://www.googleapis.com/calendar/v3").replace(/\/$/, "");
const FUSO_PADRAO = "America/Sao_Paulo";
export const MIN = 60_000;

// Quem está pedindo: o id da pessoa (tabela usuarios de auth.ts). A página, o chat e os avisos usam o mesmo.
export type Sessao = { usuario: string };

export class ErroHttp extends Error {
  status: number;
  codigo: string;
  constructor(status: number, codigo: string, mensagem?: string) {
    super(mensagem ?? codigo);
    this.status = status;
    this.codigo = codigo;
  }
}

export function eu(s: Sessao) {
  const u = usuario(s.usuario);
  if (!u) throw new ErroHttp(401, "sessao");
  return u;
}

export async function acessoGoogle(s: Sessao): Promise<string> {
  try { return await pedirAcesso(s.usuario); }
  catch (e) {
    if (!(e instanceof ErroAcesso)) throw e;
    if (e.message === "sessao") throw new ErroHttp(401, "sessao");
    if (e.message === "convite" || e.message === "reconectar") throw new ErroHttp(409, e.message);
    throw new ErroHttp(502, "google");
  }
}

export function esquecer(uid: string) { esquecerAcesso(uid); fusos.delete(uid); }

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of fusos) if (v.ate < agora) fusos.delete(k);
}, 10 * MIN).unref();

// ---------- Google Calendar ----------
export async function google(s: Sessao, metodo: string, caminho: string, corpo?: unknown): Promise<any> {
  let r: Response;
  // Pessoa do modo demonstração: a agenda é a daqui (calendario-local.ts), nunca a do Google.
  if (ehDemo(s.usuario)) {
    let x;
    try { x = calendarioLocal(s.usuario, metodo, caminho, corpo, FUSO_PADRAO); }
    catch (e) { if (e instanceof ErroLimite) throw new ErroHttp(400, "limite", "Na demonstração, a agenda guarda até 300 eventos."); throw e; }
    r = new Response(x.status === 204 || x.corpo === undefined ? null : JSON.stringify(x.corpo), { status: x.status });
    return tratar(s, metodo, caminho, r);
  }
  const token = await acessoGoogle(s);
  try {
    r = await fetch(GOOGLE + caminho, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, ...(corpo ? { "Content-Type": "application/json" } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error("Google fora do ar:", (e as Error).message);
    throw new ErroHttp(502, "google");
  }
  return tratar(s, metodo, caminho, r);
}
async function tratar(s: Sessao, metodo: string, caminho: string, r: Response): Promise<any> {
  if (r.status === 401) { esquecerAcesso(s.usuario); throw new ErroHttp(502, "google", "O Google recusou o acesso agora. Tente de novo."); }
  if (r.status === 403) throw new ErroHttp(403, "proibido", "O Google não deixou mexer nesse evento (é de outra pessoa?).");
  if (r.status === 404 || r.status === 410) throw new ErroHttp(404, "sumiu", "Esse evento não existe mais na sua agenda.");
  if (!r.ok) {
    console.error("Google", metodo, caminho.split("?")[0], r.status, (await r.text().catch(() => "")).slice(0, 300));
    throw new ErroHttp(502, "google");
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

const fusos = new Map<string, { fuso: string; ate: number }>();
export async function fuso(s: Sessao): Promise<string> {
  const c = fusos.get(s.usuario);
  if (c && c.ate > Date.now()) return c.fuso;
  let f = FUSO_PADRAO;
  try {
    const cal = await google(s, "GET", "/calendars/primary");
    if (typeof cal?.timeZone === "string" && cal.timeZone) f = cal.timeZone;
  } catch (e) { if (e instanceof ErroHttp && (e.status === 401 || e.status === 409)) throw e; }
  fusos.set(s.usuario, { fuso: f, ate: Date.now() + 60 * MIN });
  return f;
}

export const MARCA = "✓ ";
const tirarHtml = (t: string) => t.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function normalizar(e: any) {
  const priv = e.extendedProperties?.private ?? {};
  let titulo = String(e.summary ?? "").trim();
  const marcado = titulo.startsWith(MARCA);
  if (marcado) titulo = titulo.slice(MARCA.length).trim();
  const organizador = e.organizer?.self ? null : String(e.organizer?.displayName ?? e.organizer?.email ?? "") || null;
  return {
    id: String(e.id),
    titulo: titulo || "(sem título)",
    diaInteiro: Boolean(e.start?.date),
    inicio: String(e.start?.date ?? e.start?.dateTime ?? ""),
    fim: String(e.end?.date ?? e.end?.dateTime ?? ""),
    feito: priv.icarusFeito === "1" || (marcado && priv.icarusFeito !== "0"),
    descricao: e.description ? tirarHtml(String(e.description)).slice(0, 2000) : "",
    local: e.location ? String(e.location).slice(0, 300) : "",
    serie: e.recurringEventId ? String(e.recurringEventId) : null,
    organizador,
    podeEditar: Boolean(e.organizer?.self || e.guestsCanModify || !e.organizer),
    // Conta a pagar: evento de dia inteiro com valor e categoria na marca particular (o "feito" é o pago).
    tipo: priv.icarusTipo === "conta" ? "conta" as const : "evento" as const,
    valor: priv.icarusTipo === "conta" && Number.isFinite(Number(priv.icarusValor)) ? Number(priv.icarusValor) : null,
    categoria: priv.icarusTipo === "conta" ? (CATEGORIAS.includes(priv.icarusCategoria) ? priv.icarusCategoria : "Outros") : null,
  };
}

// Categorias das contas (fixas, para o gráfico do mês comparar igual com igual).
export const CATEGORIAS = ["Moradia", "Casa", "Cartão", "Transporte", "Saúde", "Educação", "Assinaturas", "Impostos", "Lazer", "Outros"];

// "1.234,56", "R$ 99,90", "1234.56", 99 -> número com 2 casas; erro 400 se não for um valor.
export function valorValido(v: unknown): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    let t = v.replace(/R\$|\s/g, "");
    if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
    n = /^\d+(\.\d{1,2})?$/.test(t) ? Number(t) : NaN;
  } else n = NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) throw new ErroHttp(400, "campo", "Valor da conta inválido.");
  return Math.round(n * 100) / 100;
}

// ---------- validação ----------
const RE_ID = /^[A-Za-z0-9_\-]{1,250}$/;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const REPETIR: Record<string, string> = { diario: "DAILY", semanal: "WEEKLY", mensal: "MONTHLY", anual: "YEARLY" };

export function idValido(id: string): string {
  if (!RE_ID.test(id)) throw new ErroHttp(400, "id");
  return id;
}
export function dataValida(d: unknown, campo: string): string {
  if (typeof d !== "string" || !RE_DATA.test(d) || Number.isNaN(Date.parse(d + "T00:00:00Z"))
    || new Date(d + "T00:00:00Z").toISOString().slice(0, 10) !== d) throw new ErroHttp(400, "campo", `Data inválida (${campo}).`);
  return d;
}
export function texto(v: unknown, max: number, campo: string): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new ErroHttp(400, "campo", `Campo inválido (${campo}).`);
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  if (t.length > max) throw new ErroHttp(400, "campo", `Texto longo demais (${campo}).`);
  return t;
}
function maisUmDia(d: string): string {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
}

// Corpo de evento para criar ou editar: { titulo, data, dataFim?, diaInteiro, hora?, horaFim?, local?, descricao?, repetir?,
// tipo? ("evento" | "conta"), valor?, categoria? }. Conta é sempre de dia inteiro (no vencimento) e pede valor.
export function montarEvento(b: any, tz: string, criando: boolean) {
  const conta = b.tipo === "conta";
  if (conta) b = { ...b, diaInteiro: true };
  const titulo = texto(b.titulo, 200, "título");
  if (!titulo) throw new ErroHttp(400, "campo", "Falta o nome do evento.");
  const data = dataValida(b.data, "data");
  const dataFim = b.dataFim ? dataValida(b.dataFim, "fim") : data;
  if (dataFim < data) throw new ErroHttp(400, "campo", "O fim vem antes do começo.");
  const ev: any = { summary: titulo, location: texto(b.local, 300, "local"), description: texto(b.descricao, 2000, "descrição") };
  if (b.diaInteiro !== false) {
    ev.start = { date: data };
    ev.end = { date: maisUmDia(dataFim) };
  } else {
    const hora = typeof b.hora === "string" && RE_HORA.test(b.hora) ? b.hora : null;
    if (!hora) throw new ErroHttp(400, "campo", "Falta a hora.");
    let horaFim = typeof b.horaFim === "string" && RE_HORA.test(b.horaFim) ? b.horaFim : null;
    if (!horaFim) {
      const [h, m] = hora.split(":").map(Number);
      const fim = Math.min(h * 60 + m + 60, 23 * 60 + 59);
      horaFim = `${String(Math.floor(fim / 60)).padStart(2, "0")}:${String(fim % 60).padStart(2, "0")}`;
    }
    if (dataFim === data && horaFim <= hora) throw new ErroHttp(400, "campo", "A hora do fim vem antes do começo.");
    ev.start = { dateTime: `${data}T${hora}:00`, timeZone: tz };
    ev.end = { dateTime: `${dataFim}T${horaFim}:00`, timeZone: tz };
  }
  const priv: Record<string, string> = {};
  if (conta) {
    priv.icarusTipo = "conta";
    priv.icarusValor = valorValido(b.valor).toFixed(2);
    const cat = typeof b.categoria === "string" && CATEGORIAS.includes(b.categoria) ? b.categoria : "Outros";
    priv.icarusCategoria = cat;
  } else if (b.tipo === "evento" && !criando) priv.icarusTipo = "evento";
  if (criando) {
    const rep = b.repetir ? REPETIR[String(b.repetir)] : undefined;
    if (b.repetir && b.repetir !== "nao" && !rep) throw new ErroHttp(400, "campo", "Repetição inválida.");
    if (rep) ev.recurrence = [`RRULE:FREQ=${rep}`];
    // Lembretes do próprio Google (chegam pelo app Google Agenda do celular): dia inteiro, às 9h da véspera;
    // com hora, 1 dia e 1 hora antes.
    ev.reminders = {
      useDefault: false,
      overrides: ev.start.date ? [{ method: "popup", minutes: 15 * 60 }] : [{ method: "popup", minutes: 24 * 60 }, { method: "popup", minutes: 60 }],
    };
    priv.icarusCriado = "1";
  }
  if (Object.keys(priv).length) ev.extendedProperties = { private: priv };
  return ev;
}

// ---------- operações (a página e o chat usam as mesmas) ----------
export type Evento = ReturnType<typeof normalizar>;
const caminhoEvento = (id: string) => `/calendars/primary/events/${encodeURIComponent(idValido(id))}`;
const ehDono = (e: any) => Boolean(e?.organizer?.self || e?.guestsCanModify || !e?.organizer);

// Eventos entre de e ate (ms), com as repetições abertas; convites recusados ficam de fora.
export async function listarEventos(s: Sessao, de: number, ate: number, soContas = false): Promise<Evento[]> {
  const maxDias = soContas ? 125 : 62;
  if (!de || !ate || ate <= de || ate - de > maxDias * 24 * 3600 * 1000) throw new ErroHttp(400, "periodo", `Período inválido (no máximo ${maxDias} dias).`);
  const itens: Evento[] = [];
  let pagina: string | undefined;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(de).toISOString(), timeMax: new Date(ate).toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "500",
    });
    if (soContas) q.set("privateExtendedProperty", "icarusTipo=conta");
    if (pagina) q.set("pageToken", pagina);
    const r = await google(s, "GET", `/calendars/primary/events?${q}`);
    for (const e of r?.items ?? []) {
      if (e.status === "cancelled") continue;
      if ((e.attendees ?? []).some((a: any) => a.self && a.responseStatus === "declined")) continue;
      itens.push(normalizar(e));
    }
    pagina = r?.nextPageToken;
    if (!pagina) break;
  }
  return itens;
}

export async function obterEvento(s: Sessao, id: string): Promise<Evento> {
  return normalizar(await google(s, "GET", caminhoEvento(id)));
}

export async function criarEvento(s: Sessao, b: any): Promise<Evento> {
  const ev = montarEvento(b, await fuso(s), true);
  return normalizar(await google(s, "POST", "/calendars/primary/events", ev));
}

// b como em montarEvento; com b.todas, muda nome, local e descrição da série inteira.
export async function editarEvento(s: Sessao, id: string, b: any): Promise<Evento> {
  const cam = caminhoEvento(id);
  const atual = await google(s, "GET", cam);
  if (!ehDono(atual)) throw new ErroHttp(403, "proibido", "Esse evento é de outra pessoa; só ela muda.");
  const feito = String(atual?.summary ?? "").startsWith(MARCA) || atual?.extendedProperties?.private?.icarusFeito === "1";
  if (b.todas === true && atual?.recurringEventId) {
    // Na série inteira, só o texto: mudar a hora de todas as repetições fica para o app do Google.
    const titulo = texto(b.titulo, 200, "título");
    if (!titulo) throw new ErroHttp(400, "campo", "Falta o nome do evento.");
    const serie: any = { summary: titulo, location: texto(b.local, 300, "local"), description: texto(b.descricao, 2000, "descrição") };
    if (b.tipo === "conta") serie.extendedProperties = { private: {
      icarusTipo: "conta", icarusValor: valorValido(b.valor).toFixed(2),
      icarusCategoria: CATEGORIAS.includes(b.categoria) ? b.categoria : "Outros" } };
    await google(s, "PATCH", caminhoEvento(String(atual.recurringEventId)), serie);
    return normalizar(await google(s, "GET", cam));
  }
  const ev = montarEvento(b, await fuso(s), false);
  if (feito) ev.summary = MARCA + ev.summary;
  return normalizar(await google(s, "PATCH", cam, ev));
}

export async function apagarEvento(s: Sessao, id: string, todas: boolean): Promise<void> {
  const cam = caminhoEvento(id);
  const atual = await google(s, "GET", cam);
  const alvo = todas && atual?.recurringEventId ? caminhoEvento(String(atual.recurringEventId)) : cam;
  // Evento da pessoa com convidados: o Google avisa os convidados. Convite de outra pessoa: só sai da agenda dela.
  const avisar = atual?.organizer?.self && (atual?.attendees ?? []).length > 0 ? "all" : "none";
  await google(s, "DELETE", `${alvo}?sendUpdates=${avisar}`);
}

// "✓ " no título (no evento que é da pessoa) e icarusFeito na marca particular (sempre).
export async function marcarFeito(s: Sessao, id: string, feito: boolean): Promise<Evento> {
  const cam = caminhoEvento(id);
  const atual = await google(s, "GET", cam);
  const patch: any = { extendedProperties: { private: { icarusFeito: feito ? "1" : "0" } } };
  if (ehDono(atual)) {
    const t = String(atual?.summary ?? "").replace(/^✓\s*/, "");
    patch.summary = feito ? MARCA + t : t;
  }
  return normalizar(await google(s, "PATCH", cam, patch));
}

// Data (AAAA-MM-DD) e hora (HH:MM) de um instante no fuso da agenda.
export function partesNoFuso(iso: string, tz: string): { data: string; hora: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { data: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
