// agenda-web: avisos por push (Web Push, RFC 8291 + VAPID), por pessoa. Sem biblioteca: a cifra aes128gcm e o
// JWT ES256 saem do node:crypto (chaves VAPID próprias, geradas na primeira vez).
//
// Quem liga os avisos num aparelho deixa a assinatura do navegador guardada aqui. A rodada lê a agenda Google da
// pessoa com o navegador fechado pela autorização guardada no login (auth.ts). Se o Google deixar de aceitar a
// autorização, a pessoa recebe um último aviso para entrar de novo; ao entrar, os avisos voltam sozinhos.
//
// A rodada (a cada 5 minutos) manda, no fuso da agenda de cada pessoa:
//   - "Hoje": de manhã (a partir das 8h, até as 12h), o que tem no dia e não está feito;
//   - "Amanhã": à noite (a partir das 20h, até as 23h), o que tem no dia seguinte;
//   - "Às HH:MM": até 1 hora antes de cada evento com hora que não está feito;
//   - "Remédios da manhã/tarde/noite/das HH:MM": no horário (até 2 h depois), o que ainda não foi marcado como tomado;
//   - "Remédio acabando": de manhã, o que dá para 5 dias ou menos (ou está com a caixa vencida).
// Cada aviso sai uma vez só (tabela push_enviados).
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErroHttp, MIN, type Sessao, type Evento, fuso, listarEventos, partesNoFuso } from "./agenda.ts";
import { db, PASTA } from "./banco.ts";
import { avisosDeRemedio } from "./remedios.ts";
import { funcoes, visiveis } from "./funcoes.ts";

const MAX_APARELHOS = 5;
const RODADA = 5 * MIN;
// Só os serviços de push dos navegadores (uma assinatura falsa não faz o servidor chamar outro lugar).
const PUSH_HOSTS = /^(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[\w-]+\.notify\.windows\.com)$/;
const SITE = process.env.AGENDA_SITE ?? "http://127.0.0.1:8091";

db.exec(`
  CREATE TABLE IF NOT EXISTS push_assinaturas (endpoint TEXT PRIMARY KEY, usuario TEXT NOT NULL, p256dh TEXT NOT NULL,
    auth TEXT NOT NULL, criado INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS push_assinaturas_usuario ON push_assinaturas (usuario);
  CREATE TABLE IF NOT EXISTS push_enviados (usuario TEXT NOT NULL, chave TEXT NOT NULL, quando INTEGER NOT NULL,
    PRIMARY KEY (usuario, chave));
`);

// ---------- VAPID e cifra ----------
const b64u = (b: Buffer) => b.toString("base64url");
const ARQ_VAPID = join(PASTA, "vapid.json");
const VAPID = (() => {
  if (!existsSync(ARQ_VAPID)) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const publica = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]));
    writeFileSync(ARQ_VAPID, JSON.stringify({ publica, privada: privateKey.export({ format: "pem", type: "pkcs8" }) }), { mode: 0o600 });
  }
  const v = JSON.parse(readFileSync(ARQ_VAPID, "utf8"));
  return { publica: v.publica as string, privada: createPrivateKey(v.privada) };
})();
export const chavePublica = () => VAPID.publica;

type Assinatura = { endpoint: string; p256dh: string; auth: string };
function cifrar(s: Assinatura, texto: string): Buffer {
  const ua = Buffer.from(s.p256dh, "base64url"), auth = Buffer.from(s.auth, "base64url");
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const as = ecdh.getPublicKey(), segredo = ecdh.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync("sha256", segredo, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua, as]), 32));
  const sal = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, sal, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, sal, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const corpo = Buffer.concat([c.update(Buffer.concat([Buffer.from(texto), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([sal, rs, Buffer.from([as.length]), as, corpo]);
}
function jwtVapid(endpoint: string): string {
  const cab = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const dados = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const ass = sign("sha256", Buffer.from(cab + "." + dados), { key: VAPID.privada, dsaEncoding: "ieee-p1363" });
  return cab + "." + dados + "." + b64u(ass);
}

type Aviso = { titulo: string; texto: string; tag?: string; url?: string };
// Manda para todos os aparelhos da pessoa; assinatura que o serviço diz que acabou (404/410) sai.
export async function enviar(usuario: string, aviso: Aviso): Promise<number> {
  const lista = db.prepare("SELECT endpoint, p256dh, auth FROM push_assinaturas WHERE usuario = ?").all(usuario) as Assinatura[];
  let ok = 0;
  for (const s of lista) {
    try {
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          TTL: String(6 * 3600), Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
          Authorization: `vapid t=${jwtVapid(s.endpoint)}, k=${VAPID.publica}`,
        },
        body: new Uint8Array(cifrar(s, JSON.stringify(aviso))),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.status === 404 || r.status === 410) { db.prepare("DELETE FROM push_assinaturas WHERE endpoint = ?").run(s.endpoint); continue; }
      if (r.ok) ok++; else console.error("push:", r.status, (await r.text().catch(() => "")).slice(0, 200));
    } catch (e) { console.error("push:", (e as Error).message); }
  }
  return ok;
}

// ---------- assinaturas ----------
export function assinar(usuario: string, sub: any) {
  let valida = false;
  try {
    const u = new URL(sub?.endpoint);
    // AGENDA_PUSH_TESTE=1 (só no notebook): aceita um serviço de push falso em 127.0.0.1.
    const teste = process.env.AGENDA_PUSH_TESTE === "1" && u.hostname === "127.0.0.1";
    valida = (teste || (u.protocol === "https:" && PUSH_HOSTS.test(u.hostname))) && sub.endpoint.length < 1000
      && Buffer.from(String(sub.keys?.p256dh), "base64url").length === 65 && Buffer.from(String(sub.keys?.auth), "base64url").length === 16;
  } catch { valida = false; }
  if (!valida) throw new ErroHttp(400, "assinatura", "Esse navegador mandou uma assinatura de aviso que não reconheço.");
  db.prepare(`INSERT INTO push_assinaturas (endpoint, usuario, p256dh, auth, criado) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET usuario = excluded.usuario, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(sub.endpoint, usuario, sub.keys.p256dh, sub.keys.auth, Date.now());
  // No máximo MAX_APARELHOS por pessoa: o mais antigo sai.
  db.prepare(`DELETE FROM push_assinaturas WHERE usuario = ? AND endpoint NOT IN
    (SELECT endpoint FROM push_assinaturas WHERE usuario = ? ORDER BY criado DESC LIMIT ${MAX_APARELHOS})`).run(usuario, usuario);
  return estado(usuario);
}
export function desassinar(usuario: string, endpoint: unknown) {
  if (typeof endpoint === "string") db.prepare("DELETE FROM push_assinaturas WHERE usuario = ? AND endpoint = ?").run(usuario, endpoint);
  return estado(usuario);
}
export function estado(usuario: string) {
  const n = (db.prepare("SELECT count(*) n FROM push_assinaturas WHERE usuario = ?").get(usuario) as any).n as number;
  return { chave: VAPID.publica, aparelhos: n };
}
export function apagarTudo(usuario: string) {
  if (!usuario) return;
  for (const t of ["push_assinaturas", "push_enviados"]) db.prepare(`DELETE FROM ${t} WHERE usuario = ?`).run(usuario);
}

// ---------- rodada ----------
const somarDias = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 24 * 3600_000).toISOString().slice(0, 10);
function jaEnviado(usuario: string, chave: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM push_enviados WHERE usuario = ? AND chave = ?").get(usuario, chave));
}
const marcarEnviado = (usuario: string, chave: string) =>
  db.prepare("INSERT OR IGNORE INTO push_enviados (usuario, chave, quando) VALUES (?, ?, ?)").run(usuario, chave, Date.now());

function noDia(ev: Evento, dia: string, tz: string): boolean {
  if (ev.diaInteiro) return ev.inicio <= dia && dia < ev.fim;
  const a = partesNoFuso(ev.inicio, tz).data, b = partesNoFuso(new Date(Date.parse(ev.fim) - 1).toISOString(), tz).data;
  return a <= dia && dia <= b;
}
function linha(evs: Evento[], tz: string): string {
  const itens = evs
    .sort((x, y) => (x.diaInteiro === y.diaInteiro ? (x.inicio < y.inicio ? -1 : 1) : x.diaInteiro ? -1 : 1))
    // Conta aparece como "Pagar Luz", sem valor (o aviso aparece na tela bloqueada).
    .map((e) => (e.tipo === "conta" ? `Pagar ${e.titulo}` : e.diaInteiro ? e.titulo : `${partesNoFuso(e.inicio, tz).hora} ${e.titulo}`));
  const mostrar = itens.slice(0, 4).join(" · ");
  return itens.length > 4 ? `${mostrar} · e mais ${itens.length - 4}` : mostrar;
}

// Quais avisos estão na hora para uma pessoa (função pura, para dar para testar).
// aviso null: nada a mandar, mas a chave fica marcada (ex.: dia sem nada) para não olhar de novo.
export function avisosDaHora(evs: Evento[], tz: string, agora: number, jaFoi: (chave: string) => boolean): { chave: string; aviso: Aviso | null }[] {
  const { data: hoje, hora } = partesNoFuso(new Date(agora).toISOString(), tz);
  const h = Number(hora.slice(0, 2));
  const pendentes = evs.filter((e) => !e.feito);
  const saida: { chave: string; aviso: Aviso | null }[] = [];

  if (h >= 8 && h < 12 && !jaFoi(`hoje|${hoje}`)) {
    const doDia = pendentes.filter((e) => noDia(e, hoje, tz));
    if (doDia.length) saida.push({ chave: `hoje|${hoje}`, aviso: { titulo: "Hoje", texto: linha(doDia, tz), tag: `hoje-${hoje}`, url: `/#dia=${hoje}` } });
    else saida.push({ chave: `hoje|${hoje}`, aviso: null });
  }
  if (h >= 20 && h < 23) {
    const amanha = somarDias(hoje, 1);
    if (!jaFoi(`amanha|${amanha}`)) {
      const doDia = pendentes.filter((e) => noDia(e, amanha, tz));
      saida.push({ chave: `amanha|${amanha}`, aviso: doDia.length ? { titulo: "Amanhã", texto: linha(doDia, tz), tag: `amanha-${amanha}`, url: `/#dia=${amanha}` } : null });
    }
  }
  for (const e of pendentes) {
    if (e.diaInteiro) continue;
    const ini = Date.parse(e.inicio);
    const falta = ini - agora;
    const chave = `ev|${e.id}|${e.inicio}`;
    if (falta > 0 && falta <= 60 * MIN && !jaFoi(chave)) {
      const p = partesNoFuso(e.inicio, tz);
      saida.push({ chave, aviso: { titulo: `Às ${p.hora}: ${e.titulo}`, texto: e.local ? e.local : `Daqui a ${Math.max(1, Math.round(falta / MIN))} min.`, tag: `ev-${e.id}`, url: `/#dia=${p.data}` } });
    }
  }
  return saida;
}

let rodando = false;
async function rodada() {
  if (rodando) return;
  rodando = true;
  try {
    const pessoas = db.prepare("SELECT DISTINCT usuario FROM push_assinaturas").all() as { usuario: string }[];
    const agora = Date.now();
    for (const { usuario } of pessoas) {
      const s: Sessao = { usuario };
      try {
        const tz = await fuso(s);
        // Só o que a pessoa deixou ligado no menu do perfil (Compromissos, Contas, Remédios).
        const f = funcoes(usuario);
        const evs = visiveis(await listarEventos(s, agora - 6 * 3600_000, agora + 40 * 3600_000), f);
        for (const { chave, aviso } of avisosDaHora(evs, tz, agora, (c) => jaEnviado(usuario, c))) {
          if (aviso) await enviar(usuario, aviso);
          marcarEnviado(usuario, chave);
        }
        // Remédios: hora de tomar (o que ainda não foi marcado) e, de manhã, o que está acabando ou vencido.
        const p = partesNoFuso(new Date(agora).toISOString(), tz);
        for (const { chave, aviso } of f.remedios ? avisosDeRemedio(usuario, p.data, p.hora, (c) => jaEnviado(usuario, c)) : []) {
          if (aviso) await enviar(usuario, aviso);
          marcarEnviado(usuario, chave);
        }
      } catch (e) {
        if (e instanceof ErroHttp && (e.codigo === "convite" || e.codigo === "sessao")) { apagarTudo(usuario); continue; }
        if (e instanceof ErroHttp && e.codigo === "reconectar") {
          // Um aviso por dia, no máximo, enquanto a pessoa não entrar de novo.
          const chave = `reconectar|${new Date(agora).toISOString().slice(0, 10)}`;
          if (!jaEnviado(usuario, chave)) {
            await enviar(usuario, { titulo: "Seus avisos pararam", texto: "Entre de novo na IAgenda com o Google para voltar a receber os avisos.", tag: "sessao", url: "/" });
            marcarEnviado(usuario, chave);
          }
          continue;
        }
        console.error("avisos:", usuario.slice(0, 8), e instanceof ErroHttp ? e.codigo : (e as Error).message);
      }
    }
    db.prepare("DELETE FROM push_enviados WHERE quando < ?").run(agora - 4 * 24 * 3600_000);
  } finally {
    rodando = false;
  }
}

export function iniciarRodada() {
  setTimeout(() => { rodada().catch((e) => console.error("avisos:", e)); }, 20_000).unref();
  setInterval(() => { rodada().catch((e) => console.error("avisos:", e)); }, RODADA).unref();
}
