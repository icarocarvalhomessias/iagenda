// Importado primeiro em cada teste de unidade: aponta o banco para uma pasta temporária e dá valores de teste às
// variáveis, antes que banco.ts e auth.ts leiam o ambiente. Nada aqui é segredo de verdade.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENDA_DADOS = mkdtempSync(join(tmpdir(), "iagenda-teste-"));
process.env.AGENDA_CHAVE_MESTRA = Buffer.alloc(32, 7).toString("base64");
process.env.AGENDA_SITE = "http://127.0.0.1:8091";
process.env.AGENDA_GOOGLE_CLIENT_ID = "iagenda-teste.apps.googleusercontent.com";
process.env.AGENDA_GOOGLE_CLIENT_SECRET = "segredo-de-teste";
process.env.AGENDA_CONVITES = "fulana@gmail.com";
process.env.AGENDA_DEMO = "1";
delete process.env.AGENDA_ANTHROPIC_CHAVE;
delete process.env.ANTHROPIC_API_KEY;
