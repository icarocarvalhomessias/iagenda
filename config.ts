// Segredos: o mesmo nome serve para os três jeitos de hospedar.
//   NOME=valor                      direto na variável (Docker com .env, teste local)
//   NOME_ARQUIVO=/caminho           num arquivo (Docker secrets em /run/secrets, Kubernetes)
//   LoadCredential=credencial:...   do systemd (lido em $CREDENTIALS_DIRECTORY/credencial)
import { readFileSync } from "node:fs";
import { join } from "node:path";

function lerArquivo(arq: string): string {
  try { return readFileSync(arq, "utf8").trim(); } catch { return ""; }
}

export function segredo(nome: string, credencial: string): string {
  const valor = process.env[nome]?.trim();
  if (valor) return valor;
  const arq = process.env[nome + "_ARQUIVO"];
  if (arq) return lerArquivo(arq);
  if (process.env.CREDENTIALS_DIRECTORY) return lerArquivo(join(process.env.CREDENTIALS_DIRECTORY, credencial));
  return "";
}
