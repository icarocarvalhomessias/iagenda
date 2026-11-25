// agenda-web: a IAgenda para outras pessoas , para pessoas convidadas.
// A pessoa entra com Google pelo Contas (/api/auth/google/*, que o proxy reverso manda direto para o Contas) e volta
// para cá com #codigo=...; a página troca o código pela sessão (/app/sessao) e daí em diante tudo passa por aqui.
//
//   /                       a página da agenda (publico/index.html, app.js, app.css)
//   /privacidade            política de privacidade
//   POST /app/sessao        { codigo } -> pede ao Contas o token da pessoa e guarda num cookie HttpOnly
//   GET  /app/eu            nome e e-mail de quem está logado
//   GET  /app/eventos       ?de=ISO&ate=ISO: eventos da agenda principal (primary) da pessoa, no máximo 62 dias
//   GET  /app/contas        ?de=ISO&ate=ISO: só as contas a pagar (eventos com icarusTipo=conta), no máximo 125 dias
//   POST /app/eventos       cria
//   PATCH  /app/eventos/:id edita (com "todas": nome, local e descrição de todas as repetições)
//   DELETE /app/eventos/:id ?todas=1 apaga a série inteira
//   POST /app/eventos/:id/feito  { feito }: "✓ " no título e icarusFeito em extendedProperties.private
//   POST /app/sair          apaga o cookie
//   POST /app/desconectar   revoga no Google, apaga a conta no Contas, a conversa do chat e o cookie
//   GET/POST/DELETE /app/chat, POST /app/chat/confirmar   o chat (chat.ts)
//   GET/POST/DELETE /app/push, POST /app/push/teste       avisos no aparelho (push.ts)
//   POST /app/funcoes       { compromissos?, contas?, remedios? }: liga e desliga as funções (funcoes.ts)
//   GET  /app/remedios      ?dia=AAAA-MM-DD: remédios, estoque e as doses do dia (remedios.ts)
//   POST /app/remedios      cadastra; PATCH/DELETE /app/remedios/:id muda ou apaga
//   POST /app/remedios/:id/compra | /estoque   comprei (soma) | contei (acerta o estoque)
//   POST /app/remedios/dose { remedio, dia, horario, tomado }   o check-in
//   GET  /app/remedios/relatorio ?de&ate   faltas dia a dia
//
// Os eventos não ficam aqui nem no repositório: a fonte de verdade é a agenda Google de cada pessoa. Só as
// mensagens do chat e os remédios ficam guardados (SQLite em /var/lib/agenda-web), até a pessoa limpar ou desconectar.
// Código comum com o chat em agenda.ts.
// O access token do Google vem do Contas (/api/auth/google/acesso, com o segredo do serviço) e fica só na
// memória deste processo; o navegador nunca recebe. Na VPS: /opt/agenda-web, serviço agenda-web.service,
// usuário agenda-web (sem sudo, sem acesso ao clone do repo), escutando só atrás do proxy reverso.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ErroHttp, MIN, type Sessao, contas, eu, esquecer, fuso, partesNoFuso, listarEventos, criarEvento, editarEvento, apagarEvento, marcarFeito, idValido } from "./agenda.ts";
import { chatConfigurado, conversa, enviar, confirmar, limparConversa, lerCaixa } from "./chat.ts";
import * as avisos from "./push.ts";
import * as remedios from "./remedios.ts";
import * as fn from "./funcoes.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.AGENDA_HOST ?? "127.0.0.1";
const PORTA = Number(process.env.AGENDA_PORTA ?? 8091);
// Sem HTTPS (teste no notebook), o cookie não pode ter Secure nem o prefixo __Host-.
const SEGURO = process.env.AGENDA_INSEGURO !== "1";
const COOKIE = SEGURO ? "__Host-agenda" : "agenda";
const SESSAO_DIAS = 30;   // igual a GoogleAgenda:JwtDias do Contas
const AQUI = dirname(fileURLToPath(import.meta.url));
const PUBLICO = join(AQUI, "publico");

// ---------- respostas ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// A política de privacidade é uma página estática com o estilo embutido e sem script.
const CSP_PRIVACIDADE = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function cabecalhosBase(res: ServerResponse, csp = CSP) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Microfone e câmera só para o próprio site (áudio e foto do chat); localização, para ninguém.
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
}

function json(res: ServerResponse, status: number, corpo: unknown, extra: Record<string, string | string[]> = {}) {
  cabecalhosBase(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(corpo));
}

function erro(res: ServerResponse, e: unknown) {
  if (e instanceof ErroHttp) {
    const extra = e.codigo === "sessao" ? { "Set-Cookie": cookieSessao("", 0) } : {};
    return json(res, e.status, { erro: e.codigo, mensagem: e.message !== e.codigo ? e.message : undefined }, extra);
  }
  console.error(e);
  json(res, 500, { erro: "interno" });
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};
const ESTATICOS: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/app.css": "app.css",
  "/icone.svg": "icone.svg",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/sw.js": "sw.js",
  "/icone-192.png": "icone-192.png",
  "/icone-512.png": "icone-512.png",
  "/icone-180.png": "icone-180.png",
  "/privacidade": "privacidade.html",
  "/privacidade.html": "privacidade.html",
};
function estatico(res: ServerResponse, nome: string) {
  let conteudo: Buffer;
  try { conteudo = readFileSync(join(PUBLICO, nome)); } catch { return json(res, 404, { erro: "nao-achei" }); }
  cabecalhosBase(res, nome === "privacidade.html" ? CSP_PRIVACIDADE : CSP);
  const ext = nome.slice(nome.lastIndexOf("."));
  res.writeHead(200, { "Content-Type": TIPOS[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(conteudo);
}

// ---------- sessão (cookie com o token do Contas) ----------
function cookieSessao(valor: string, segundos: number): string {
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${segundos}${SEGURO ? "; Secure" : ""}`;
}

function lerCookie(req: IncomingMessage): string | null {
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === COOKIE) {
      const v = parte.slice(i + 1).trim();
      return /^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(v) ? v : null;
    }
  }
  return null;
}

function sessao(req: IncomingMessage): Sessao {
  const jwt = lerCookie(req);
  if (!jwt) throw new ErroHttp(401, "sessao");
  return { jwt, chave: createHash("sha256").update(jwt).digest("hex") };
}

// Pedidos que mudam algo: só da própria página. O cookie é SameSite=Strict, e o cabeçalho X-Agenda obriga
// o navegador a pedir licença (CORS) a outro site, que nunca é dada.
function conferirOrigem(req: IncomingMessage) {
  if (req.headers["x-agenda"] !== "1") throw new ErroHttp(403, "origem");
  const origem = req.headers.origin;
  if (origem && origem !== `${SEGURO ? "https" : "http"}://${req.headers.host}`) throw new ErroHttp(403, "origem");
}

// Limite simples por pessoa (ou por IP, antes do login): 120 pedidos por minuto.
const contagem = new Map<string, { inicio: number; n: number }>();
function limitar(chave: string, max = 120) {
  const agora = Date.now();
  const c = contagem.get(chave);
  if (!c || agora - c.inicio > MIN) { contagem.set(chave, { inicio: agora, n: 1 }); return; }
  if (++c.n > max) throw new ErroHttp(429, "devagar");
}

async function lerCorpo(req: IncomingMessage, max = 32 * 1024): Promise<any> {
  const partes: Buffer[] = [];
  let tam = 0;
  for await (const p of req) {
    tam += (p as Buffer).length;
    if (tam > max) throw new ErroHttp(413, "grande");
    partes.push(p as Buffer);
  }
  if (!tam) return {};
  try { return JSON.parse(Buffer.concat(partes).toString("utf8")); } catch { throw new ErroHttp(400, "json"); }
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of contagem) if (agora - v.inicio > MIN) contagem.delete(k);
}, 10 * MIN).unref();

// ---------- rotas ----------
async function rotas(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const caminho = url.pathname;
  const metodo = req.method ?? "GET";

  if ((metodo === "GET" || metodo === "HEAD") && ESTATICOS[caminho]) return estatico(res, ESTATICOS[caminho]);
  if (!caminho.startsWith("/app/")) return json(res, 404, { erro: "nao-achei" });

  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  if (metodo !== "GET") conferirOrigem(req);

  if (caminho === "/app/sessao" && metodo === "POST") {
    limitar("ip:" + ip, 20);
    const b = await lerCorpo(req, 2048);
    const codigo = typeof b.codigo === "string" ? b.codigo : "";
    if (!/^[A-Za-z0-9_\-]{16,200}$/.test(codigo)) throw new ErroHttp(400, "codigo");
    const r = await contas("/api/auth/google/sessao", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
    if (r.status === 401 || r.status === 400) throw new ErroHttp(401, "codigo", "O código venceu. Entre de novo.");
    if (r.status === 429) throw new ErroHttp(429, "devagar");
    if (!r.ok) throw new ErroHttp(502, "contas");
    const j: any = await r.json();
    const token = String(j.token ?? "");
    if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(token)) throw new ErroHttp(502, "contas");
    return json(res, 200, { nome: String(j.user?.name ?? ""), email: String(j.user?.email ?? "") },
      { "Set-Cookie": cookieSessao(token, SESSAO_DIAS * 24 * 3600) });
  }

  if (caminho === "/app/sair" && metodo === "POST") {
    const jwt = lerCookie(req);
    if (jwt) esquecer(createHash("sha256").update(jwt).digest("hex"));
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieSessao("", 0) });
  }

  const s = sessao(req);
  limitar("s:" + s.chave);

  if (caminho === "/app/eu" && metodo === "GET") {
    const e = await eu(s);
    avisos.guardarSessao(e.id, s.jwt);   // renova o token que a rodada de avisos usa
    return json(res, 200, { nome: e.nome, email: e.email, chat: chatConfigurado(), funcoes: fn.funcoes(e.id) });
  }
  if (caminho === "/app/funcoes" && metodo === "POST") {
    const e = await eu(s);
    if (!e.id) throw new ErroHttp(401, "sessao");
    return json(res, 200, { funcoes: fn.mudar(e.id, await lerCorpo(req, 1024)) });
  }

  if (caminho === "/app/desconectar" && metodo === "POST") {
    const e = await eu(s);
    const r = await contas("/api/auth/google", { method: "DELETE", headers: { Authorization: `Bearer ${s.jwt}` } });
    if (!r.ok && r.status !== 401) throw new ErroHttp(502, "contas");
    if (e.id) { limparConversa(e.id, true); avisos.apagarTudo(e.id); remedios.apagarTudo(e.id); fn.apagarTudo(e.id); }
    esquecer(s.chave);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieSessao("", 0) });
  }

  // ----- chat -----
  if (caminho === "/app/chat" && metodo === "GET") {
    const e = await eu(s);
    return json(res, 200, conversa(e.id));
  }
  if (caminho === "/app/chat" && metodo === "POST") {
    const e = await eu(s);
    limitar("chat:" + e.id, 6);   // no máximo 6 mensagens por minuto, além do limite do dia
    const b = await lerCorpo(req, 12 * 1024 * 1024);   // foto reduzida pelo aparelho e/ou até 2 min de áudio em WAV
    return json(res, 200, await enviar(s, e.id, e.nome, b.texto, b.imagem, b.audio));
  }
  if (caminho === "/app/chat/confirmar" && metodo === "POST") {
    const e = await eu(s);
    const b = await lerCorpo(req, 1024);
    return json(res, 200, await confirmar(s, e.id, String(b.id ?? ""), b.sim === true));
  }
  if (caminho === "/app/chat" && metodo === "DELETE") {
    const e = await eu(s);
    limparConversa(e.id);
    return json(res, 200, { ok: true });
  }

  // ----- avisos (push) -----
  if (caminho === "/app/push" && metodo === "GET") return json(res, 200, avisos.estado((await eu(s)).id));
  if (caminho === "/app/push" && metodo === "POST") {
    const e = await eu(s);
    const b = await lerCorpo(req, 4096);
    return json(res, 200, avisos.assinar(e.id, s.jwt, b.assinatura));
  }
  if (caminho === "/app/push" && metodo === "DELETE") {
    const e = await eu(s);
    const b = await lerCorpo(req, 4096);
    return json(res, 200, avisos.desassinar(e.id, b.endpoint));
  }
  if (caminho === "/app/push/teste" && metodo === "POST") {
    const e = await eu(s);
    limitar("teste:" + e.id, 5);
    const n = await avisos.enviar(e.id, { titulo: "Avisos ligados ✓", texto: "É assim que os lembretes da sua agenda vão chegar aqui.", tag: "teste", url: "/" });
    return json(res, 200, { enviados: n });
  }

  // ----- remédios (dado de saúde: só aqui, por pessoa) -----
  if (caminho === "/app/remedios" || caminho.startsWith("/app/remedios/")) {
    const e = await eu(s);
    if (!e.id) throw new ErroHttp(401, "sessao");
    fn.exigir(fn.funcoes(e.id), "remedios");
    const hoje = partesNoFuso(new Date().toISOString(), await fuso(s)).data;
    if (caminho === "/app/remedios" && metodo === "GET") {
      const dia = url.searchParams.get("dia");
      return json(res, 200, remedios.painel(e.id, hoje, dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) && dia <= hoje ? dia : hoje));
    }
    if (caminho === "/app/remedios" && metodo === "POST") return json(res, 201, { remedio: remedios.cadastrar(e.id, hoje, await lerCorpo(req, 4096)) });
    if (caminho === "/app/remedios/dose" && metodo === "POST") return json(res, 200, remedios.marcarDose(e.id, hoje, await lerCorpo(req, 1024)));
    if (caminho === "/app/remedios/ler-caixa" && metodo === "POST") {
      limitar("chat:" + e.id, 6);
      const b = await lerCorpo(req, 8 * 1024 * 1024);
      return json(res, 200, await lerCaixa(e.id, b.imagem));
    }
    if (caminho === "/app/remedios/relatorio" && metodo === "GET") {
      return json(res, 200, remedios.relatorio(e.id, hoje, url.searchParams.get("de") ?? "", url.searchParams.get("ate") ?? hoje));
    }
    const r = caminho.match(/^\/app\/remedios\/([a-f0-9]{16})(\/compra|\/estoque)?$/);
    if (r && !r[2] && metodo === "PATCH") return json(res, 200, { remedio: remedios.editar(e.id, hoje, r[1], await lerCorpo(req, 4096)) });
    if (r && !r[2] && metodo === "DELETE") { remedios.apagar(e.id, r[1]); return json(res, 200, { ok: true }); }
    if (r && r[2] === "/compra" && metodo === "POST") return json(res, 200, { remedio: remedios.comprar(e.id, hoje, r[1], await lerCorpo(req, 1024)) });
    if (r && r[2] === "/estoque" && metodo === "POST") return json(res, 200, { remedio: remedios.acertarEstoque(e.id, hoje, r[1], await lerCorpo(req, 1024)) });
    return json(res, 404, { erro: "nao-achei" });
  }

  // ----- eventos -----
  if (caminho === "/app/eventos" && metodo === "GET") {
    const de = Date.parse(url.searchParams.get("de") ?? "");
    const ate = Date.parse(url.searchParams.get("ate") ?? "");
    // Função desligada: os eventos dela não vêm (continuam na agenda Google).
    return json(res, 200, { eventos: fn.visiveis(await listarEventos(s, de, ate), fn.funcoes((await eu(s)).id)) });
  }
  // Só as contas (para "a pagar"): até 125 dias, para pegar as atrasadas e as próximas de uma vez.
  if (caminho === "/app/contas" && metodo === "GET") {
    const de = Date.parse(url.searchParams.get("de") ?? "");
    const ate = Date.parse(url.searchParams.get("ate") ?? "");
    if (!fn.funcoes((await eu(s)).id).contas) return json(res, 200, { contas: [] });
    return json(res, 200, { contas: await listarEventos(s, de, ate, true) });
  }
  if (caminho === "/app/eventos" && metodo === "POST") {
    const b = await lerCorpo(req);
    fn.exigir(fn.funcoes((await eu(s)).id), fn.funcaoDoEvento(b));
    return json(res, 201, { evento: await criarEvento(s, b) });
  }
  const m = caminho.match(/^\/app\/eventos\/([^/]+)(\/feito)?$/);
  if (m) {
    const id = idValido(decodeURIComponent(m[1]));
    if (m[2] && metodo === "POST") {
      const b = await lerCorpo(req, 1024);
      return json(res, 200, { evento: await marcarFeito(s, id, b.feito === true) });
    }
    if (!m[2] && metodo === "PATCH") return json(res, 200, { evento: await editarEvento(s, id, await lerCorpo(req)) });
    if (!m[2] && metodo === "DELETE") {
      await apagarEvento(s, id, url.searchParams.get("todas") === "1");
      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { erro: "nao-achei" });
}

avisos.iniciarRodada();

createServer((req, res) => {
  rotas(req, res).catch((e) => { if (!res.headersSent) erro(res, e); else res.end(); });
}).listen(PORTA, HOST, () => console.log(`agenda-web em http://${HOST}:${PORTA} (chat: ${chatConfigurado() ? "ligado" : "sem chave"})`));
