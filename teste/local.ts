// Sobe a IAgenda no computador com dados fictícios: o login do Google, o Google Calendar e a IA são o teste/falso.ts.
// Uso: node teste/local.ts e abra http://127.0.0.1:8091 (use 127.0.0.1, não localhost: é o endereço de volta do login).
// Os dados do teste (chat, avisos) ficam em teste/dados/, fora do git.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const DADOS = join(AQUI, "dados");
mkdirSync(DADOS, { recursive: true });

const filhos = [
  spawn(process.execPath, [join(AQUI, "falso.ts")], { stdio: "inherit" }),
  spawn(process.execPath, [join(AQUI, "..", "servidor.ts")], {
    stdio: "inherit",
    cwd: join(AQUI, ".."),
    env: {
      ...process.env,
      AGENDA_HOST: "127.0.0.1", AGENDA_PORTA: "8091",
      AGENDA_SITE: "http://127.0.0.1:8091",
      // Login do Google falso (teste/falso.ts); só a Fulana é convidada.
      AGENDA_GOOGLE_CLIENT_ID: "iagenda-teste.apps.googleusercontent.com", AGENDA_GOOGLE_CLIENT_SECRET: "segredo-de-teste",
      AGENDA_GOOGLE_AUTH_URL: "http://127.0.0.1:8099/o/oauth2/v2/auth", AGENDA_GOOGLE_TOKEN_URL: "http://127.0.0.1:8099/token",
      AGENDA_GOOGLE_REVOKE_URL: "http://127.0.0.1:8099/revoke", AGENDA_CONVITES: "fulana@gmail.com",
      AGENDA_GOOGLE: "http://127.0.0.1:8099/calendar/v3",
      AGENDA_ANTHROPIC_URL: "http://127.0.0.1:8099",
      AGENDA_ANTHROPIC_CHAVE: "sk-ant-teste",
      AGENDA_DADOS: DADOS, AGENDA_PUSH_TESTE: "1",
      AGENDA_WHISPER: join(AQUI, "whisper-falso.ts"),
      AGENDA_CHAT_DIA: "100",
      // Modo demonstração junto com o login: "Experimentar sem conta" na tela de entrar.
      AGENDA_DEMO: "1",
    },
  }),
];
const parar = () => { for (const f of filhos) f.kill(); process.exit(0); };
process.on("SIGINT", parar);
process.on("SIGTERM", parar);
for (const f of filhos) f.on("exit", (c) => { if (c) console.error("um processo do teste parou com código", c); });
