// agenda-web: a IAgenda, para pessoas convidadas.
// A pessoa entra com Google (auth.ts) e volta já com o cookie da sessão; daí em diante tudo passa por aqui.
//
//   /                       a página da agenda (publico/index.html, app.js, app.css)
//   /privacidade            política de privacidade
//   GET  /auth/google/start     manda para o Google (?consentir=true pede o consentimento de novo)
//   GET  /auth/google/retorno   volta do Google, abre a sessão (cookie HttpOnly) e manda para /
//   POST /demo/entrar       com AGENDA_DEMO=1: entra como visitante, com uma agenda fictícia (demo.ts)
//   GET  /modo              { google, demo }: o que a tela de entrar mostra
//   GET  /app/eu            nome e e-mail de quem está logado
//   GET  /app/eventos       ?de=ISO&ate=ISO: eventos da agenda principal (primary) da pessoa, no máximo 62 dias
//   GET  /app/contas        ?de=ISO&ate=ISO: só as contas a pagar (eventos com icarusTipo=conta), no máximo 125 dias
//   POST /app/eventos       cria
//   PATCH  /app/eventos/:id edita (com "todas": nome, local e descrição de todas as repetições)
//   DELETE /app/eventos/:id ?todas=1 apaga a série inteira
//   POST /app/eventos/:id/feito  { feito }: "✓ " no título e icarusFeito em extendedProperties.private
//   POST /app/sair          apaga o cookie
//   POST /app/desconectar   revoga no Google e apaga a pessoa, a conversa do chat, os remédios, os avisos e o cookie
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
// O refresh token do Google fica cifrado no SQLite e o access token só na memória deste processo; o navegador
// nunca recebe nenhum dos dois. Em produção: serviço systemd (deploy/agenda-web.service), usuário próprio sem sudo,
// escutando só atrás do proxy reverso.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { ErroHttp, MIN, type Sessao, eu, fuso, partesNoFuso, listarEventos, criarEvento, editarEvento, apagarEvento, marcarFeito, idValido } from "./agenda.ts";
import { chatConfigurado, audioConfigurado, conversa, enviar, confirmar, limparConversa, lerCaixa } from "./chat.ts";
import * as avisos from "./push.ts";
import * as remedios from "./remedios.ts";
import * as fn from "./funcoes.ts";
import * as auth from "./auth.ts";
import * as demo from "./demo.ts";
import { apagarPessoa } from "./apagar.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.AGENDA_HOST ?? "127.0.0.1";
const PORTA = Number(process.env.AGENDA_PORTA ?? 8091);
// Sem HTTPS (AGENDA_SITE com http://, teste no computador), o cookie não pode ter Secure nem o prefixo __Host-.
const SEGURO = process.env.AGENDA_INSEGURO ? process.env.AGENDA_INSEGURO !== "1" : auth.SITE.startsWith("https://");
// Atrás de um proxy reverso (Caddy, nginx), o IP de verdade vem em X-Forwarded-For. Sem proxy, esse cabeçalho vem
// de quem pede e não vale para o limite por IP.
const PROXY = process.env.AGENDA_PROXY === "1";
const COOKIE = SEGURO ? "__Host-agenda" : "agenda";
const COOKIE_LOGIN = SEGURO ? "__Host-agenda-login" : "agenda-login";
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
    const extra: Record<string, string> = e.codigo === "sessao" ? { "Set-Cookie": cookieSessao("", 0) } : {};
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

// ---------- sessão (cookie com um valor aleatório; no banco, só o hash) ----------
function cookieSessao(valor: string, segundos: number): string {
  return `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${segundos}${SEGURO ? "; Secure" : ""}`;
}
// O cookie do login vai e volta do Google numa navegação vinda de outro site: por isso Lax (Strict não voltaria).
function cookieLogin(valor: string, segundos: number): string {
  return `${COOKIE_LOGIN}=${valor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${segundos}${SEGURO ? "; Secure" : ""}`;
}

function lerCookie(req: IncomingMessage, nome = COOKIE): string | null {
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) {
      const v = parte.slice(i + 1).trim();
      return /^[A-Za-z0-9_\-]{16,100}$/.test(v) ? v : null;
    }
  }
  return null;
}

function sessao(req: IncomingMessage): Sessao {
  const valor = lerCookie(req);
  const u = valor ? auth.lerSessao(valor) : null;
  if (!u) throw new ErroHttp(401, "sessao");
  return { usuario: u.id };
}

function redirecionar(res: ServerResponse, para: string, cookies: string[] = [], status = 302) {
  cabecalhosBase(res);
  res.writeHead(status, { Location: para, "Cache-Control": "no-store", ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
  res.end();
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
  if (caminho === "/saude" && metodo === "GET") return json(res, 200, { ok: true });
  if (caminho === "/modo" && metodo === "GET") return json(res, 200, { google: auth.loginConfigurado(), demo: demo.DEMO, demoHoras: demo.HORAS });
  const xff = PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim() : "";
  const ip = xff || String(req.socket.remoteAddress ?? "");

  // ----- login com Google -----
  if (caminho === "/auth/google/start" && metodo === "GET") {
    try {
      limitar("ip:" + ip, 20);
      const { url: para, state } = auth.inicio(url.searchParams.get("consentir") === "true");
      return redirecionar(res, para, [cookieLogin(state, 10 * 60)]);
    } catch (e) {
      return redirecionar(res, "/#erro=" + (e instanceof auth.ErroLogin ? e.message : "falhou"));
    }
  }
  if (caminho === "/auth/google/retorno" && metodo === "GET") {
    const limpar = cookieLogin("", 0);
    try {
      limitar("ip:" + ip, 20);
      const r = await auth.retorno(url.searchParams, lerCookie(req, COOKIE_LOGIN));
      if ("consentir" in r) return redirecionar(res, "/auth/google/start?consentir=true", [limpar]);
      return redirecionar(res, "/", [limpar, cookieSessao(r.sessao, auth.SESSAO_DIAS * 24 * 3600)]);
    } catch (e) {
      if (!(e instanceof auth.ErroLogin)) console.error("login:", e);
      return redirecionar(res, "/#erro=" + (e instanceof auth.ErroLogin ? e.message : "falhou"), [limpar]);
    }
  }
  // ----- demonstração: formulário da tela de entrar (POST, para robôs que seguem links não criarem visitantes) -----
  if (caminho === "/demo/entrar" && metodo === "POST") {
    try {
      // Só da própria tela de entrar. Com Referrer-Policy no-referrer, o navegador manda "Origin: null" no formulário;
      // por isso vale o Sec-Fetch-Site, quando vem.
      const site = req.headers["sec-fetch-site"], origem = req.headers.origin;
      const daqui = site ? site === "same-origin" : !origem || origem === `${SEGURO ? "https" : "http"}://${req.headers.host}`;
      if (!daqui) throw new demo.ErroDemo("falhou");
      limitar("demo:" + ip, 5);
      const valor = await demo.entrar();
      return redirecionar(res, "/", [cookieSessao(valor, demo.HORAS * 3600)], 303);
    } catch (e) {
      if (!(e instanceof demo.ErroDemo) && !(e instanceof ErroHttp && e.status === 429)) console.error("demo:", e);
      const cod = e instanceof demo.ErroDemo ? "demo-" + e.message : e instanceof ErroHttp && e.status === 429 ? "devagar" : "falhou";
      return redirecionar(res, "/#erro=" + cod, [], 303);
    }
  }
  if (!caminho.startsWith("/app/")) return json(res, 404, { erro: "nao-achei" });

  if (metodo !== "GET") conferirOrigem(req);

  if (caminho === "/app/sair" && metodo === "POST") {
    const valor = lerCookie(req);
    const u = valor ? auth.lerSessao(valor) : null;
    // Visitante da demonstração não volta: sair já apaga tudo dele.
    if (u && auth.ehDemo(u.id)) await apagarPessoa(u.id);
    else if (valor) auth.fecharSessao(valor);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieSessao("", 0) });
  }

  const s = sessao(req);
  limitar("s:" + s.usuario);

  if (caminho === "/app/eu" && metodo === "GET") {
    const e = eu(s);
    const visitante = auth.ehDemo(e.id);
    return json(res, 200, { nome: e.nome, email: visitante ? "" : e.email, demo: visitante, demoHoras: demo.HORAS,
      chat: chatConfigurado(), audio: chatConfigurado() && audioConfigurado(), funcoes: fn.funcoes(e.id) });
  }
  if (caminho === "/app/funcoes" && metodo === "POST") {
    const e = await eu(s);
    if (!e.id) throw new ErroHttp(401, "sessao");
    return json(res, 200, { funcoes: fn.mudar(e.id, await lerCorpo(req, 1024)) });
  }

  if (caminho === "/app/desconectar" && metodo === "POST") {
    await apagarPessoa(eu(s).id);
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
    return json(res, 200, avisos.assinar(e.id, b.assinatura));
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
}).listen(PORTA, HOST, () => console.log(`IAgenda em http://${HOST}:${PORTA} (site: ${auth.SITE}; login: ${auth.loginConfigurado() ? "ok" : "falta AGENDA_GOOGLE_CLIENT_ID e AGENDA_GOOGLE_CLIENT_SECRET"}; demonstração: ${demo.DEMO ? "ligada" : "desligada"}; chat: ${chatConfigurado() ? "ligado" : "sem chave"}; áudio: ${audioConfigurado() ? "ligado" : "desligado"})`));
