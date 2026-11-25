// Administração pela linha de comando (rode com as mesmas variáveis do servidor, para usar o mesmo banco):
//
//   node admin.ts convidar fulana@gmail.com     libera o login desse e-mail
//   node admin.ts tirar fulana@gmail.com        tira o convite e fecha as sessões abertas
//   node admin.ts listar                        convites e pessoas que já entraram
//   node admin.ts apagar fulana@gmail.com       revoga no Google e apaga tudo da pessoa (chat, remédios, avisos)
import * as auth from "./auth.ts";
import { limparConversa } from "./chat.ts";
import * as avisos from "./push.ts";
import * as remedios from "./remedios.ts";
import * as fn from "./funcoes.ts";
import { db } from "./banco.ts";

const [comando, email] = process.argv.slice(2);
const data = (ms: number) => (ms ? new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "-");

try {
  if (comando === "convidar" && email) {
    auth.convidar(email);
    console.log(`Convidado: ${email.trim().toLowerCase()}`);
  } else if (comando === "tirar" && email) {
    auth.tirarConvite(email);
    console.log(`Convite tirado e sessões fechadas: ${email.trim().toLowerCase()}`);
  } else if (comando === "listar") {
    const l = auth.listar();
    if (l.env.length) console.log(`AGENDA_CONVITES: ${l.env.join(", ")}`);
    console.log(`Convites (${l.convites.length}):`);
    for (const c of l.convites) console.log(`  ${c.email}  desde ${data(c.criado)}`);
    console.log(`Pessoas que já entraram (${l.usuarios.length}):`);
    for (const u of l.usuarios) console.log(`  ${u.email}  ${u.nome || ""}  último login ${data(u.ultimo_login)}${u.conectado ? "" : "  (precisa entrar de novo)"}`);
  } else if (comando === "apagar" && email) {
    const u = db.prepare("SELECT id FROM usuarios WHERE email = ?").get(email.trim().toLowerCase()) as any;
    if (!u) { console.log("Ninguém com esse e-mail entrou ainda."); process.exit(1); }
    await auth.desconectar(u.id);
    limparConversa(u.id, true); avisos.apagarTudo(u.id); remedios.apagarTudo(u.id); fn.apagarTudo(u.id);
    console.log(`Apagado: ${email.trim().toLowerCase()} (o convite continua; para tirar: node admin.ts tirar ${email})`);
  } else {
    console.log("Uso: node admin.ts convidar|tirar|apagar <e-mail>  ou  node admin.ts listar");
    process.exit(1);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
process.exit(0);
