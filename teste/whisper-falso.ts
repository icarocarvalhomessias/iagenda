// Whisper FALSO para o teste no notebook: confere que recebeu um WAV e "transcreve" uma frase fixa.
// O agenda-web usa este no lugar do whisper-cli quando AGENDA_WHISPER aponta para cá (teste/local.ts).
import { readFileSync } from "node:fs";
const arq = process.argv[process.argv.indexOf("-f") + 1];
const b = readFileSync(arq);
if (b.subarray(0, 4).toString("latin1") !== "RIFF") { console.error("não é WAV"); process.exit(2); }
console.log("[Música]");
console.log(" Luz de 150 reais vence dia 15, todo mês.");
