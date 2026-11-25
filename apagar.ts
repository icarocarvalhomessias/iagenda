// agenda-web: apagar tudo de uma pessoa (desconectar, `admin.ts apagar` e a limpeza dos visitantes da demonstração).
// Revoga o acesso no Google (se houver) e apaga a pessoa, as sessões, a conversa do chat, os remédios, os avisos,
// as funções e a agenda local da demonstração. A agenda Google da pessoa não muda.
import * as auth from "./auth.ts";
import { esquecer } from "./agenda.ts";
import { limparConversa } from "./chat.ts";
import * as avisos from "./push.ts";
import * as remedios from "./remedios.ts";
import * as fn from "./funcoes.ts";
import * as calendario from "./calendario-local.ts";

export async function apagarPessoa(uid: string) {
  await auth.desconectar(uid);
  limparConversa(uid, true);
  avisos.apagarTudo(uid);
  remedios.apagarTudo(uid);
  fn.apagarTudo(uid);
  calendario.apagarTudo(uid);
  esquecer(uid);
}
