// agenda-web: modo demonstração (AGENDA_DEMO=1), para mostrar a IAgenda a quem não foi convidado.
//
// "Experimentar sem conta" (GET /demo/entrar) cria um visitante sem Google, com uma agenda fictícia guardada aqui
// (calendario-local.ts), algumas contas, compromissos e remédios de exemplo. A página, o chat e os avisos funcionam
// como para quem entra com Google, mas nada sai deste servidor (o chat só usa a IA se houver chave, com limite
// próprio em chat.ts). Cada visitante dura AGENDA_DEMO_HORAS (padrão 24 h) e some ao sair.
// Pode rodar junto com o login do Google: convidados entram com Google, o resto experimenta a demonstração.
import * as auth from "./auth.ts";
import { type Sessao, criarEvento, marcarFeito, partesNoFuso, MIN } from "./agenda.ts";
import * as calendario from "./calendario-local.ts";
import * as remedios from "./remedios.ts";
import * as fn from "./funcoes.ts";
import { apagarPessoa } from "./apagar.ts";

export const DEMO = process.env.AGENDA_DEMO === "1";
export const HORAS = Number(process.env.AGENDA_DEMO_HORAS ?? 24);
const MAX = Number(process.env.AGENDA_DEMO_MAX ?? 500);   // visitantes ao mesmo tempo
const FUSO = "America/Sao_Paulo";                          // o mesmo de calendario-local (FUSO_PADRAO em agenda.ts)

export class ErroDemo extends Error {}

// Cria o visitante, semeia a agenda e devolve o valor do cookie da sessão.
export async function entrar(): Promise<string> {
  if (!DEMO) throw new ErroDemo("desligada");
  if (auth.contarVisitantes() >= MAX) throw new ErroDemo("lotada");
  const uid = auth.criarVisitante("Visitante");
  try { await semear(uid); }
  catch (e) { await apagarPessoa(uid); throw e; }
  return auth.abrirSessao(uid, HORAS * 3600_000);
}

// ---------- dados de exemplo (datas em volta de hoje, para a demonstração sempre parecer atual) ----------
const somar = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const ymd = (d: string) => d.replace(/-/g, "");

async function semear(uid: string) {
  const s: Sessao = { usuario: uid };
  const hoje = partesNoFuso(new Date().toISOString(), FUSO).data;
  const d = (n: number) => somar(hoje, n);
  const conta = (titulo: string, data: string, valor: number, categoria: string, repetir = "nao") =>
    criarEvento(s, { tipo: "conta", titulo, data, valor, categoria, repetir });
  const feito = (id: string) => marcarFeito(s, id, true);

  // Contas que se repetem: o aluguel do mês passado foi pago e o deste mês está atrasado.
  let ini = d(-33);
  if (Number(ini.slice(8)) > 28) ini = somar(ini, 28 - Number(ini.slice(8)));
  const aluguel = await conta("Aluguel", ini, 1500, "Moradia", "mensal");
  await feito(`${aluguel.id}_${ymd(ini)}`);
  const academia = await criarEvento(s, { titulo: "Academia", data: d(-14), diaInteiro: false, hora: "07:00", horaFim: "08:00", repetir: "semanal", local: "Academia do bairro" });
  for (const n of [-14, -7]) await feito(`${academia.id}_${ymd(d(n))}`);

  // Mês passado (pagas), para o gráfico por categoria ter com o que comparar.
  for (const [t, n, v, c] of [["Água", -30, 82.1, "Casa"], ["Luz", -27, 172.3, "Casa"], ["Fatura do cartão", -36, 760, "Cartão"], ["Plano de saúde", -25, 489.9, "Saúde"]] as const)
    await feito((await conta(t, d(n), v, c)).id);
  // Este mês: umas pagas, uma vencendo hoje e as próximas.
  for (const [t, n, v, c] of [["Condomínio", -12, 650, "Moradia"], ["Água", -8, 87.4, "Casa"], ["Plano de saúde", -6, 489.9, "Saúde"]] as const)
    await feito((await conta(t, d(n), v, c)).id);
  for (const [t, n, v, c] of [
    ["Internet", 0, 99.9, "Casa"], ["Mensalidade da academia", 1, 119.9, "Lazer"], ["Luz", 3, 180.5, "Casa"],
    ["Streaming de música", 4, 21.9, "Assinaturas"], ["IPTU (parcela)", 7, 145, "Impostos"],
    ["Fatura do cartão", 12, 820, "Cartão"], ["Curso de inglês", 15, 390, "Educação"],
  ] as const) await conta(t, d(n), v, c);

  // Compromissos.
  await feito((await criarEvento(s, { titulo: "Consulta de rotina", data: d(-2), diaInteiro: false, hora: "10:00", horaFim: "10:40", local: "Clínica Bem-Estar" })).id);
  await feito((await criarEvento(s, { titulo: "Levar o carro na revisão", data: d(-1) })).id);
  await criarEvento(s, { titulo: "Dentista", data: d(0), diaInteiro: false, hora: "15:00", horaFim: "16:00", local: "Clínica Sorriso, sala 12", descricao: "Levar a carteirinha do plano." });
  await criarEvento(s, { titulo: "Entregar o relatório do trimestre", data: d(1) });
  await criarEvento(s, { titulo: "Reunião de pais na escola", data: d(2), diaInteiro: false, hora: "18:30", horaFim: "19:30" });
  await criarEvento(s, { titulo: "Jantar com a Ana", data: d(5), diaInteiro: false, hora: "20:00", horaFim: "22:00", local: "Cantina da esquina" });
  await criarEvento(s, { titulo: "Viagem para a praia", data: d(6), dataFim: d(8) });
  await criarEvento(s, { titulo: "Aniversário do Pedro", data: d(9), repetir: "anual" });
  // Um convite de outra pessoa (só ela muda; aqui dá para marcar como feito).
  calendario.semear(uid, {
    summary: "Reunião de planejamento", location: "Sala 3",
    start: { dateTime: `${d(3)}T09:30:00`, timeZone: FUSO }, end: { dateTime: `${d(3)}T10:30:00`, timeZone: FUSO },
    organizer: { email: "marina@empresa.exemplo", displayName: "Marina Souza" },
    attendees: [{ self: true, responseStatus: "accepted" }, { email: "marina@empresa.exemplo", responseStatus: "accepted" }],
  }, FUSO);

  // Remédios (ligados na demonstração), com a última semana de check-in e duas doses esquecidas.
  fn.mudar(uid, { remedios: true });
  const inicio = d(-10);
  // Estoque contado antes da semana de doses: a vitamina sobra, a Losartana fica para poucos dias (aviso de comprar).
  const validade = somar(hoje, 400).slice(0, 7);
  const vitamina = remedios.cadastrar(uid, hoje, { nome: "Vitamina D 2.000 UI", unidade: "cápsula", dose: 1, horarios: ["manha"], porCaixa: 30, estoque: 30, inicio,
    caixa: { principio: "Colecalciferol", concentracao: "2.000 UI", forma: "cápsula mole", apresentacao: "frasco com 30 cápsulas", laboratorio: "Laboratório Exemplo", validade } });
  const pressao = remedios.cadastrar(uid, hoje, { nome: "Losartana 50 mg", unidade: "comprimido", dose: 1, horarios: ["manha", "noite"], porCaixa: 30, estoque: 24, inicio,
    caixa: { principio: "Losartana potássica", concentracao: "50 mg", forma: "comprimido revestido", apresentacao: "caixa com 30 comprimidos", laboratorio: "Laboratório Exemplo", validade, tarja: "vermelha", receita: "sob prescrição" } });
  for (let n = -7; n <= 0; n++) {
    remedios.marcarDose(uid, hoje, { remedio: vitamina.id, dia: d(n), horario: "manha", tomado: true });
    remedios.marcarDose(uid, hoje, { remedio: pressao.id, dia: d(n), horario: "manha", tomado: true });
    if (n < 0 && n !== -5 && n !== -2) remedios.marcarDose(uid, hoje, { remedio: pressao.id, dia: d(n), horario: "noite", tomado: true });
  }
}

// ---------- limpeza ----------
async function limpar() {
  for (const uid of auth.visitantesAntigos(Date.now() - HORAS * 3600_000)) {
    try { await apagarPessoa(uid); } catch (e) { console.error("demo (limpar):", (e as Error).message); }
  }
}
if (DEMO) {
  setTimeout(() => { limpar(); }, 5_000).unref();
  setInterval(() => { limpar(); }, 30 * MIN).unref();
}
