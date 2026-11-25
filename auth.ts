// Login com Google, feito aqui mesmo (OAuth 2.0 com PKCE + OpenID Connect), sem serviço de fora.
//
//   GET /auth/google/start[?consentir=true]   manda para o Google (escopos: openid, email, profile, calendar.events)
//   GET /auth/google/retorno                  volta do Google: confere state, troca o code, abre a sessão
//
// - Só entra quem foi convidado (AGENDA_CONVITES ou `node admin.ts convidar e-mail`). AGENDA_CONVITES=* abre para todos.
// - O refresh token do Google fica no SQLite, cifrado com AES-256-GCM pela chave mestra (AGENDA_CHAVE_MESTRA, ou
//   _ARQUIVO, ou LoadCredential chave-mestra; na falta, um arquivo gerado na pasta de dados). O access token fica
//   só na memória.
// - A sessão é um valor aleatório num cookie HttpOnly; no banco fica só o hash dele.
// - O navegador nunca vê nenhum token do Google.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, PASTA } from "./banco.ts";
import { segredo } from "./config.ts";

const MIN = 60_000;
export const SITE = (process.env.AGENDA_SITE ?? "http://127.0.0.1:8091").replace(/\/$/, "");
const URL_AUTH = process.env.AGENDA_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const URL_TOKEN = process.env.AGENDA_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const URL_REVOGAR = process.env.AGENDA_GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";
const ESCOPO_AGENDA = "https://www.googleapis.com/auth/calendar.events";
const ESCOPOS = ["openid", "email", "profile", ESCOPO_AGENDA].join(" ");
const EMISSORES = new Set(["https://accounts.google.com", "accounts.google.com"]);
export const RETORNO = SITE + "/auth/google/retorno";
export const SESSAO_DIAS = 30;
const LOGIN_VALE = 10 * MIN;

// ---------- configuração ----------
const CLIENT_ID = process.env.AGENDA_GOOGLE_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = segredo("AGENDA_GOOGLE_CLIENT_SECRET", "google-client-secret");
export const loginConfigurado = () => Boolean(CLIENT_ID && CLIENT_SECRET);

// Chave mestra (32 bytes, em base64 ou hex). Sem ela, gera uma na pasta de dados: serve para testar, mas aí quem
// copiar a pasta inteira leva o banco e a chave juntos. Em produção, guarde a chave fora da pasta de dados.
const CHAVE = (() => {
  const dada = segredo("AGENDA_CHAVE_MESTRA", "chave-mestra");
  const arq = join(PASTA, "chave-mestra");
  let t = dada;
  if (!t) {
    if (!existsSync(arq)) {
      writeFileSync(arq, randomBytes(32).toString("base64"), { mode: 0o600 });
      console.warn(`Chave mestra gerada em ${arq}. Em produção, passe AGENDA_CHAVE_MESTRA (fora da pasta de dados).`);
    }
    t = readFileSync(arq, "utf8").trim();
  }
  const k = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, "hex") : Buffer.from(t, "base64");
  if (k.length !== 32) throw new Error("A chave mestra precisa ter 32 bytes (64 letras em hex ou 44 em base64).");
  return k;
})();

function cifrar(texto: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", CHAVE, iv);
  const corpo = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), corpo.toString("base64url")].join(".");
}
function decifrar(v: string): string {
  const [ver, iv, tag, corpo] = v.split(".");
  if (ver !== "v1") throw new Error("formato desconhecido");
  const d = createDecipheriv("aes-256-gcm", CHAVE, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(corpo, "base64url")), d.final()]).toString("utf8");
}

// ---------- banco ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
    nome TEXT NOT NULL DEFAULT '', refresh TEXT, criado INTEGER NOT NULL, ultimo_login INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessoes (hash TEXT PRIMARY KEY, usuario TEXT NOT NULL, criada INTEGER NOT NULL, expira INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessoes_usuario ON sessoes (usuario);
  CREATE TABLE IF NOT EXISTS convites (email TEXT PRIMARY KEY, criado INTEGER NOT NULL);
`);

export type Usuario = { id: string; email: string; nome: string };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const normalizarEmail = (e: string) => e.trim().toLowerCase();

// ---------- convites ----------
const CONVITES_ENV = (process.env.AGENDA_CONVITES ?? "").split(",").map(normalizarEmail).filter(Boolean);
export function convidado(email: string): boolean {
  const e = normalizarEmail(email);
  if (CONVITES_ENV.includes("*") || CONVITES_ENV.includes(e)) return true;
  return Boolean(db.prepare("SELECT 1 FROM convites WHERE email = ?").get(e));
}
export function convidar(email: string) {
  const e = normalizarEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("E-mail inválido.");
  db.prepare("INSERT OR IGNORE INTO convites (email, criado) VALUES (?, ?)").run(e, Date.now());
}
// Tira o convite e fecha as sessões abertas; os dados ficam até a pessoa desconectar (ou `admin.ts apagar`).
export function tirarConvite(email: string) {
  const e = normalizarEmail(email);
  db.prepare("DELETE FROM convites WHERE email = ?").run(e);
  const u = db.prepare("SELECT id FROM usuarios WHERE email = ?").get(e) as any;
  if (u) db.prepare("DELETE FROM sessoes WHERE usuario = ?").run(u.id);
}
export function listar() {
  return {
    env: CONVITES_ENV,
    convites: (db.prepare("SELECT email, criado FROM convites ORDER BY email").all() as any[]),
    usuarios: (db.prepare("SELECT id, email, nome, ultimo_login, refresh IS NOT NULL AS conectado FROM usuarios ORDER BY email").all() as any[]),
  };
}

// ---------- sessões ----------
export function abrirSessao(usuario: string): string {
  const valor = randomBytes(32).toString("base64url");
  const agora = Date.now();
  db.prepare("INSERT INTO sessoes (hash, usuario, criada, expira) VALUES (?, ?, ?, ?)")
    .run(hash(valor), usuario, agora, agora + SESSAO_DIAS * 24 * 3600_000);
  return valor;
}
export function lerSessao(valor: string): Usuario | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(valor)) return null;
  const l = db.prepare(`SELECT u.id, u.email, u.nome FROM sessoes s JOIN usuarios u ON u.id = s.usuario
    WHERE s.hash = ? AND s.expira > ?`).get(hash(valor), Date.now()) as any;
  return l ? { id: l.id, email: l.email, nome: l.nome } : null;
}
export function fecharSessao(valor: string) { db.prepare("DELETE FROM sessoes WHERE hash = ?").run(hash(valor)); }
setInterval(() => { db.prepare("DELETE FROM sessoes WHERE expira < ?").run(Date.now()); }, 60 * MIN).unref();

export function usuario(id: string): Usuario | null {
  const l = db.prepare("SELECT id, email, nome FROM usuarios WHERE id = ?").get(id) as any;
  return l ? { id: l.id, email: l.email, nome: l.nome } : null;
}

// ---------- fluxo OAuth ----------
export class ErroLogin extends Error {}   // a mensagem é o código que a página mostra (#erro=...)

const pendentes = new Map<string, { verificador: string; criado: number }>();
setInterval(() => {
  const limite = Date.now() - LOGIN_VALE;
  for (const [k, v] of pendentes) if (v.criado < limite) pendentes.delete(k);
}, 5 * MIN).unref();

// Devolve o endereço do Google e o state (que também vai num cookie curto, para amarrar a volta a este navegador).
export function inicio(consentir: boolean): { url: string; state: string } {
  if (!loginConfigurado()) throw new ErroLogin("configuracao");
  if (pendentes.size > 5000) pendentes.clear();
  const state = randomBytes(24).toString("base64url");
  const verificador = randomBytes(48).toString("base64url");
  pendentes.set(state, { verificador, criado: Date.now() });
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: RETORNO, response_type: "code", scope: ESCOPOS, state,
    code_challenge: createHash("sha256").update(verificador).digest("base64url"), code_challenge_method: "S256",
    access_type: "offline", include_granted_scopes: "true", prompt: consentir ? "consent select_account" : "select_account",
  });
  return { url: `${URL_AUTH}?${q}`, state };
}

function iguais(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function pedirToken(campos: Record<string, string>): Promise<{ status: number; j: any }> {
  let r: Response;
  try {
    r = await fetch(URL_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...campos }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error("Google (token) fora do ar:", (e as Error).message);
    throw new ErroLogin("falhou");
  }
  return { status: r.status, j: await r.json().catch(() => ({})) };
}

// O id_token chega direto do Google, pelo TLS, na troca do code: pela especificação do OpenID Connect, basta
// conferir emissor, destinatário e validade, sem baixar as chaves públicas.
function lerIdToken(t: unknown) {
  const partes = typeof t === "string" ? t.split(".") : [];
  if (partes.length !== 3) throw new ErroLogin("falhou");
  let p: any;
  try { p = JSON.parse(Buffer.from(partes[1], "base64url").toString("utf8")); } catch { throw new ErroLogin("falhou"); }
  if (!EMISSORES.has(p.iss) || p.aud !== CLIENT_ID || !(Number(p.exp) * 1000 > Date.now()) || !p.sub) throw new ErroLogin("falhou");
  if (!p.email || p.email_verified !== true) throw new ErroLogin("falhou");
  return { sub: String(p.sub), email: normalizarEmail(String(p.email)), nome: String(p.name ?? p.given_name ?? "").slice(0, 120) };
}

// Volta do Google. Devolve o valor da sessão nova, ou "consentir" quando o Google não mandou refresh token e
// não temos um guardado (a pessoa já tinha autorizado antes): aí é preciso pedir o consentimento de novo.
export async function retorno(q: URLSearchParams, stateDoCookie: string | null): Promise<{ sessao: string } | { consentir: true }> {
  if (q.get("error")) throw new ErroLogin(q.get("error") === "access_denied" ? "cancelado" : "falhou");
  const state = q.get("state") ?? "";
  const code = q.get("code") ?? "";
  const p = pendentes.get(state);
  if (!p || !stateDoCookie || !iguais(state, stateDoCookie)) throw new ErroLogin("expirou");
  pendentes.delete(state);
  if (Date.now() - p.criado > LOGIN_VALE) throw new ErroLogin("expirou");
  if (!code || code.length > 2000) throw new ErroLogin("falhou");

  const { status, j } = await pedirToken({ grant_type: "authorization_code", code, redirect_uri: RETORNO, code_verifier: p.verificador });
  if (status !== 200 || !j.access_token) { console.error("Google (token):", status, j.error ?? ""); throw new ErroLogin("falhou"); }
  if (!String(j.scope ?? "").split(" ").includes(ESCOPO_AGENDA)) throw new ErroLogin("agenda");
  const id = lerIdToken(j.id_token);
  if (!convidado(id.email)) throw new ErroLogin("convite");

  const agora = Date.now();
  const existente = db.prepare("SELECT id, refresh FROM usuarios WHERE google_sub = ?").get(id.sub) as any;
  if (!j.refresh_token && !existente?.refresh) return { consentir: true };
  const uid = existente?.id ?? randomBytes(16).toString("hex");
  if (existente) {
    db.prepare("UPDATE usuarios SET email = ?, nome = ?, ultimo_login = ?, refresh = COALESCE(?, refresh) WHERE id = ?")
      .run(id.email, id.nome, agora, j.refresh_token ? cifrar(String(j.refresh_token)) : null, uid);
  } else {
    db.prepare("INSERT INTO usuarios (id, google_sub, email, nome, refresh, criado, ultimo_login) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(uid, id.sub, id.email, id.nome, cifrar(String(j.refresh_token)), agora, agora);
  }
  guardarAcesso(uid, String(j.access_token), Number(j.expires_in));
  return { sessao: abrirSessao(uid) };
}

// ---------- access token ----------
const acessos = new Map<string, { token: string; ate: number }>();
function guardarAcesso(uid: string, token: string, segundos: number) {
  acessos.set(uid, { token, ate: Date.now() + Math.min(Number.isFinite(segundos) ? segundos * 1000 : 0, 55 * MIN) - MIN });
}
export function esquecerAcesso(uid: string) { acessos.delete(uid); }
setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of acessos) if (v.ate < agora) acessos.delete(k);
}, 10 * MIN).unref();

// "sessao": a pessoa não existe mais; "convite": o convite foi tirado; "reconectar": o Google não aceita mais a
// autorização (revogada pela pessoa ou vencida) e é preciso entrar de novo.
export class ErroAcesso extends Error {}

export async function acessoGoogle(uid: string): Promise<string> {
  const c = acessos.get(uid);
  if (c && c.ate > Date.now()) return c.token;
  const l = db.prepare("SELECT email, refresh FROM usuarios WHERE id = ?").get(uid) as any;
  if (!l) throw new ErroAcesso("sessao");
  if (!convidado(l.email)) throw new ErroAcesso("convite");
  if (!l.refresh) throw new ErroAcesso("reconectar");
  let refresh: string;
  try { refresh = decifrar(l.refresh); } catch { throw new ErroAcesso("reconectar"); }
  let r: { status: number; j: any };
  try { r = await pedirToken({ grant_type: "refresh_token", refresh_token: refresh }); } catch { throw new ErroAcesso("google"); }
  if (r.j.error === "invalid_grant") {
    db.prepare("UPDATE usuarios SET refresh = NULL WHERE id = ?").run(uid);
    throw new ErroAcesso("reconectar");
  }
  if (r.status !== 200 || !r.j.access_token) { console.error("Google (refresh):", r.status, r.j.error ?? ""); throw new ErroAcesso("google"); }
  guardarAcesso(uid, String(r.j.access_token), Number(r.j.expires_in));
  return String(r.j.access_token);
}

// Sair e desconectar: revoga no Google e apaga a pessoa e as sessões (o resto, quem chama apaga).
export async function desconectar(uid: string) {
  const l = db.prepare("SELECT refresh FROM usuarios WHERE id = ?").get(uid) as any;
  if (l?.refresh) {
    try {
      await fetch(URL_REVOGAR, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: decifrar(l.refresh) }), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) { console.error("Google (revogar):", (e as Error).message); }
  }
  db.prepare("DELETE FROM sessoes WHERE usuario = ?").run(uid);
  db.prepare("DELETE FROM usuarios WHERE id = ?").run(uid);
  acessos.delete(uid);
}
