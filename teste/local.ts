// Sobe o agenda-web no notebook com dados fictícios: o Contas, o Google e a IA são o teste/falso.ts.
// Uso: node teste/local.ts e abra http://127.0.0.1:8091/#codigo=codigo-de-teste-1234567890
// Os dados do teste (chat, avisos) ficam em teste/dados/, fora do git.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const DADOS = join(AQUI, "dados");
mkdirSync(DADOS, { recursive: true });
writeFileSync(join(DADOS, "segredo.txt"), "x".repeat(40));   // o mesmo do falso.ts
writeFileSync(join(DADOS, "chave.txt"), "sk-ant-teste");

const filhos = [
  spawn(process.execPath, [join(AQUI, "falso.ts")], { stdio: "inherit" }),
  spawn(process.execPath, [join(AQUI, "..", "servidor.ts")], {
    stdio: "inherit",
    cwd: join(AQUI, ".."),
    env: {
      ...process.env,
      AGENDA_HOST: "127.0.0.1", AGENDA_PORTA: "8091", AGENDA_INSEGURO: "1",
      AGENDA_CONTAS: "http://127.0.0.1:8099", AGENDA_GOOGLE: "http://127.0.0.1:8099/calendar/v3",
      AGENDA_ANTHROPIC_URL: "http://127.0.0.1:8099",
      AGENDA_SEGREDO: join(DADOS, "segredo.txt"), AGENDA_ANTHROPIC_CHAVE: join(DADOS, "chave.txt"),
      AGENDA_DADOS: DADOS, AGENDA_PUSH_TESTE: "1",
      AGENDA_WHISPER: join(AQUI, "whisper-falso.ts"),
      AGENDA_CHAT_DIA: "100",
    },
  }),
];
const parar = () => { for (const f of filhos) f.kill(); process.exit(0); };
process.on("SIGINT", parar);
process.on("SIGTERM", parar);
for (const f of filhos) f.on("exit", (c) => { if (c) console.error("um processo do teste parou com código", c); });
