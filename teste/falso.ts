// Login do Google (OAuth), Google Calendar e Anthropic FALSOS, com dados fictícios, para ver a IAgenda no computador
// (npm run local sobe este e a IAgenda juntos). Nada aqui fala com serviço de verdade.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORTA = Number(process.env.FALSO_PORTA ?? 8099);   // os testes automáticos usam outra, para não brigar com o npm run local
export const CLIENT_ID = "iagenda-teste.apps.googleusercontent.com";
export const CLIENT_SECRET = "segredo-de-teste";
const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";
// Pessoas que dá para escolher na tela de login falsa. Só a Fulana está em AGENDA_CONVITES (teste/local.ts).
const PESSOAS: Record<string, { sub: string; email: string; nome: string }> = {
  fulana: { sub: "100000000000000000001", email: "fulana@gmail.com", nome: "Fulana Teste" },
  beltrano: { sub: "100000000000000000002", email: "beltrano@gmail.com", nome: "Beltrano Sem Convite" },
};
const codigos = new Map<string, { pessoa: string; desafio: string; redirect: string; escopo: string; consentiu: boolean }>();
const jaConsentiram = new Set<string>();   // como o Google: refresh token só no primeiro consentimento (ou com prompt=consent)
let acessoPedidos = 0;
let reconectar = false; // (reinicia limpo)
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Ev = any;
const evs = new Map<string, Ev>();
const excecoes = new Map<string, Ev>();   // id da instância -> evento (editado ou cancelado)
let n = 0;
const dia = (d: Date) => d.toISOString().slice(0, 10);

function semente() {
  const hoje = new Date();
  const k = dia(hoje);
  const amanha = dia(new Date(hoje.getTime() + 86400000));
  evs.set("ev1", { id: "ev1", summary: "Pagar a luz", start: { date: k }, end: { date: amanha }, organizer: { self: true, email: "eu@x" } });
  evs.set("ev2", { id: "ev2", summary: "Dentista", start: { dateTime: `${k}T15:00:00-03:00` }, end: { dateTime: `${k}T16:00:00-03:00` }, organizer: { self: true, email: "eu@x" }, location: "Rua A, 10", description: "<b>levar</b> exame<br>e documento" });
  evs.set("ev3", { id: "ev3", summary: "<img src=x onerror=alert(1)> Reunião do trabalho", start: { dateTime: `${amanha}T10:00:00-03:00` }, end: { dateTime: `${amanha}T11:00:00-03:00` }, organizer: { email: "chefe@empresa.com", displayName: "Chefe" }, attendees: [{ self: true, responseStatus: "accepted" }] });
  evs.set("ev4", { id: "ev4", summary: "Recusado", start: { date: k }, end: { date: amanha }, organizer: { email: "z@z" }, attendees: [{ self: true, responseStatus: "declined" }] });
  const conta = (id: string, summary: string, data: string, valor: string, cat: string, extra: any = {}) =>
    evs.set(id, { id, summary, start: { date: data }, end: { date: dia(new Date(Date.parse(data + "T12:00:00Z") + 86400000)) }, organizer: { self: true }, extendedProperties: { private: { icarusTipo: "conta", icarusValor: valor, icarusCategoria: cat } }, ...extra });
  const d = (n: number) => dia(new Date(hoje.getTime() + n * 86400000));
  conta("c1", "Aluguel", d(-3), "1500.00", "Moradia");
  conta("c2", "Luz", d(3), "180.50", "Casa");
  conta("c3", "✓ Netflix", d(-1), "55.90", "Assinaturas", { extendedProperties: { private: { icarusTipo: "conta", icarusValor: "55.90", icarusCategoria: "Assinaturas", icarusFeito: "1" } } });
  conta("c4", "Fatura do cartão", d(12), "820.00", "Cartão");
  conta("c5", "Internet", d(0), "99.90", "Casa");
  const pago = (id: string, summary: string, data: string, valor: string, cat: string) =>
    conta(id, "✓ " + summary, data, valor, cat, { extendedProperties: { private: { icarusTipo: "conta", icarusValor: valor, icarusCategoria: cat, icarusFeito: "1" } } });
  // Mês corrente (alguns já pagos) e o próximo, para o "a pagar" e o gráfico terem o que mostrar.
  pago("c6", "Condomínio", d(-12), "650.00", "Moradia");
  pago("c7", "Água", d(-8), "87.40", "Casa");
  pago("c8", "Plano de saúde", d(-6), "489.90", "Saúde");
  conta("c9", "Gás", d(2), "132.40", "Casa");
  conta("c10", "Escola de inglês", d(5), "390.00", "Educação");
  conta("c11", "Spotify", d(4), "21.90", "Assinaturas");
  pago("c12", "Seguro do carro", d(-15), "210.00", "Transporte");
  conta("c13", "Combustível", d(6), "300.00", "Transporte");
  conta("c14", "Academia", d(1), "119.90", "Lazer");
  conta("c15", "IPTU (parcela)", d(7), "145.00", "Impostos");
  conta("c16", "Aluguel", d(27), "1500.00", "Moradia");
  conta("c17", "Luz", d(33), "175.00", "Casa");
  // Compromissos comuns, para a grade não ficar só com contas.
  evs.set("e1", { id: "e1", summary: "Reunião com a escola", start: { dateTime: d(2) + "T18:30:00-03:00" }, end: { dateTime: d(2) + "T19:30:00-03:00" }, organizer: { self: true } });
  evs.set("e2", { id: "e2", summary: "Aniversário da Ana", start: { date: d(9) }, end: { date: d(10) }, organizer: { self: true } });
  evs.set("ser1", { id: "ser1", summary: "Academia", start: { date: k }, end: { date: amanha }, recurrence: ["RRULE:FREQ=WEEKLY"], organizer: { self: true } });
}
semente();

function instancias(de: Date, ate: Date): Ev[] {
  const out: Ev[] = [];
  for (const e of evs.values()) {
    if (!e.recurrence) {
      const ini = new Date(e.start.date ? e.start.date + "T00:00:00-03:00" : e.start.dateTime);
      const fim = new Date(e.end.date ? e.end.date + "T00:00:00-03:00" : e.end.dateTime);
      if (fim > de && ini < ate) out.push(e);
      continue;
    }
    const passo = e.recurrence[0].includes("WEEKLY") ? 7 : e.recurrence[0].includes("DAILY") ? 1 : e.recurrence[0].includes("MONTHLY") ? 30 : 365;
    const base = new Date((e.start.date ?? e.start.dateTime.slice(0, 10)) + "T12:00:00Z");
    for (let i = 0; i < 400; i++) {
      const d = new Date(base.getTime() + i * passo * 86400000);
      if (d > ate) break;
      const iid = `${e.id}_${dia(d).replace(/-/g, "")}`;
      const x = excecoes.get(iid);
      if (x?.status === "cancelled") continue;
      let inst: Ev;
      if (x) inst = x;
      else if (e.start.date) inst = { ...e, id: iid, recurringEventId: e.id, recurrence: undefined, start: { date: dia(d) }, end: { date: dia(new Date(d.getTime() + 86400000)) } };
      else inst = { ...e, id: iid, recurringEventId: e.id, recurrence: undefined, start: { dateTime: dia(d) + e.start.dateTime.slice(10) }, end: { dateTime: dia(d) + e.end.dateTime.slice(10) } };
      if (new Date(d.getTime() + 86400000) > de) out.push(inst);
    }
  }
  return out;
}
function achar(id: string): Ev | null {
  if (evs.has(id)) return evs.get(id);
  if (excecoes.has(id)) return excecoes.get(id).status === "cancelled" ? null : excecoes.get(id);
  const m = id.match(/^(.+)_(\d{8})$/);
  if (m && evs.has(m[1])) {
    const e = evs.get(m[1]);
    const d = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6)}`;
    return { ...e, id, recurringEventId: e.id, recurrence: undefined, start: e.start.date ? { date: d } : { dateTime: d + e.start.dateTime.slice(10) }, end: e.start.date ? { date: dia(new Date(new Date(d + "T12:00:00Z").getTime() + 86400000)) } : { dateTime: d + e.end.dateTime.slice(10) } };
  }
  return null;
}
function mesclar(a: any, b: any) {
  const r = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === "extendedProperties") r[k] = { private: { ...(a[k]?.private ?? {}), ...((v as any).private ?? {}) } };
    else r[k] = v;
  }
  return r;
}

const log: string[] = [];
const pedidosIA: any[] = [];
createServer(async (req, res) => {
  const url = new URL(req.url!, "http://x");
  const p = url.pathname;
  let corpo = "";
  for await (const c of req) corpo += c;
  const b = !corpo ? {} : String(req.headers["content-type"] ?? "").includes("json") ? JSON.parse(corpo) : Object.fromEntries(new URLSearchParams(corpo));
  const auth = req.headers.authorization ?? "";
  const j = (s: number, o?: unknown) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(o === undefined ? "" : JSON.stringify(o)); };
  log.push(`${req.method} ${p}`);


  // ----- Anthropic falsa (roteiro) -----
  if (p.startsWith("/v1/messages")) {
    pedidosIA.push({ headers: { beta: req.headers["anthropic-beta"], chave: req.headers["x-api-key"] ?? req.headers.authorization }, corpo: b });
    if (req.headers["x-api-key"] !== "sk-ant-teste" && req.headers.authorization !== "Bearer sk-ant-teste") return j(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const msgs = b.messages;
    const ultimaUser = [...msgs].reverse().find((m: any) => m.role === "user");
    const primeiroTexto = [...msgs].reverse().find((m: any) => m.role === "user" && typeof m.content === "string")?.content ?? "";
    const resp = (content: any[], stop: string) => j(200, { id: "msg_" + Date.now(), type: "message", role: "assistant", model: b.model, content, stop_reason: stop, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } });
    const hojeK = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    // Botão "Ler da caixa": devolve os dados de uma caixa fictícia.
    if (b.tool_choice?.name === "dados_da_caixa") return resp([{ type: "tool_use", id: "tc1", name: "dados_da_caixa", input: {
      e_caixa_de_remedio: true, nome: "Remedix 50 mg", unidade: "comprimido", por_caixa: 30,
      caixa: { principio: "Remedixina", concentracao: "50 mg", forma: "comprimido revestido", apresentacao: "caixa com 30 comprimidos",
        laboratorio: "Laboratório Teste", lote: "AB123", validade: "2027-08", registro: "1.0000.0000.000-0", tarja: "vermelha", receita: "sob prescrição" },
    } }], "tool_use");
    if (Array.isArray(ultimaUser.content) && ultimaUser.content[0]?.type === "tool_result") {
      const r0 = ultimaUser.content[0];
      const res0 = JSON.parse(typeof r0.content === "string" && r0.content.startsWith("{") ? r0.content : "{}");
      // Remédios: depois de listar, marca as doses da manhã; depois de cadastrar, pede a foto da caixa.
      if (/tomei/i.test(primeiroTexto) && res0.doses_do_dia) {
        const manha = res0.doses_do_dia.doses.filter((d: any) => d.horario === "manha" && !d.tomado);
        if (manha.length) return resp(manha.map((d: any, i: number) => ({ type: "tool_use", id: "td" + i, name: "marcar_dose", input: { id: d.id, horario: "manha", tomado: true } })), "tool_use");
        return resp([{ type: "text", text: "Os da manhã já estavam marcados." }], "end_turn");
      }
      if (res0.remedio) {
        const rr = res0.remedio;
        const txt = r0.is_error ? "Não deu: " + r0.content
          : res0.lembrete ? `Anotei ${rr.nome}: ${rr.dose} ${rr.unidade}, ${rr.horarios.join(" e ")}. Manda uma foto da caixa que eu anoto o resto (concentração, laboratório, validade, quantidade na caixa).`
          : `Pronto: ${rr.nome}${typeof rr.estoque === "number" ? `, ${rr.estoque} em estoque, dá até ${rr.acaba_em}` : ""}.`;
        return resp([{ type: "text", text: txt }], "end_turn");
      }
      if (res0.por_remedio) return resp([{ type: "text", text: res0.faltas.length ? "Faltou: " + res0.faltas.map((f: any) => `${f.dia}: ${f.faltou.join(", ")}`).join("; ") : "Nenhuma falta." }], "end_turn");
      if (r0.is_error && /remedio|tomo/i.test(primeiroTexto)) return resp([{ type: "text", text: "Não deu: " + r0.content }], "end_turn");
    }
    if (Array.isArray(ultimaUser.content) && ultimaUser.content[0]?.type === "tool_result") {
      const r = ultimaUser.content[0];
      const res = JSON.parse(typeof r.content === "string" && r.content.startsWith("{") ? r.content : "{}");
      if (/apaga/i.test(primeiroTexto) && res.eventos) {
        const alvo = res.eventos.find((e: any) => /luz/i.test(e.titulo)) ?? res.eventos[0];
        return resp([{ type: "tool_use", id: "tu2", name: "remover_evento", input: { id: alvo.id } }], "tool_use");
      }
      if (/loop/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu" + Math.random(), name: "listar_eventos", input: { de: hojeK, ate: hojeK } }], "tool_use");
      if (/ignora/i.test(primeiroTexto)) return resp([{ type: "text", text: "Erro visto: " + (r.is_error ? r.content : "nenhum") }], "end_turn");
      // Resposta em frase, como a IA de verdade faria.
      const dm = (k: string) => k ? `${k.slice(8, 10)}/${k.slice(5, 7)}` : "";
      const real = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      let frase = "Pronto.";
      if (r.is_error) frase = "Não deu: " + r.content;
      else if (res.aguardando_confirmacao) frase = "Separei para apagar. Toque em Confirmar aqui embaixo, se estiver certo.";
      else if (res.evento) frase = `Pronto: “${res.evento.titulo}” em ${dm(res.evento.data)}` + (res.evento.tipo === "conta" ? `, ${real(res.evento.valor)} (${res.evento.categoria})` : "") + (res.repete ? ", todo mês." : ".");
      else if (res.eventos) {
        const contas = res.eventos.filter((e: any) => e.tipo === "conta" && !e.pago);
        const outros = res.eventos.filter((e: any) => e.tipo !== "conta");
        frase = res.eventos.length ? [
          outros.length ? "Hoje: " + outros.map((e: any) => (e.hora_inicio ? e.hora_inicio + " " : "") + e.titulo).join(", ") + "." : "",
          contas.length ? `Contas a pagar: ${contas.map((e: any) => e.titulo + " " + real(e.valor)).join(", ")}.` : "",
        ].filter(Boolean).join("\n") : "Nada hoje. Dia livre!";
      }
      return resp([{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: frase }], "end_turn");
    }
    if (/lento/i.test(primeiroTexto)) await new Promise((r) => setTimeout(r, 1500));
    if (/recusa/i.test(primeiroTexto)) return resp([], "refusal");
    // Foto: a IA de teste "lê" um boleto de luz. Desabafo ou outro assunto: fora_do_assunto.
    const ultimaComImagem = Array.isArray(ultimaUser.content) && ultimaUser.content.some((c: any) => c.type === "image");
    if (ultimaComImagem) return resp([{ type: "tool_use", id: "tu1", name: "criar_evento", input: { titulo: "Conta de luz (da foto)", data: hojeK, tipo: "conta", valor: 213.77, categoria: "Casa" } }], "tool_use");
    if (/tomo remedix/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tr1", name: "cadastrar_remedio", input: { nome: "Remedix", dose: 1, unidade: "comprimido", horarios: ["manha", "noite"], estoque: 5 } }], "tool_use");
    if (/comprei/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tr1", name: "listar_remedios", input: {} }], "tool_use");
    if (/tomei/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tr1", name: "listar_remedios", input: {} }], "tool_use");
    if (/esqueci/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tr1", name: "relatorio_remedios", input: { de: "2026-11-01", ate: hojeK } }], "tool_use");
    if (/triste|conselho|piada|ansios|terapia|conversar/i.test(String(ultimaUser.content))) return resp([{ type: "text", text: "Posso ajudar com isso!" }, { type: "tool_use", id: "tu1", name: "fora_do_assunto", input: { motivo: "conversa" } }], "tool_use");
    if (/hoje|apaga/i.test(primeiroTexto)) return resp([{ type: "text", text: "Vou olhar." }, { type: "tool_use", id: "tu1", name: "listar_eventos", input: { de: hojeK, ate: hojeK } }], "tool_use");
    if (/luz de 150/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu1", name: "criar_evento", input: { titulo: "Luz", data: "2026-12-15", tipo: "conta", valor: 150, categoria: "Casa", repetir: "mensal" } }], "tool_use");
    if (/conta de gas/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu1", name: "criar_evento", input: { titulo: "Gás", data: hojeK, tipo: "conta", valor: 132.4, categoria: "Casa", repetir: "mensal" } }], "tool_use");
    if (/marca/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu1", name: "criar_evento", input: { titulo: "Dentista", data: hojeK, hora: "15:00" } }], "tool_use");
    if (/ignora/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu1", name: "editar_evento", input: { id: "ev3", titulo: "hackeado" } }], "tool_use");
    if (/loop/i.test(primeiroTexto)) return resp([{ type: "tool_use", id: "tu" + Math.random(), name: "listar_eventos", input: { de: hojeK, ate: hojeK } }], "tool_use");
    return resp([{ type: "text", text: "Oi! Em que posso ajudar na sua agenda?" }], "end_turn");
  }

  // ----- controle do teste -----
  if (p === "/teste/ia") return j(200, pedidosIA);
  if (p === "/teste/log") return j(200, { log, acessoPedidos, evs: [...evs.values()], excecoes: [...excecoes.entries()] });
  if (p === "/teste/reconectar") { reconectar = true; return j(200, {}); }

  // ----- Login do Google (OAuth 2.0 + PKCE) -----
  // Tela de escolha: no lugar da tela do Google, botões para cada caso de teste.
  if (p === "/o/oauth2/v2/auth" && req.method === "GET") {
    const q = url.searchParams;
    const volta = (extra: Record<string, string>) => `${q.get("redirect_uri")}?${new URLSearchParams({ ...extra, state: q.get("state") ?? "" })}`;
    if (q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Pedido de login inválido (client_id ou PKCE).");
    }
    const escolha = q.get("escolha");
    if (escolha) {
      if (escolha === "cancelar") { res.writeHead(302, { Location: volta({ error: "access_denied" }) }); return res.end(); }
      const [pessoa, semAgenda] = escolha.split(":");
      if (!PESSOAS[pessoa]) { res.writeHead(400); return res.end(); }
      const code = "4/" + randomBytes(16).toString("hex");
      const escopo = (q.get("scope") ?? "").split(" ").filter((e) => !(semAgenda && e === ESCOPO_AGENDA)).join(" ");
      codigos.set(code, { pessoa, desafio: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, escopo, consentiu: /consent/.test(q.get("prompt") ?? "") });
      res.writeHead(302, { Location: volta({ code, scope: escopo }) }); return res.end();
    }
    const link = (escolha: string, texto: string) => {
      const u = new URLSearchParams(q); u.set("escolha", escolha);
      return `<p><a href="/o/oauth2/v2/auth?${esc(u.toString())}">${texto}</a></p>`;
    };
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Google (falso)</title>
<style>body{font:16px system-ui;max-width:420px;margin:60px auto;padding:0 16px}a{display:block;padding:12px 14px;border:1px solid #ccc;border-radius:10px;text-decoration:none;color:#1a1a1a}a:hover{background:#f3f3f3}</style>
<h2>Login do Google (falso, para teste)</h2><p>Escolha a conta:</p>
${link("fulana", "Fulana Teste (convidada)")}
${link("fulana:sem-agenda", "Fulana Teste, desmarcando a permissão da agenda")}
${link("beltrano", "Beltrano (sem convite)")}
${link("cancelar", "Cancelar")}`);
  }
  if (p === "/token" && req.method === "POST") {
    if (b.client_id !== CLIENT_ID || b.client_secret !== CLIENT_SECRET) return j(401, { error: "invalid_client" });
    if (b.grant_type === "authorization_code") {
      const c = codigos.get(b.code);
      codigos.delete(b.code);
      if (!c || c.redirect !== b.redirect_uri) return j(400, { error: "invalid_grant" });
      if (createHash("sha256").update(String(b.code_verifier ?? "")).digest("base64url") !== c.desafio) return j(400, { error: "invalid_grant", error_description: "PKCE" });
      const pe = PESSOAS[c.pessoa];
      const darRefresh = c.consentiu || !jaConsentiram.has(pe.sub);
      jaConsentiram.add(pe.sub);
      const idToken = [b64u({ alg: "RS256" }), b64u({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: pe.sub, email: pe.email, email_verified: true, name: pe.nome, exp: Math.floor(Date.now() / 1000) + 3600 }), "assinatura"].join(".");
      reconectar = false;
      return j(200, { access_token: "google-at", expires_in: 3599, scope: c.escopo, token_type: "Bearer", id_token: idToken, ...(darRefresh ? { refresh_token: "1//rt-" + pe.sub } : {}) });
    }
    if (b.grant_type === "refresh_token") {
      if (reconectar || !String(b.refresh_token).startsWith("1//rt-")) return j(400, { error: "invalid_grant" });
      acessoPedidos++;
      return j(200, { access_token: "google-at", expires_in: 3599, token_type: "Bearer" });
    }
    return j(400, { error: "unsupported_grant_type" });
  }
  if (p === "/revoke" && req.method === "POST") {
    log.push(`revoke ${String(b.token ?? "").slice(0, 10)}`);
    for (const [sub] of Object.values(PESSOAS).map((x) => [x.sub])) if (b.token === "1//rt-" + sub) jaConsentiram.delete(sub);
    return j(200, {});
  }

  // ----- Google -----
  if (!p.startsWith("/calendar/v3/")) return j(404);
  if (auth !== "Bearer google-at") return j(401);
  const g = p.slice("/calendar/v3".length);
  if (g === "/calendars/primary") return j(200, { timeZone: "America/Sao_Paulo" });
  if (g === "/calendars/primary/events" && req.method === "GET") {
    const de = new Date(url.searchParams.get("timeMin")!), ate = new Date(url.searchParams.get("timeMax")!);
    if (url.searchParams.get("singleEvents") !== "true") return j(400);
    const filtro = url.searchParams.get("privateExtendedProperty");
    let itens = instancias(de, ate);
    if (filtro) { const [k, v] = filtro.split("="); itens = itens.filter((e: any) => e.extendedProperties?.private?.[k] === v); }
    return j(200, { items: itens });
  }
  if (g === "/calendars/primary/events" && req.method === "POST") {
    const id = "novo" + ++n;
    const e = { ...b, id, organizer: { self: true } };
    evs.set(id, e);
    return j(200, e);
  }
  const m = g.match(/^\/calendars\/primary\/events\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const e = achar(id);
    if (!e) return j(404, { error: { message: "Not Found" } });
    if (req.method === "GET") return j(200, e);
    if (req.method === "PATCH") {
      const naoDono = !e.organizer?.self;
      if (naoDono && (b.summary !== undefined || b.start)) return j(403, { error: { message: "forbiddenForNonOrganizer" } });
      const novo = mesclar(e, b);
      if (evs.has(id)) evs.set(id, novo); else excecoes.set(id, novo);
      return j(200, novo);
    }
    if (req.method === "DELETE") {
      log.push(`sendUpdates=${url.searchParams.get("sendUpdates")}`);
      if (evs.has(id)) evs.delete(id); else excecoes.set(id, { id, status: "cancelled" });
      return j(204);
    }
  }
  j(404);
}).listen(PORTA, "127.0.0.1", () => console.log(`falso em ${PORTA}`));
