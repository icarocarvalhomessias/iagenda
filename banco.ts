// agenda-web: o banco (SQLite) e a pasta de dados, comuns ao chat (chat.ts) e aos avisos (push.ts).
// Na VPS: /var/lib/agenda-web (StateDirectory, só do usuário agenda-web). No notebook: AGENDA_DADOS ou ./dados.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const PASTA = process.env.STATE_DIRECTORY ?? process.env.AGENDA_DADOS ?? join(process.cwd(), "dados");
mkdirSync(PASTA, { recursive: true });
export const db = new DatabaseSync(join(PASTA, "agenda.db"));
db.exec("PRAGMA journal_mode = WAL;");
