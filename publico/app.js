// IAgenda (página). Os eventos vêm de /app/eventos (agenda Google da pessoa); nada fica guardado aqui.
// Todo texto que vem do Google entra por textContent: título e descrição de convite podem vir de qualquer um.
'use strict';

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DOW = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
const DOW_LONGO = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const ERROS = {
  convite: 'Esse Gmail ainda não foi convidado. Peça a quem cuida desta IAgenda para liberar o seu e-mail.',
  agenda: 'Sem a permissão da agenda não dá para continuar. Entre de novo e deixe marcada a caixa da Google Agenda.',
  conta: 'Esse e-mail já é usado em outra conta daqui. Entre com outro Gmail.',
  expirou: 'O login demorou demais. É só entrar de novo.',
  cancelado: 'O login foi cancelado. Quando quiser, é só entrar de novo.',
  configuracao: 'O login ainda não está pronto. Tente de novo mais tarde.',
  falhou: 'Não deu certo agora. Tente de novo em um minuto.',
  encerrado: 'O seu acesso foi encerrado. Fale com quem cuida desta IAgenda se isso for engano.',
  saiu: 'Você saiu. Até a próxima!',
  desconectado: 'Pronto: a IAgenda não tem mais acesso à sua agenda Google.',
  'demo-saiu': 'Pronto: a sua demonstração foi apagada. Volte quando quiser.',
  'demo-lotada': 'A demonstração está cheia agora. Tente de novo mais tarde.',
  'demo-desligada': 'A demonstração não está ligada aqui.',
  devagar: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.',
};
let ehDemo = false;

const $ = (id) => document.getElementById(id);
function el(tag, cls, texto) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (texto != null) e.textContent = texto;
  return e;
}
const pad = (n) => String(n).padStart(2, '0');
const chave = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const deChave = (k) => { const [a, m, d] = k.split('-').map(Number); return new Date(a, m - 1, d); };
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const hoje0 = new Date();
let ano = hoje0.getFullYear();
let mes = hoje0.getMonth();
let sel = chave(hoje0);
let eventos = [];
let porDia = new Map();
let ultimaCarga = 0;
let contasProx = [];   // contas de 60 dias atrás a 60 dias à frente (para "a pagar")
let visContas = 'pagar';
const CATEGORIAS = ['Moradia', 'Casa', 'Cartão', 'Transporte', 'Saúde', 'Educação', 'Assinaturas', 'Impostos', 'Lazer', 'Outros'];
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dinheiro = (v) => brl.format(v || 0);
let carregandoN = 0;

// ---------- API ----------
class ErroApi extends Error {
  constructor(status, codigo, mensagem) { super(mensagem || codigo); this.status = status; this.codigo = codigo; }
}
async function api(metodo, caminho, corpo) {
  let r;
  try {
    r = await fetch(caminho, {
      method: metodo,
      credentials: 'same-origin',
      headers: { 'X-Agenda': '1', ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new ErroApi(0, 'rede', 'Sem internet agora. Tente de novo.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const e = new ErroApi(r.status, j.erro || 'falhou', j.mensagem);
  if (e.codigo === 'sessao') { mostrarEntrar(); throw e; }
  if (e.codigo === 'convite') { mostrarEntrar('encerrado'); throw e; }
  if (e.codigo === 'reconectar') { pedirReconectar(); throw e; }
  throw e;
}
function mensagem(e) {
  if (e.codigo === 'google') return e.message !== 'google' ? e.message : 'O Google não respondeu agora. Tente de novo.';
  if (e.codigo === 'contas') return 'O servidor de login não respondeu agora. Tente de novo.';
  if (e.codigo === 'devagar') return 'Muitos pedidos seguidos. Espere um minuto.';
  if (e.codigo === 'rede') return e.message;
  return e.message && e.message !== e.codigo ? e.message : 'Não deu certo agora. Tente de novo.';
}

// ---------- telas ----------
function mostrarEntrar(codErro) {
  $('telaAgenda').hidden = true;
  $('chatBtn').hidden = true;
  $('chat').hidden = true;
  $('telaEntrar').hidden = false;
  const p = $('entrarErro');
  p.hidden = !codErro;
  p.textContent = codErro ? (ERROS[codErro] || ERROS.falhou) : '';
  p.className = 'alert ' + (['saiu', 'desconectado', 'demo-saiu'].includes(codErro) ? 'amber' : 'red');
  prepararEntrar();
}
// O que a tela de entrar oferece: Google (se o login estiver configurado) e/ou a demonstração.
async function prepararEntrar() {
  let m = { google: true, demo: false };
  try { const r = await fetch('/modo'); if (r.ok) m = await r.json(); } catch { /* fica o Google */ }
  $('entrarBtn').hidden = !m.google && m.demo;
  $('entrarNota').hidden = $('entrarBtn').hidden;
  $('demoForm').hidden = !m.demo;
  $('demoNota').hidden = !m.demo;
  if (m.demoHoras) $('demoHoras').textContent = m.demoHoras;
}
function pedirReconectar() {
  const a = $('aviso');
  a.replaceChildren('O Google pediu para você entrar de novo. ', Object.assign(el('a', null, 'Entrar com Google'), { href: '/auth/google/start?consentir=true' }));
  a.hidden = false;
}
function avisar(texto) {
  const a = $('aviso');
  a.textContent = texto;
  a.hidden = !texto;
  clearTimeout(avisar.t);
  if (texto) avisar.t = setTimeout(() => { a.hidden = true; }, 8000);
}

async function iniciar() {
  const h = new URLSearchParams(location.hash.slice(1));
  const diaPedido = h.get('dia');
  if (h.has('erro') || h.has('dia') || h.has('remedios')) history.replaceState(null, '', location.pathname);
  if (h.get('erro')) return mostrarEntrar(h.get('erro'));
  let eu;
  try { eu = await api('GET', '/app/eu'); }
  catch (e) { if (e.codigo !== 'sessao' && e.codigo !== 'convite') mostrarEntrar('falhou'); return; }
  $('euNome').textContent = eu.nome || 'Você';
  $('euEmail').textContent = eu.email;
  ehDemo = eu.demo === true;
  if (ehDemo) {
    $('euEmail').textContent = 'demonstração';
    $('demoFaixa').textContent = `Demonstração: tudo aqui é fictício e some em ${eu.demoHoras || 24} horas. Nada vai para o Google. Mexa à vontade, inclusive pelo chat.`;
    $('sairNome').textContent = 'Sair e apagar a demonstração';
  }
  $('demoFaixa').hidden = !ehDemo;
  $('desconectarBtn').hidden = ehDemo;
  $('inicial').textContent = (eu.nome || eu.email || '?').trim().charAt(0).toUpperCase();
  $('telaEntrar').hidden = true;
  $('telaAgenda').hidden = false;
  chatLigado = eu.chat !== false;
  audioLigado = eu.audio === true;
  botoesChat();
  if (eu.funcoes) funcoes = eu.funcoes;
  aplicarFuncoes();
  $('chatBtn').hidden = false;
  montarDows();
  if (/^\d{4}-\d{2}-\d{2}$/.test(diaPedido || '')) { sel = diaPedido; const d = deChave(sel); ano = d.getFullYear(); mes = d.getMonth(); }
  desenhar();
  carregar();
  carregarRemedios();
  if (h.has('remedios') && funcoes.remedios) setTimeout(() => $('cardRemedios').scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  prepararAvisos();
  prepararMidia();
}

// ---------- eventos ----------
function inicioGrade() { return new Date(ano, mes, 1 - new Date(ano, mes, 1).getDay()); }
function semanas() { return Math.ceil((new Date(ano, mes, 1).getDay() + new Date(ano, mes + 1, 0).getDate()) / 7); }

async function carregar() {
  const de = inicioGrade();
  const ate = new Date(de.getFullYear(), de.getMonth(), de.getDate() + semanas() * 7);
  const pedido = `${ano}-${mes}`;
  carregandoN++;
  $('carregando').hidden = false;
  try {
    const r = await api('GET', `/app/eventos?de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`);
    if (pedido !== `${ano}-${mes}`) return;
    eventos = r.eventos;
    ultimaCarga = Date.now();
    indexar();
    desenhar();
    carregarContas();
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
  } finally {
    if (--carregandoN === 0) $('carregando').hidden = true;
  }
}

// Em que dias (locais) cada evento aparece.
function diasDo(ev) {
  const dias = [];
  let a, b;
  if (ev.diaInteiro) {
    a = deChave(ev.inicio);
    b = deChave(ev.fim || ev.inicio);
    b.setDate(b.getDate() - 1);
  } else {
    a = new Date(ev.inicio);
    b = new Date(new Date(ev.fim || ev.inicio).getTime() - 1);
    if (b < a) b = a;
    a = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    b = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  }
  for (let d = new Date(a), n = 0; d <= b && n < 62; d.setDate(d.getDate() + 1), n++) dias.push(chave(d));
  return dias.length ? dias : [chave(a)];
}
function indexar() {
  porDia = new Map();
  for (const ev of eventos) for (const k of diasDo(ev)) {
    if (!porDia.has(k)) porDia.set(k, []);
    porDia.get(k).push(ev);
  }
  for (const lista of porDia.values()) lista.sort((x, y) => (x.diaInteiro === y.diaInteiro ? (x.inicio < y.inicio ? -1 : 1) : x.diaInteiro ? -1 : 1));
}
function quando(ev, k) {
  if (ev.diaInteiro) {
    const a = deChave(ev.inicio), b = deChave(ev.fim); b.setDate(b.getDate() - 1);
    return chave(a) === chave(b) ? 'o dia todo' : `de ${a.getDate()}/${a.getMonth() + 1} a ${b.getDate()}/${b.getMonth() + 1}`;
  }
  const a = new Date(ev.inicio), b = new Date(ev.fim);
  if (chave(a) === chave(b)) return `${hhmm(a)} às ${hhmm(b)}`;
  return `${a.getDate()}/${a.getMonth() + 1} ${hhmm(a)} a ${b.getDate()}/${b.getMonth() + 1} ${hhmm(b)}`;
}

// ---------- desenho ----------
function montarDows() {
  $('dows').replaceChildren(...DOW.map((d) => el('div', 'dow', d)));
}
function desenhar() {
  $('mesNome').textContent = `${MESES[mes]} ${ano}`;
  const grade = $('grade');
  const hoje = chave(new Date());
  const ini = inicioGrade();
  const dias = [];
  for (let i = 0; i < semanas() * 7; i++) {
    const d = new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() + i);
    const k = chave(d);
    const c = el('div', 'day');
    c.tabIndex = 0;
    c.dataset.k = k;
    if (d.getMonth() !== mes) c.classList.add('out');
    if (d.getDay() === 0 || d.getDay() === 6) c.classList.add('weekend');
    if (k === hoje) c.classList.add('today');
    if (k === sel) c.classList.add('sel');
    c.setAttribute('role', 'button');
    const lista = porDia.get(k) || [];
    c.setAttribute('aria-label', `${d.getDate()} de ${MESES[d.getMonth()]}, ${lista.length ? lista.length + ' evento(s)' : 'livre'}`);
    const num = el('div', 'num');
    num.append(el('b', null, String(d.getDate())));
    c.append(num);
    const max = window.matchMedia('(max-width: 640px)').matches ? 2 : 3;
    for (const ev of lista.slice(0, max)) {
      const chip = el('span', 'chip' + (ev.tipo === 'conta' ? ' conta' : ev.diaInteiro ? '' : ' solid') + (ev.feito ? ' done' : ''));
      if (!ev.diaInteiro && chave(new Date(ev.inicio)) === k) chip.append(el('span', 'h', hhmm(new Date(ev.inicio))));
      chip.append(ev.titulo);
      chip.title = ev.titulo;
      c.append(chip);
    }
    if (lista.length > max) c.append(el('span', 'more', `+${lista.length - max}`));
    dias.push(c);
  }
  grade.replaceChildren(...dias);
  desenharDia();
  desenharContasMes();
  desenharCardContas();
}

function desenharDia() {
  const d = deChave(sel);
  $('diaTitulo').textContent = `${DOW_LONGO[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]}`;
  const lista = porDia.get(sel) || [];
  const box = $('diaLista');
  if (!lista.length) { box.replaceChildren(el('p', 'vazio', 'Nada neste dia.')); return; }
  box.replaceChildren(...lista.map((ev) => {
    const linha = el('div', 'ev' + (ev.feito ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = ev.feito;
    const rot = ev.tipo === 'conta' ? (ev.feito ? 'Desmarcar paga' : 'Marcar como paga') : (ev.feito ? 'Desmarcar feito' : 'Marcar como feito');
    cb.setAttribute('aria-label', rot);
    cb.addEventListener('change', () => marcar(ev, cb.checked, cb));
    const corpo = el('div');
    corpo.append(el('h3', null, ev.titulo), el('span', 'quando', ev.tipo === 'conta'
      ? `conta · ${ev.categoria} · ${dinheiro(ev.valor)}${ev.feito ? ' · paga' : ''}` : quando(ev, sel)));
    if (ev.organizador) corpo.append(el('span', 'det', `Convite de ${ev.organizador}`));
    if (ev.local) corpo.append(el('span', 'det', ev.local));
    if (ev.descricao) corpo.append(el('span', 'det', ev.descricao.length > 280 ? ev.descricao.slice(0, 280) + '…' : ev.descricao));
    const acoes = el('div', 'acoes');
    if (ev.podeEditar) {
      const b = el('button', null, 'Editar');
      b.type = 'button';
      b.addEventListener('click', () => abrirEvento(ev));
      acoes.append(b);
    }
    const ap = el('button', 'perigo', ev.organizador ? 'Tirar da agenda' : 'Apagar');
    ap.type = 'button';
    ap.addEventListener('click', () => abrirApagar(ev));
    acoes.append(ap);
    linha.append(cb, corpo, acoes);
    return linha;
  }));
}

// ---------- ações ----------
function trocarEvento(antigo, novo) {
  const i = eventos.findIndex((e) => e.id === antigo.id);
  if (i >= 0) eventos[i] = novo;
  const j = contasProx.findIndex((e) => e.id === antigo.id);
  if (j >= 0) contasProx[j] = novo;
  indexar();
  desenhar();
}
async function marcar(ev, feito, cb) {
  try {
    const r = await api('POST', `/app/eventos/${encodeURIComponent(ev.id)}/feito`, { feito });
    trocarEvento(ev, r.evento);
  } catch (e) {
    if (cb) cb.checked = !feito;
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
  }
}

let editando = null;
function abrirEvento(ev, dia, tipo) {
  editando = ev || null;
  const f = $('formEvento');
  f.reset();
  if (!f.categoria.options.length) for (const c of CATEGORIAS) f.categoria.append(new Option(c, c));
  f.tipo.value = ev ? ev.tipo : (tipo || (funcoes.compromissos ? 'evento' : 'conta'));
  if (ev && ev.tipo === 'conta') {
    f.valor.value = String(ev.valor ?? '').replace('.', ',');
    f.categoria.value = ev.categoria || 'Outros';
  } else f.categoria.value = 'Casa';
  if (!ev && f.tipo.value === 'conta') f.repetir.value = 'mensal';
  $('dlgErro').hidden = true;
  $('dlgTitulo').textContent = ev ? 'Editar' : 'Novo';
  $('repetirLin').hidden = !!ev;
  $('todasLin').hidden = !(ev && ev.serie);
  $('dlgNota').hidden = !!ev;
  if (ev) {
    f.titulo.value = ev.titulo;
    f.local.value = ev.local;
    f.descricao.value = ev.descricao;
    f.diaInteiro.checked = ev.diaInteiro;
    if (ev.diaInteiro) {
      const b = deChave(ev.fim); b.setDate(b.getDate() - 1);
      f.data.value = ev.inicio;
      f.dataFim.value = chave(b) !== ev.inicio ? chave(b) : '';
    } else {
      const a = new Date(ev.inicio), b = new Date(ev.fim);
      f.data.value = chave(a);
      f.dataFim.value = chave(b) !== chave(a) ? chave(b) : '';
      f.hora.value = hhmm(a);
      f.horaFim.value = hhmm(b);
    }
  } else {
    f.data.value = dia || sel;
  }
  ajustarForm();
  $('dlgEvento').showModal();
  f.titulo.focus();
}
function ajustarForm() {
  const f = $('formEvento');
  const todas = f.todas.checked && !$('todasLin').hidden;
  const conta = f.tipo.value === 'conta';
  $('contaCampos').hidden = !conta;
  f.valor.required = conta;
  $('diaTodoLin').hidden = conta;
  $('dataFimLin').hidden = conta;
  $('rotuloData').textContent = conta ? 'Vence' : 'Dia';
  f.titulo.placeholder = conta ? 'Ex.: conta de luz' : 'Ex.: dentista';
  $('horas').hidden = conta || f.diaInteiro.checked;
  f.hora.required = !conta && !f.diaInteiro.checked && !todas;
  for (const n of ['data', 'dataFim', 'hora', 'horaFim', 'diaInteiro']) f[n].disabled = todas;
}
async function salvarEvento(evt) {
  evt.preventDefault();
  const f = $('formEvento');
  const corpo = {
    titulo: f.titulo.value.trim(),
    data: f.data.value,
    dataFim: f.dataFim.value || undefined,
    diaInteiro: f.diaInteiro.checked,
    hora: f.hora.value || undefined,
    horaFim: f.horaFim.value || undefined,
    local: f.local.value.trim(),
    descricao: f.descricao.value.trim(),
    tipo: f.tipo.value,
  };
  if (corpo.tipo === 'conta') { corpo.valor = f.valor.value.trim(); corpo.categoria = f.categoria.value; corpo.diaInteiro = true; corpo.dataFim = undefined; }
  if (!editando) corpo.repetir = f.repetir.value;
  if (editando && editando.serie && f.todas.checked) corpo.todas = true;
  const botao = $('dlgSalvar');
  botao.disabled = true;
  try {
    if (editando) {
      await api('PATCH', `/app/eventos/${encodeURIComponent(editando.id)}`, corpo);
    } else {
      await api('POST', '/app/eventos', corpo);
    }
    $('dlgEvento').close();
    sel = corpo.data && !corpo.todas ? corpo.data : sel;
    const d = deChave(sel);
    if (d.getFullYear() !== ano || d.getMonth() !== mes) { ano = d.getFullYear(); mes = d.getMonth(); }
    // A série inteira (ou um evento que se repete) muda em vários dias: busca de novo.
    await carregar();
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) {
      $('dlgErro').textContent = mensagem(e);
      $('dlgErro').hidden = false;
    } else $('dlgEvento').close();
  } finally {
    botao.disabled = false;
  }
}

let apagando = null;
function abrirApagar(ev) {
  apagando = ev;
  $('apagarErro').hidden = true;
  $('apagarQual').textContent = `${ev.titulo} (${quando(ev, sel)})`;
  $('apagarTodas').hidden = !ev.serie;
  $('apagarUm').textContent = ev.serie ? 'Só esta' : (ev.organizador ? 'Tirar' : 'Apagar');
  $('apagarNota').textContent = ev.organizador
    ? `É um convite de ${ev.organizador}: sai só da sua agenda.`
    : ev.serie ? 'Esse evento se repete. Apagar só esta vez ou todas?' : 'Some também do seu app Google Agenda.';
  $('dlgApagar').showModal();
}
async function apagar(todas) {
  const ev = apagando;
  if (!ev) return;
  for (const b of [$('apagarUm'), $('apagarTodas')]) b.disabled = true;
  try {
    await api('DELETE', `/app/eventos/${encodeURIComponent(ev.id)}${todas ? '?todas=1' : ''}`);
    $('dlgApagar').close();
    if (todas) await carregar();
    else { eventos = eventos.filter((e) => e.id !== ev.id); contasProx = contasProx.filter((e) => e.id !== ev.id); indexar(); desenhar(); }
  } catch (e) {
    if (e.codigo === 'sumiu') { $('dlgApagar').close(); await carregar(); return; }
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) {
      $('apagarErro').textContent = mensagem(e);
      $('apagarErro').hidden = false;
    } else $('dlgApagar').close();
  } finally {
    for (const b of [$('apagarUm'), $('apagarTodas')]) b.disabled = false;
  }
}

function irPara(a, m) {
  const d = new Date(a, m, 1);
  ano = d.getFullYear();
  mes = d.getMonth();
  eventos = [];
  porDia = new Map();
  desenhar();
  carregar();
}


// ---------- contas a pagar ----------
// Conta = evento de dia inteiro com valor e categoria; "paga" é o mesmo "feito".
async function carregarContas() {
  const h = new Date();
  const de = new Date(h.getFullYear(), h.getMonth(), h.getDate() - 60);
  const ate = new Date(h.getFullYear(), h.getMonth(), h.getDate() + 61);
  try {
    const r = await api('GET', `/app/contas?de=${encodeURIComponent(de.toISOString())}&ate=${encodeURIComponent(ate.toISOString())}`);
    contasProx = r.contas;
    desenharCardContas();
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
  }
}
const contasDoMes = () => eventos
  .filter((e) => e.tipo === 'conta' && deChave(e.inicio).getMonth() === mes && deChave(e.inicio).getFullYear() === ano)
  .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : a.titulo.localeCompare(b.titulo)));
const ddmm = (k) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;
function checkPaga(ev) {
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = ev.feito;
  cb.setAttribute('aria-label', `${ev.feito ? 'Desmarcar' : 'Marcar'} ${ev.titulo} como paga`);
  cb.addEventListener('change', () => marcar(ev, cb.checked, cb));
  return cb;
}

// Embaixo da agenda: as contas do mês mostrado, com os totais.
function desenharContasMes() {
  $('contasMesTit').textContent = `Contas de ${MESES[mes]}`;
  const box = $('contasMes');
  const lista = contasDoMes();
  if (!lista.length) {
    box.replaceChildren(el('p', 'vazio', 'Nenhuma conta neste mês. Crie em "+ Nova conta" ou peça no chat ("luz de 180 reais vence dia 10").'));
    return;
  }
  const hoje = chave(new Date());
  const tab = el('table');
  const cab = el('thead');
  const tr0 = el('tr');
  for (const [t, c] of [['Vence', ''], ['Conta', ''], ['Categoria', 'cat-col'], ['Valor', 'num-col'], ['Paga', '']]) tr0.append(el('th', c, t));
  cab.append(tr0);
  const corpo = el('tbody');
  let pago = 0, apagar = 0;
  for (const ev of lista) {
    if (ev.feito) pago += ev.valor || 0; else apagar += ev.valor || 0;
    const tr = el('tr', (ev.feito ? 'paga' : '') + (!ev.feito && ev.inicio < hoje ? ' atrasada' : ''));
    const nome = el('td', 'nome');
    const b = el('button', null, ev.titulo);
    b.type = 'button';
    b.title = 'Ver no dia';
    b.addEventListener('click', () => { sel = ev.inicio; desenhar(); });
    nome.append(b);
    const tdCb = el('td');
    tdCb.append(checkPaga(ev));
    tr.append(el('td', 'vence valor', ddmm(ev.inicio)), nome, el('td', 'cat-col', ev.categoria), el('td', 'num-col valor', dinheiro(ev.valor)), tdCb);
    corpo.append(tr);
  }
  tab.append(cab, corpo);
  const tot = el('div', 'totais');
  const item = (rot, v) => { const s = el('span', null, rot + ' '); s.append(el('strong', 'valor', dinheiro(v))); return s; };
  tot.append(item('A pagar', apagar), item('Pago', pago), item('Total', pago + apagar));
  box.replaceChildren(tab, tot);
}

// Ao lado: "A pagar" (da mais próxima à mais distante, atrasadas primeiro) ou "Por categoria" (o mês mostrado).
function desenharCardContas() {
  $('abaPagar').setAttribute('aria-selected', String(visContas === 'pagar'));
  $('abaCategoria').setAttribute('aria-selected', String(visContas === 'categoria'));
  $('abaPagar').setAttribute('aria-pressed', String(visContas === 'pagar'));
  $('abaCategoria').setAttribute('aria-pressed', String(visContas === 'categoria'));
  $('painelPagar').hidden = visContas !== 'pagar';
  $('painelCategoria').hidden = visContas !== 'categoria';
  if (visContas === 'pagar') desenharAPagar(); else desenharCategorias();
}
function desenharAPagar() {
  const box = $('painelPagar');
  const hoje = chave(new Date());
  const amanha = chave(new Date(Date.now() + 86400000));
  // Só o mês atual; nos últimos 7 dias do mês, também o seguinte. Atrasada de mês anterior continua (ainda está a pagar).
  const agora = new Date();
  const ultimoDia = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
  const fimDoMes = ultimoDia - agora.getDate() < 7;
  const esteMes = hoje.slice(0, 7);
  const proximoMes = chave(new Date(agora.getFullYear(), agora.getMonth() + 1, 1)).slice(0, 7);
  const lista = contasProx
    .filter((e) => !e.feito && (e.inicio < hoje || e.inicio.slice(0, 7) === esteMes || (fimDoMes && e.inicio.slice(0, 7) === proximoMes)))
    .sort((a, b) => (a.inicio < b.inicio ? -1 : a.inicio > b.inicio ? 1 : 0));
  if (!lista.length) {
    box.replaceChildren(el('p', 'vazio', fimDoMes ? 'Nenhuma conta a pagar até o fim do mês que vem.' : 'Nenhuma conta a pagar neste mês.'));
    return;
  }
  // Separada por mês: a mesma conta de meses seguidos (luz de novembro e de dezembro) não parece repetida.
  const mostrar = lista.slice(0, 12);
  const porMes = new Map();
  for (const ev of mostrar) {
    const m = ev.inicio.slice(0, 7);
    porMes.set(m, (porMes.get(m) || 0) + (ev.valor || 0));
  }
  let mesAtual = '';
  const linhas = [];
  for (const ev of mostrar) {
    const m = ev.inicio.slice(0, 7);
    if (m !== mesAtual) {
      mesAtual = m;
      const nomeMes = MESES[Number(m.slice(5, 7)) - 1];
      const cab = el('div', 'cp-mes', nomeMes.replace(/^./, (c) => c.toUpperCase()) + (m.slice(0, 4) !== String(new Date().getFullYear()) ? ' ' + m.slice(0, 4) : '') + ' · ');
      cab.append(el('span', 'valor', dinheiro(porMes.get(m))));
      linhas.push(cab);
    }
    linhas.push(linhaAPagar(ev, hoje, amanha));
  }
  function linhaAPagar(ev, hoje, amanha) {
    const l = el('div', 'cp');
    const estado = ev.inicio < hoje ? ['atrasada', 'atrasada'] : ev.inicio === hoje ? ['hoje', 'vence hoje'] : ev.inicio === amanha ? ['hoje', 'vence amanhã'] : null;
    l.append(el('span', 'dt', ddmm(ev.inicio)), el('span', 'nm', ev.titulo), el('span', 'valor', dinheiro(ev.valor)), checkPaga(ev));
    l.append(el('span', 'tag' + (estado ? ' ' + estado[0] : ''), estado ? `${estado[1]} · ${ev.categoria}` : ev.categoria));
    return l;
  }
  const total = lista.reduce((t, e) => t + (e.valor || 0), 0);
  const fim = el('div', 'totais');
  const s = el('span', null, `${lista.length} a pagar · `);
  s.append(el('strong', 'valor', dinheiro(total)));
  fim.append(s);
  if (lista.length > 12) fim.append(el('span', null, '(mostrando as 12 primeiras)'));
  box.replaceChildren(...linhas, fim);
}
function desenharCategorias() {
  const box = $('painelCategoria');
  const lista = contasDoMes();
  if (!lista.length) { box.replaceChildren(el('p', 'vazio', `Nenhuma conta em ${MESES[mes]}.`)); return; }
  const por = new Map();
  for (const ev of lista) {
    const c = por.get(ev.categoria) || { pago: 0, apagar: 0 };
    if (ev.feito) c.pago += ev.valor || 0; else c.apagar += ev.valor || 0;
    por.set(ev.categoria, c);
  }
  const linhas = [...por.entries()].map(([cat, v]) => ({ cat, ...v, total: v.pago + v.apagar })).sort((a, b) => b.total - a.total);
  const maior = Math.max(...linhas.map((l) => l.total));
  const total = linhas.reduce((t, l) => t + l.total, 0);
  const tit = el('p', 'total-mes', `${MESES[mes].replace(/^./, (c) => c.toUpperCase())}: `);
  tit.append(el('strong', 'valor', dinheiro(total)));
  const leg = el('div', 'leg');
  leg.append(el('span', 'k-apagar', 'A pagar'), el('span', 'k-pago', 'Pago'));
  const barras = el('div', 'barras');
  for (const l of linhas) {
    const lin = el('div', 'barra-lin');
    const cab = el('div', 'barra-cab');
    const val = el('span', 'valor');
    val.append(el('strong', null, dinheiro(l.total)));
    if (l.apagar && l.pago) val.append(` · ${dinheiro(l.apagar)} a pagar`);
    else if (l.pago && !l.apagar) val.append(' · pago');
    cab.append(el('span', null, l.cat), val);
    const trilho = el('div', 'trilho');
    trilho.setAttribute('role', 'img');
    trilho.setAttribute('aria-label', `${l.cat}: ${dinheiro(l.total)}, ${dinheiro(l.pago)} pago e ${dinheiro(l.apagar)} a pagar`);
    // Largura proporcional à maior categoria; a parte paga vem primeiro, a pagar no fim da barra.
    for (const [cls, v, rot] of [['s-pago', l.pago, 'pago'], ['s-apagar', l.apagar, 'a pagar']]) {
      if (!v) continue;
      const seg = el('span', cls);
      seg.style.width = `calc(${(v / maior) * 100}% - 2px)`;
      seg.title = `${l.cat}: ${dinheiro(v)} ${rot}`;
      trilho.append(seg);
    }
    lin.append(cab, trilho);
    barras.append(lin);
  }
  box.replaceChildren(tit, leg, barras);
}

// ---------- remédios ----------
// Dado de saúde: vem de /app/remedios (SQLite do servidor, por pessoa), nunca vai para a agenda Google.
const CAMPOS_CAIXA = {
  principio: 'Princípio ativo', concentracao: 'Concentração', forma: 'Forma', apresentacao: 'Apresentação',
  laboratorio: 'Laboratório', lote: 'Lote', fabricacao: 'Fabricação', validade: 'Validade', registro: 'Registro MS',
  tarja: 'Tarja', receita: 'Receita', generico: 'Genérico', uso: 'Uso', conservacao: 'Conservação',
};
const PERIODO = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };
const nomeHorario = (h) => PERIODO[h] || h;
const num = (n) => String(n).replace('.', ',');
// '2 gota' -> '2 gotas'; ml e o que já termina em s ficam iguais.
const unid = (n, u) => `${num(n)} ${n > 1 && !/(s|ml)$/i.test(u) ? u.replace(/ão$/, 'ões') + (/ões$/.test(u.replace(/ão$/, 'ões')) ? '' : 's') : u}`;
let rem = { hoje: null, remedios: [], doses: [] };

// ---------- funções (menu do perfil) ----------
// Desligada, a função some da agenda e da tela (o servidor também deixa de mandar os eventos dela, e o chat e os
// avisos a ignoram). Padrão: compromissos e contas ligados, remédios desligado.
let funcoes = { compromissos: true, contas: true, remedios: false };
function aplicarFuncoes() {
  for (const b of document.querySelectorAll('.funcao')) b.setAttribute('aria-checked', String(Boolean(funcoes[b.dataset.funcao])));
  const agenda = funcoes.compromissos || funcoes.contas;
  $('cardRemedios').hidden = !funcoes.remedios;
  document.querySelector('.contas-mes').hidden = !funcoes.contas;
  $('cardContas').hidden = !funcoes.contas;
  $('novoBtn').hidden = $('novoNoDia').hidden = !agenda;
  $('tipoEventoLin').hidden = !funcoes.compromissos;
  $('tipoContaLin').hidden = !funcoes.contas;
  document.querySelector('.tipo-seg').hidden = !(funcoes.compromissos && funcoes.contas);
  $('chatTexto').placeholder =funcoes.contas ? 'Ex.: luz de 180 reais vence dia 10' : funcoes.compromissos ? 'Ex.: dentista sexta às 15h' : funcoes.remedios ? 'Ex.: tomei os remédios da manhã' : 'Escreva aqui';
}
async function alternarFuncao(k) {
  const antes = { ...funcoes };
  funcoes = { ...funcoes, [k]: !funcoes[k] };
  aplicarFuncoes();
  try {
    funcoes = (await api('POST', '/app/funcoes', { [k]: funcoes[k] })).funcoes;
  } catch (e) {
    funcoes = antes;
    aplicarFuncoes();
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
    return;
  }
  aplicarFuncoes();
  if (k === 'remedios') { if (funcoes.remedios) carregarRemedios(); }
  else carregar();
}

async function carregarRemedios() {
  if (!funcoes.remedios) return;
  try {
    rem = await api('GET', '/app/remedios');
    desenharRemedios();
    if ($('dlgRemLista').open) desenharRemLista();
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
  }
}

function estoqueTexto(r) {
  if (r.estoque === null) return 'estoque não informado';
  const un = unid(r.estoque, r.unidade);
  const cx = r.caixas !== null ? ` (≈ ${num(r.caixas)} cx)` : '';
  if (!r.ativo || r.dias === null) return un + cx;
  const ate = r.dias === 0 ? 'acaba hoje' : `dá até ${ddmm(r.acabaEm)}${r.dias <= 7 ? ` (${r.dias} ${r.dias === 1 ? 'dia' : 'dias'})` : ''}`;
  return `${un}${cx} · ${ate}`;
}

function desenharRemedios() {
  $('cardRemedios').hidden = !funcoes.remedios;
  const ativos = rem.remedios.filter((r) => r.ativo);
  // Alertas: acabando (7 dias ou menos), caixa vencida ou vencendo, sem foto da caixa.
  const alertas = [];
  for (const r of ativos) {
    if (r.dias !== null && r.dias <= 7) alertas.push(['red', `${r.nome}: ${r.dias === 0 ? 'acaba hoje' : `dá para ${r.dias} ${r.dias === 1 ? 'dia' : 'dias'}`}. Hora de comprar.`, r, 'compra']);
    if (r.vencido) alertas.push(['red', `${r.nome}: a caixa está vencida (${r.caixa.validade}).`, r, null]);
    else if (r.venceLogo) alertas.push(['amber', `${r.nome}: a caixa vence em ${r.caixa.validade}.`, r, null]);
    if (!r.temCaixa) alertas.push(['amber', `${r.nome}: falta a foto da caixa.`, r, 'foto']);
  }
  $('remAlertas').replaceChildren(...alertas.slice(0, 4).map(([cor, texto, r, acao]) => {
    const p = el('p', `alert ${cor} rem-alerta`, texto);
    if (acao) {
      const b = el('button', 'linkbtn', acao === 'compra' ? 'Comprei' : 'Mandar foto');
      b.type = 'button';
      b.addEventListener('click', () => (acao === 'compra' ? abrirRemEstoque(r, 'compra') : abrirRemedio(r, true)));
      p.append(' ', b);
    }
    return p;
  }));
  const box = $('remHoje');
  if (!rem.remedios.length) {
    box.replaceChildren(el('p', 'vazio', 'Nenhum remédio ainda. Toque em “+ Remédio” ou conte no chat: “tomo Losartana 50 mg, 1 de manhã”.'));
    $('remRelBtn').hidden = $('remListaBtn').hidden = true;
    return;
  }
  $('remRelBtn').hidden = $('remListaBtn').hidden = false;
  if (!rem.doses.length) { box.replaceChildren(el('p', 'vazio', 'Nada para tomar hoje.')); return; }
  // Agrupa por horário, na ordem do dia; cada grupo tem "tomei todos".
  const grupos = new Map();
  for (const d of rem.doses) grupos.set(d.horario, [...(grupos.get(d.horario) || []), d]);
  const agora = hhmm(new Date());
  box.replaceChildren(...[...grupos].map(([h, ds]) => {
    const feitos = ds.filter((d) => d.tomado).length;
    const atrasado = feitos < ds.length && ds[0].hora <= agora;
    const g = el('div', 'rem-grupo' + (feitos === ds.length ? ' done' : atrasado ? ' agora' : ''));
    const topo = el('div', 'rem-grupo-topo');
    topo.append(el('strong', null, nomeHorario(h)), el('span', 'note', PERIODO[h] ? ds[0].hora : ''));
    if (ds.length > 1 && feitos < ds.length) {
      const todos = el('button', 'linkbtn', 'Tomei todos');
      todos.type = 'button';
      todos.addEventListener('click', () => marcarDoses(ds.filter((d) => !d.tomado), true));
      topo.append(todos);
    }
    g.append(topo);
    for (const d of ds) {
      const lin = el('label', 'rem-dose' + (d.tomado ? ' done' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = d.tomado;
      cb.addEventListener('change', () => marcarDoses([d], cb.checked, cb));
      lin.append(cb, el('span', 'rem-nome', d.nome), el('span', 'note', unid(d.dose, d.unidade)));
      g.append(lin);
    }
    return g;
  }));
}

async function marcarDoses(ds, tomado, cb) {
  try {
    let ultimo;
    for (const d of ds) ultimo = await api('POST', '/app/remedios/dose', { remedio: d.remedio, dia: rem.hoje, horario: d.horario, tomado });
    if (ultimo) {
      rem.doses = ultimo.doses;
      await carregarRemedios();
    }
  } catch (e) {
    if (cb) cb.checked = !tomado;
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
  }
}

// ----- cadastro / edição -----
let remEditando = null;
function montarCamposCaixa(caixa) {
  $('remCaixaCampos').replaceChildren(...Object.entries(CAMPOS_CAIXA).map(([k, rot]) => {
    const l = el('label', null, rot + ' ');
    const i = el('input');
    i.name = 'cx_' + k;
    i.maxLength = 120;
    i.autocomplete = 'off';
    i.value = (caixa && caixa[k]) || '';
    if (k === 'validade' || k === 'fabricacao') i.placeholder = 'AAAA-MM';
    l.append(i);
    return l;
  }));
}
function abrirRemedio(r, pedirFoto) {
  remEditando = r || null;
  const f = $('formRemedio');
  f.reset();
  $('remErro').hidden = true;
  $('remDlgTitulo').textContent = r ? `Editar ${r.nome}` : 'Novo remédio';
  $('remEstoqueLin').hidden = Boolean(r);
  f.inicio.disabled = Boolean(r);
  f.inicio.value = r ? r.inicio : rem.hoje || chave(new Date());
  if (r) {
    f.nome.value = r.nome; f.dose.value = num(r.dose); f.unidade.value = r.unidade;
    f.porCaixa.value = r.porCaixa ?? ''; f.fim.value = r.fim || ''; f.obs.value = r.obs || '';
    for (const p of Object.keys(PERIODO)) f['h_' + p].checked = r.horarios.includes(p);
    f.h_outros.value = r.horarios.filter((h) => !PERIODO[h]).join(', ');
  }
  montarCamposCaixa(r && r.caixa);
  $('remCaixaDet').open = Boolean(r && r.temCaixa);
  $('remFotoNota').textContent = r && !r.temCaixa
    ? 'Falta a foto da caixa: tire uma e eu anoto concentração, laboratório, validade e o resto.'
    : 'Tire uma foto da caixa: eu preencho o nome, a quantidade e os dados da caixa. A foto não fica guardada.';
  $('remFotoBtn').hidden = !chatLigado;
  $('dlgRemedio').showModal();
  if (pedirFoto && chatLigado) $('remFoto').click();
}

async function lerFotoCaixa() {
  const arq = $('remFoto').files[0];
  $('remFoto').value = '';
  if (!arq) return;
  const f = $('formRemedio');
  const b = $('remFotoBtn');
  b.disabled = true;
  b.textContent = 'Lendo a caixa…';
  $('remErro').hidden = true;
  try {
    const r = await api('POST', '/app/remedios/ler-caixa', { imagem: await reduzirFoto(arq) });
    if (r.nome && (!f.nome.value || !remEditando)) f.nome.value = r.nome;
    if (r.unidade && !remEditando) f.unidade.value = r.unidade;
    if (r.porCaixa) f.porCaixa.value = r.porCaixa;
    for (const [k, v] of Object.entries(r.caixa || {})) if (f['cx_' + k]) f['cx_' + k].value = v;
    $('remCaixaDet').open = true;
    $('remFotoNota').textContent = 'Pronto, li a caixa. Confira os campos e diga quanto toma e quando.';
  } catch (e) {
    $('remErro').textContent = e.message && e.codigo !== e.message ? e.message : mensagem(e);
    $('remErro').hidden = false;
  } finally {
    b.disabled = false;
    b.textContent = '📷 Ler da caixa';
  }
}

async function salvarRemedio(evt) {
  evt.preventDefault();
  const f = $('formRemedio');
  const horarios = [...Object.keys(PERIODO).filter((p) => f['h_' + p].checked),
    ...f.h_outros.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)];
  const caixa = {};
  for (const k of Object.keys(CAMPOS_CAIXA)) caixa[k] = f['cx_' + k].value.trim();
  const b = {
    nome: f.nome.value, dose: f.dose.value, unidade: f.unidade.value, horarios, porCaixa: f.porCaixa.value,
    fim: f.fim.value || null, obs: f.obs.value, caixa,
    ...(remEditando ? {} : { inicio: f.inicio.value, caixas: f.caixas.value, estoque: f.estoque.value }),
  };
  if (!horarios.length) { $('remErro').textContent = 'Marque quando toma (manhã, tarde, noite) ou escreva os horários.'; $('remErro').hidden = false; return; }
  $('remSalvar').disabled = true;
  try {
    if (remEditando) {
      // Editar: dados da caixa vazios voltam ao que tinha (o servidor soma); só manda o que tem valor.
      for (const k of Object.keys(caixa)) if (!caixa[k]) delete caixa[k];
      await api('PATCH', `/app/remedios/${remEditando.id}`, b);
    } else await api('POST', '/app/remedios', b);
    $('dlgRemedio').close();
    await carregarRemedios();
  } catch (e) {
    if (['sessao', 'convite', 'reconectar'].includes(e.codigo)) return;
    $('remErro').textContent = mensagem(e);
    $('remErro').hidden = false;
  } finally { $('remSalvar').disabled = false; }
}

// ----- lista e estoque -----
function desenharRemLista() {
  const box = $('remLista');
  if (!rem.remedios.length) { box.replaceChildren(el('p', 'vazio', 'Nenhum remédio ainda.')); return; }
  box.replaceChildren(...rem.remedios.map((r) => {
    const item = el('div', 'rem-item' + (r.ativo ? '' : ' parado'));
    const corpo = el('div');
    corpo.append(el('h3', null, r.nome),
      el('span', 'quando', `${unid(r.dose, r.unidade)} · ${r.horarios.map(nomeHorario).join(', ')}${r.ativo ? '' : ' · parou em ' + ddmm(r.fim)}`),
      el('span', 'det' + (r.dias !== null && r.dias <= 7 ? ' alerta' : ''), estoqueTexto(r)));
    const cx = Object.entries(r.caixa || {}).map(([k, v]) => `${CAMPOS_CAIXA[k] || k}: ${v}`);
    if (cx.length) {
      const d = el('details', 'caixa-info');
      d.append(el('summary', null, 'Dados da caixa' + (r.vencido ? ' · vencida' : r.venceLogo ? ' · vence logo' : '')));
      for (const t of cx) d.append(el('span', 'det', t));
      corpo.append(d);
    } else corpo.append(el('span', 'det note', 'Sem foto da caixa'));
    if (r.obs) corpo.append(el('span', 'det', r.obs));
    const acoes = el('div', 'acoes');
    const botao = (texto, fn, cls) => { const b = el('button', cls || null, texto); b.type = 'button'; b.addEventListener('click', fn); acoes.append(b); };
    botao('Comprei', () => abrirRemEstoque(r, 'compra'));
    botao('Contei', () => abrirRemEstoque(r, 'estoque'));
    if (!r.temCaixa) botao('Foto da caixa', () => abrirRemedio(r, true));
    botao('Editar', () => abrirRemedio(r));
    botao('Apagar', () => abrirRemApagar(r), 'perigo');
    item.append(corpo, acoes);
    return item;
  }));
}
function abrirRemLista() { desenharRemLista(); $('dlgRemLista').showModal(); }

let remEstoque = null;
function abrirRemEstoque(r, modo) {
  remEstoque = { r, modo };
  const f = $('formRemEstoque');
  f.reset();
  $('remEstErro').hidden = true;
  $('remEstTitulo').textContent = modo === 'compra' ? `Comprei ${r.nome}` : `Quanto tem de ${r.nome}?`;
  $('remEstNota').textContent = (modo === 'compra' ? 'Quanto comprou? Soma ao estoque. ' : 'Conte o que tem em casa agora: o estoque fica exatamente nisso. ')
    + (r.porCaixa ? `Cada caixa tem ${num(r.porCaixa)}.` : 'Para contar em caixas, diga antes quantas vêm na caixa (Editar).');
  f.caixas.disabled = !r.porCaixa;
  $('dlgRemEstoque').showModal();
}
async function salvarRemEstoque(evt) {
  evt.preventDefault();
  const f = $('formRemEstoque');
  const { r, modo } = remEstoque;
  try {
    await api('POST', `/app/remedios/${r.id}/${modo}`, { caixas: f.caixas.value, estoque: f.estoque.value });
    $('dlgRemEstoque').close();
    await carregarRemedios();
  } catch (e) {
    if (['sessao', 'convite', 'reconectar'].includes(e.codigo)) return;
    $('remEstErro').textContent = mensagem(e);
    $('remEstErro').hidden = false;
  }
}

let remApagando = null;
function abrirRemApagar(r) { remApagando = r; $('remApagarQual').textContent = r.nome; $('dlgRemApagar').showModal(); }
async function apagarRemedio() {
  try {
    await api('DELETE', `/app/remedios/${remApagando.id}`);
    $('dlgRemApagar').close();
    await carregarRemedios();
  } catch (e) { $('dlgRemApagar').close(); if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e)); }
}

// ----- relatório -----
let remRelDias = 30;
async function abrirRemRel() {
  $('dlgRemRel').showModal();
  await desenharRemRel();
}
async function desenharRemRel() {
  for (const b of $('dlgRemRel').querySelectorAll('[data-dias]')) b.setAttribute('aria-selected', String(Number(b.dataset.dias) === remRelDias));
  const box = $('remRel');
  box.replaceChildren(el('p', 'note', 'carregando…'));
  const hoje = rem.hoje || chave(new Date());
  const d = deChave(hoje);
  d.setDate(d.getDate() - (remRelDias - 1));
  let r;
  try { r = await api('GET', `/app/remedios/relatorio?de=${chave(d)}&ate=${hoje}`); }
  catch (e) { box.replaceChildren(el('p', 'alert red', mensagem(e))); return; }
  if (!r.dias.length) { box.replaceChildren(el('p', 'vazio', 'Ainda não tem dose nesse período.')); return; }
  const t = r.total;
  const resumo = el('div', 'rel-resumo');
  const bloco = (n, rot) => { const b = el('div', 'rel-num'); b.append(el('strong', null, n), el('span', 'note', rot)); return b; };
  resumo.append(bloco(t.adesao === null ? '–' : `${t.adesao}%`, 'das doses tomadas'),
    bloco(String(t.diasCompletos), t.diasCompletos === 1 ? 'dia completo' : 'dias completos'),
    bloco(String(t.diasComFalta), t.diasComFalta === 1 ? 'dia com falta' : 'dias com falta'));
  // Faixa dos dias: verde completo, amarelo parcial, vermelho nenhuma, cinza hoje em aberto.
  const faixa = el('div', 'rel-faixa');
  for (const dia of r.dias) {
    const c = el('span', 'rel-dia ' + (dia.faltas.length === 0 ? (dia.pendentes ? 'aberto' : 'ok') : dia.tomadas === 0 ? 'nada' : 'parcial'));
    c.title = `${ddmm(dia.dia)}: ${dia.tomadas} de ${dia.previstas}`;
    c.textContent = String(Number(dia.dia.slice(8)));
    faixa.append(c);
  }
  const porRem = el('div', 'rel-rem');
  for (const x of r.remedios) {
    const p = x.previstas ? Math.round((x.tomadas / x.previstas) * 100) : 100;   // só a dose de hoje em aberto: ainda não falhou
    const lin = el('div', 'rel-rem-lin');
    const barra = el('span', 'barra');
    const cheio = el('span', 'cheio');
    cheio.style.width = p + '%';
    barra.append(cheio);
    lin.append(el('span', 'rem-nome', x.nome), barra, el('span', 'note', `${x.faltas} ${x.faltas === 1 ? 'falta' : 'faltas'}`));
    porRem.append(lin);
  }
  const faltas = r.dias.filter((x) => x.faltas.length).reverse();
  const lista = el('div', 'rel-faltas');
  lista.append(el('h3', null, faltas.length ? 'Dias em que faltou' : 'Nenhuma falta no período ✓'));
  for (const x of faltas) {
    const dd = deChave(x.dia);
    const lin = el('div', 'rel-falta');
    lin.append(el('strong', null, `${DOW_LONGO[dd.getDay()]}, ${ddmm(x.dia)}`),
      el('span', null, x.faltas.map((f) => `${f.nome} (${nomeHorario(f.horario).toLowerCase()})`).join(' · ')));
    lista.append(lin);
  }
  box.replaceChildren(resumo, faixa, porRem, lista);
}

// ---------- chat ----------
let chatLigado = true;
let audioLigado = false;
let chatCarregado = false;
let pendenteId = null;
const SUGESTOES = () => [
  ...(funcoes.compromissos || funcoes.contas ? ['O que tenho hoje?'] : []),
  ...(funcoes.contas ? ['Luz de 180 reais vence dia 10, todo mês'] : []),
  ...(funcoes.compromissos && !funcoes.contas ? ['Marca dentista sexta às 15h'] : []),
  ...(funcoes.remedios ? ['Tomei os remédios da manhã'] : []),
];

function bolha(m) {
  const b = el('div', 'bolha ' + (m.de === 'eu' ? 'eu' : 'icarus') + (m.erro ? ' erro' : ''));
  if (m.fotoLocal) { const i = el('img'); i.src = m.fotoLocal; i.alt = 'Foto enviada'; b.append(i); }
  else if (m.imagem) b.append(el('span', 'foto-marca', '📷 foto'));
  if (m.audio) b.append(el('span', 'audio-marca', '🎤 áudio'));
  if (m.texto) b.append(m.texto);
  return b;
}
// Limite do dia e pausa, no rodapé do chat.
let restantes = null;
function atualizarRodape(pausado) {
  const r = $('chatRodape');
  if (pausado) {
    r.textContent = 'Chat pausado até amanhã. A agenda continua funcionando.';
    $('chatForm').hidden = true;
    return;
  }
  r.textContent = restantes == null ? '' : restantes <= 0
    ? 'Acabaram as mensagens de hoje. Amanhã tem mais.'
    : `Só para a agenda, as contas e os remédios · ${restantes} ${restantes === 1 ? 'mensagem' : 'mensagens'} hoje`;
  if (restantes != null && restantes <= 0) $('chatForm').hidden = true;
}

// ---------- foto no chat ----------
// Reduzida no aparelho (até 1600 px, JPEG): sobe rápido e gasta menos com a IA. Não fica guardada no servidor.
let fotoAtual = null;
function lerArquivo(arq) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => falha(new Error('Não consegui ler a foto.'));
    r.readAsDataURL(arq);
  });
}
function carregarImagem(src) {
  return new Promise((ok, falha) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => falha(new Error('Esse arquivo não abriu como foto. Tente um print ou uma foto em JPEG.'));
    i.src = src;
  });
}
async function reduzirFoto(arq) {
  if (!/^image\//.test(arq.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(arq.name)) throw new Error('Mande uma foto ou um print.');
  if (arq.size > 25 * 1024 * 1024) throw new Error('Foto grande demais.');
  const img = await carregarImagem(await lerArquivo(arq));
  const escala = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * escala);
  c.height = Math.round(img.naturalHeight * escala);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
function mostrarFoto(dados) {
  fotoAtual = dados;
  $('chatFotoPrevia').hidden = !dados;
  $('chatFotoImg').src = dados || '';
  botoesChat();
}

// ---------- áudio no chat ----------
// O aparelho grava, converte para WAV mono de 16 kHz (o formato do Whisper) e manda; a VPS
// transcreve com o whisper.cpp e apaga o áudio. O texto transcrito segue como uma mensagem escrita.
const AUDIO_MAX = 120;   // segundos
let gravador = null, pedacosAudio = [], inicioAudio = 0, relogioAudio = null, audioCancelado = false, enviando = false;

// Como no WhatsApp: caixa vazia mostra o microfone; com texto ou foto, o enviar. Gravando: o enviar termina e manda.
function botoesChat() {
  const gravandoAgora = Boolean(gravador);
  const temAlgo = Boolean($('chatTexto').value.trim() || fotoAtual);
  $('chatGravando').hidden = !gravandoAgora;
  $('chatTexto').hidden = gravandoAgora;
  $('chatFotoBtn').hidden = gravandoAgora;
  $('chatMic').hidden = !audioLigado || gravandoAgora || temAlgo;
  $('chatEnviar').hidden = !gravandoAgora && !temAlgo;
  $('chatEnviar').disabled = enviando;
  $('chatMic').disabled = enviando;
  $('chatFotoBtn').disabled = enviando;
}
async function gravarAudio() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { avisarNoChat('Este navegador não grava áudio. Use o microfone do teclado.'); return; }
  let fluxo;
  try { fluxo = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { avisarNoChat('Sem permissão para o microfone. Libere o microfone para este site nas configurações do navegador.'); return; }
  const tipo = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  gravador = new MediaRecorder(fluxo, tipo ? { mimeType: tipo } : undefined);
  pedacosAudio = [];
  audioCancelado = false;
  gravador.ondataavailable = (e) => { if (e.data.size) pedacosAudio.push(e.data); };
  gravador.onstop = () => {
    fluxo.getTracks().forEach((t) => t.stop());
    clearInterval(relogioAudio);
    const blob = new Blob(pedacosAudio, { type: gravador.mimeType });
    gravador = null;
    botoesChat();
    if (!audioCancelado) enviarAudio(blob);
  };
  gravador.start();
  inicioAudio = Date.now();
  const tempo = document.querySelector('#chatGravando .tempo');
  tempo.textContent = '0:00';
  relogioAudio = setInterval(() => {
    const seg = Math.floor((Date.now() - inicioAudio) / 1000);
    tempo.textContent = Math.floor(seg / 60) + ':' + String(seg % 60).padStart(2, '0');
    if (seg >= AUDIO_MAX && gravador) gravador.stop();
  }, 250);
  botoesChat();
}
async function paraWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const taxa = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * taxa)), taxa);
  const fonte = off.createBufferSource();
  fonte.buffer = audio; fonte.connect(off.destination); fonte.start();
  const amostras = (await off.startRendering()).getChannelData(0);
  const buf = new DataView(new ArrayBuffer(44 + amostras.length * 2));
  const str = (o, t) => [...t].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + amostras.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, taxa, true); buf.setUint32(28, taxa * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, amostras.length * 2, true);
  for (let i = 0; i < amostras.length; i++) { const v = Math.max(-1, Math.min(1, amostras[i])); buf.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
  return { wav: new Blob([buf], { type: 'audio/wav' }), duracao: audio.duration };
}
function avisarNoChat(texto) {
  const lista = $('chatLista');
  if (lista.querySelector('.chat-vazio')) lista.replaceChildren();
  lista.append(bolha({ de: 'icarus', texto, erro: true }));
  rolarChat();
}
async function enviarAudio(blob) {
  let wav, duracao;
  try { ({ wav, duracao } = await paraWav(blob)); }
  catch { avisarNoChat('Não consegui ler o áudio gravado. Tente de novo ou escreva.'); return; }
  if (duracao < 0.7) { avisarNoChat('Áudio curto demais.'); return; }
  const dados = await lerArquivo(wav);
  await mandar({ texto: '', foto: fotoAtual, audio: dados });
}
function rolarChat() { const l = $('chatLista'); l.scrollTop = l.scrollHeight; }
function vazioChat() {
  const v = el('div', 'chat-vazio');
  if (!chatLigado) { v.append(el('p', null, 'O chat ainda não está ligado. A agenda funciona normalmente.')); return v; }
  v.append(el('p', null, 'Aqui é só para a agenda e as contas. Peça do seu jeito ou mande a foto de um boleto (📷). Por exemplo:'));
  for (const t of SUGESTOES()) {
    const b = el('button', null, t);
    b.type = 'button';
    b.addEventListener('click', () => { $('chatTexto').value = t; $('chatTexto').focus(); });
    v.append(b);
  }
  return v;
}
function mostrarPendente(p) {
  pendenteId = p ? p.id : null;
  $('chatPendente').hidden = !p;
  $('chatPendItens').replaceChildren(...(p ? p.itens.map((t) => el('li', null, t)) : []));
  if (p) rolarChat();
}
async function abrirChat() {
  $('chat').hidden = false;
  $('chatBtn').hidden = true;
  $('chatBtn').setAttribute('aria-expanded', 'true');
  $('chatForm').hidden = !chatLigado;
  if (!chatCarregado) {
    try {
      const r = await api('GET', '/app/chat');
      chatLigado = r.ligado;
      $('chatForm').hidden = !chatLigado;
      $('chatLista').replaceChildren(...(r.mensagens.length ? r.mensagens.map(bolha) : [vazioChat()]));
      mostrarPendente(r.pendente);
      restantes = r.restantes;
      if (r.textoMax) $('chatTexto').maxLength = r.textoMax;
      atualizarRodape(r.pausado);
      chatCarregado = true;
    } catch (e) {
      if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) $('chatLista').replaceChildren(bolha({ de: 'icarus', texto: mensagem(e), erro: true }));
    }
  }
  rolarChat();
  if (chatLigado) $('chatTexto').focus();
}
function fecharChat() {
  $('chat').hidden = true;
  $('chat').style.transform = '';
  $('chat').style.transition = '';
  $('chatBtn').hidden = false;
  $('chatBtn').setAttribute('aria-expanded', 'false');
  $('chatBtn').focus();
}

// Celular: arrastar o chat para baixo fecha. Vale pela alça e pelo topo, ou pelas mensagens quando já estão
// no começo (aí o arrasto não é rolagem). A caixa de texto e os botões ficam de fora.
function deslizarParaFechar() {
  const chat = $('chat');
  let y0 = null, t0 = 0, dy = 0, arrastando = false;
  const podeComecar = (alvo) => {
    if (!window.matchMedia('(max-width: 640px)').matches) return false;
    if (alvo.closest('textarea, input, button, select, a, .chat-pendente, .chat-form, .chat-previa')) return false;
    if (alvo.closest('.chat-alca, .chat-topo')) return true;
    const lista = alvo.closest('.chat-lista');
    return Boolean(lista && lista.scrollTop <= 0);
  };
  chat.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !podeComecar(e.target)) { y0 = null; return; }
    y0 = e.touches[0].clientY; t0 = performance.now(); dy = 0; arrastando = false;
  }, { passive: true });
  chat.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (!arrastando) {
      if (dy < 8) { if (dy < -8) y0 = null; return; }   // para cima: deixa rolar as mensagens
      arrastando = true;
      chat.style.transition = 'none';
    }
    e.preventDefault();
    chat.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const soltar = () => {
    if (y0 == null || !arrastando) { y0 = null; return; }
    const rapido = dy / Math.max(1, performance.now() - t0) > 0.6;
    y0 = null;
    arrastando = false;
    chat.style.transition = 'transform 0.2s ease-out';
    if (dy > 120 || (rapido && dy > 40)) {
      chat.style.transform = 'translateY(100%)';
      setTimeout(fecharChat, 190);
    } else {
      chat.style.transform = '';
    }
  };
  chat.addEventListener('touchend', soltar);
  chat.addEventListener('touchcancel', soltar);
}
async function enviarChat(evt) {
  evt.preventDefault();
  if (gravador) { gravador.stop(); return; }   // gravando: o enviar termina e manda o áudio
  const texto = $('chatTexto').value.trim();
  if (!texto && !fotoAtual) return;
  await mandar({ texto, foto: fotoAtual, audio: null });
}
async function mandar({ texto, foto, audio }) {
  if (enviando) return;
  const caixa = $('chatTexto');
  const lista = $('chatLista');
  if (lista.querySelector('.chat-vazio')) lista.replaceChildren();
  const minha = bolha({ de: 'eu', texto: audio ? '' : texto, fotoLocal: foto, audio: Boolean(audio) });
  mostrarFoto(null);
  const pensando = el('div', 'bolha icarus pensando', audio ? 'ouvindo…' : 'pensando…');
  lista.append(minha, pensando);
  caixa.value = '';
  ajustarCaixa();
  mostrarPendente(null);
  rolarChat();
  enviando = true;
  botoesChat();
  try {
    const r = await api('POST', '/app/chat', { texto, ...(foto ? { imagem: foto } : {}), ...(audio ? { audio } : {}) });
    // No áudio, a bolha da pessoa passa a mostrar o que foi entendido.
    if (audio && r.mensagens[0]) minha.replaceWith(bolha({ ...r.mensagens[0], fotoLocal: foto }));
    pensando.replaceWith(bolha(r.mensagens[r.mensagens.length - 1]));
    if (restantes != null) restantes--;
    atualizarRodape(/pausado/.test(r.mensagens[r.mensagens.length - 1].texto) && r.fora);
    mostrarPendente(r.pendente);
    if (r.mudou) carregar();
    if (r.remedios) carregarRemedios();
  } catch (e) {
    if (['sessao', 'convite', 'reconectar'].includes(e.codigo)) { pensando.remove(); return; }
    pensando.replaceWith(bolha({ de: 'icarus', texto: mensagem(e), erro: true }));
    if (e.codigo === 'pausado') atualizarRodape(true);
    else if (e.codigo === 'limite-dia') { restantes = 0; atualizarRodape(false); }
    else if (!audio) { if (!caixa.value) caixa.value = texto; if (foto && !fotoAtual) mostrarFoto(foto); }
  } finally {
    enviando = false;
    botoesChat();
    rolarChat();
    caixa.focus();
  }
}
async function responderPendente(sim) {
  if (!pendenteId) return;
  for (const b of [$('chatSim'), $('chatNao')]) b.disabled = true;
  try {
    const r = await api('POST', '/app/chat/confirmar', { id: pendenteId, sim });
    mostrarPendente(null);
    for (const m of r.mensagens) $('chatLista').append(bolha(m));
    if (r.mudou) carregar();
    if (r.remedios) carregarRemedios();
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) {
      mostrarPendente(null);
      $('chatLista').append(bolha({ de: 'icarus', texto: mensagem(e), erro: true }));
    }
  } finally {
    for (const b of [$('chatSim'), $('chatNao')]) b.disabled = false;
    rolarChat();
  }
}
function ajustarCaixa() {
  const c = $('chatTexto');
  c.style.height = 'auto';
  c.style.height = Math.min(c.scrollHeight, 140) + 'px';
}


// ---------- avisos (push) ----------
const temPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const ehIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const naTelaDeInicio = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const O_QUE_AVISA = 'De manhã, o que tem no dia; à noite, o de amanhã; e 1 hora antes de cada compromisso com hora. O que já está feito não avisa.';
let registro = null;

function irParaDia(k) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k || '')) return;
  sel = k;
  const d = deChave(k);
  if (d.getFullYear() !== ano || d.getMonth() !== mes) irPara(d.getFullYear(), d.getMonth());
  else desenhar();
}
async function assinaturaAtual() {
  if (!temPush || !registro || Notification.permission !== 'granted') return null;
  return registro.pushManager.getSubscription().catch(() => null);
}
async function atualizarSino() {
  const sub = await assinaturaAtual();
  $('avisosEstado').textContent = sub ? 'ligados' : 'desligados';
  $('avisosEstado').className = 'mi-estado' + (sub ? ' ok' : '');
  $('avisosBtn').setAttribute('aria-pressed', sub ? 'true' : 'false');
  // Pontinho no avatar enquanto os avisos não estão ligados (dá para ligar pelo menu).
  document.querySelector('.avatar').classList.toggle('pendente', temPush && !sub && Notification.permission !== 'denied');
  return sub;
}
async function prepararAvisos() {
  $('avisosBtn').hidden = false;
  if ('serviceWorker' in navigator) {
    try { registro = await navigator.serviceWorker.register('/sw.js'); } catch { registro = null; }
    navigator.serviceWorker.addEventListener('message', (e) => {
      const url = e.data && e.data.abrir;
      if (url) irParaDia(new URLSearchParams(String(url).split('#')[1] || '').get('dia'));
    });
  }
  const sub = await atualizarSino();
  // Aparelho já assinado: confirma com o servidor (renova o login que a rodada usa).
  if (sub) api('POST', '/app/push', { assinatura: sub.toJSON() }).catch(() => {});
}
async function abrirAvisos() {
  const sub = await atualizarSino();
  const acao = $('avisosAcao');
  $('avisosErro').hidden = true;
  acao.hidden = false;
  if (!temPush) {
    $('avisosTexto').textContent = ehIOS && !naTelaDeInicio
      ? 'No iPhone, os avisos só funcionam com a agenda na Tela de Início: toque em Compartilhar e depois em "Adicionar à Tela de Início". Abra a agenda pelo ícone novo e ligue os avisos por lá.'
      : 'Este navegador não recebe avisos. No celular, use o Chrome (Android) ou a agenda pela Tela de Início (iPhone).';
    acao.hidden = true;
  } else if (Notification.permission === 'denied') {
    $('avisosTexto').textContent = 'Os avisos estão bloqueados para este site neste navegador. Libere nas permissões do site (o cadeado ao lado do endereço) e tente de novo.';
    acao.hidden = true;
  } else if (sub) {
    $('avisosTexto').textContent = 'Ligados neste aparelho. ' + O_QUE_AVISA;
    acao.textContent = 'Desligar';
  } else {
    $('avisosTexto').textContent = 'Ligue para receber avisos neste aparelho, mesmo com a agenda fechada. ' + O_QUE_AVISA;
    acao.textContent = 'Ligar avisos';
  }
  $('dlgAvisos').showModal();
}
function bytesDaChave(b64u) {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
async function alternarAvisos() {
  const acao = $('avisosAcao');
  acao.disabled = true;
  try {
    const atual = await assinaturaAtual();
    if (atual) {
      await api('DELETE', '/app/push', { endpoint: atual.endpoint }).catch(() => {});
      await atual.unsubscribe().catch(() => {});
      $('dlgAvisos').close();
      avisar('Avisos desligados neste aparelho.');
    } else {
      // O iPhone exige que o pedido de permissão venha direto do toque: é a primeira coisa aqui.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Sem a permissão do navegador não dá para avisar. Se mudar de ideia, toque no sino de novo.');
      if (!registro) registro = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { chave } = await api('GET', '/app/push');
      const sub = await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesDaChave(chave) });
      await api('POST', '/app/push', { assinatura: sub.toJSON() });
      await api('POST', '/app/push/teste').catch(() => {});
      $('dlgAvisos').close();
      avisar('Avisos ligados. Mandei um de teste agora.');
    }
  } catch (e) {
    if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) {
      $('avisosErro').textContent = e instanceof ErroApi ? mensagem(e) : (e.message || 'Não deu certo agora. Tente de novo.');
      $('avisosErro').hidden = false;
    }
  } finally {
    acao.disabled = false;
    atualizarSino();
  }
}
// ---------- microfone e câmera ----------
// Botão na barra, como o sino: mostra se o microfone (áudio do chat) e a câmera (foto do boleto) estão liberados
// e pede a permissão num toque. O navegador só pergunta uma vez; bloqueado, só pelas configurações do site.
const NOMES_ESTADO = { granted: 'liberado', denied: 'bloqueado', prompt: 'ainda não perguntado', '?': 'não sei dizer' };
async function estadoPermissao(nome) {
  try { return (await navigator.permissions.query({ name: nome })).state; } catch { return '?'; }
}
async function atualizarMidia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  const mic = await estadoPermissao('microphone');
  const cam = await estadoPermissao('camera');
  const tudo = mic === 'granted' && cam === 'granted';
  $('midiaBtn').setAttribute('aria-pressed', tudo ? 'true' : 'false');
  const bloqueado = mic === 'denied' || cam === 'denied';
  $('midiaEstado').textContent = tudo ? 'liberados' : bloqueado ? 'bloqueado' : 'liberar';
  $('midiaEstado').className = 'mi-estado' + (tudo ? ' ok' : bloqueado ? ' ruim' : '');
  return { mic, cam };
}
async function prepararMidia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;   // sem câmera/microfone: sem botão
  $('midiaBtn').hidden = false;
  await atualizarMidia();
}
async function abrirMidia() {
  const e = await atualizarMidia();
  $('midiaErro').hidden = true;
  $('midiaMic').textContent = NOMES_ESTADO[e.mic] || e.mic;
  $('midiaCam').textContent = NOMES_ESTADO[e.cam] || e.cam;
  const bloqueado = e.mic === 'denied' || e.cam === 'denied';
  const pronto = e.mic === 'granted' && e.cam === 'granted';
  $('midiaTexto').textContent = pronto
    ? 'Tudo liberado neste aparelho: dá para mandar áudio e tirar foto de boleto no chat.'
    : bloqueado
      ? 'Algo está bloqueado. Libere nas permissões do site (o cadeado ao lado do endereço, ou Ajustes > Safari no iPhone) e volte aqui.'
      : 'Libere para mandar áudio no chat (microfone) e tirar foto de boleto ou conta (câmera). O navegador vai perguntar.';
  $('midiaPermitir').hidden = pronto;
  $('dlgMidia').showModal();
}
async function pedirMidia() {
  const b = $('midiaPermitir');
  b.disabled = true;
  try {
    let fluxo;
    // Os dois de uma vez; se a câmera não existir ou for recusada, pelo menos o microfone.
    try { fluxo = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); }
    catch { fluxo = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    fluxo.getTracks().forEach((t) => t.stop());   // só a permissão: nada fica gravando
    await abrirMidia();
  } catch {
    $('midiaErro').textContent = 'O navegador não liberou. Se ele não perguntou, a permissão está bloqueada: libere nas configurações do site.';
    $('midiaErro').hidden = false;
    atualizarMidia();
  } finally {
    b.disabled = false;
  }
}

async function esquecerAparelho() {
  const sub = await assinaturaAtual();
  if (!sub) return;
  await api('DELETE', '/app/push', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

// ---------- ligações ----------
document.addEventListener('DOMContentLoaded', () => {
  $('antBtn').addEventListener('click', () => irPara(ano, mes - 1));
  $('proxBtn').addEventListener('click', () => irPara(ano, mes + 1));
  $('hojeBtn').addEventListener('click', () => { sel = chave(new Date()); irPara(new Date().getFullYear(), new Date().getMonth()); });
  $('grade').addEventListener('click', (e) => {
    const dia = e.target.closest('.day');
    if (!dia) return;
    sel = dia.dataset.k;
    const d = deChave(sel);
    if (d.getMonth() !== mes) return irPara(d.getFullYear(), d.getMonth());
    desenhar();
    if (window.matchMedia('(max-width: 980px)').matches) document.querySelector('.side').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('grade').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('.day')?.click(); }
  });
  $('novoBtn').addEventListener('click', () => abrirEvento(null));
  $('novoNoDia').addEventListener('click', () => abrirEvento(null, sel));
  $('formEvento').addEventListener('submit', salvarEvento);
  $('formEvento').diaInteiro.addEventListener('change', ajustarForm);
  $('formEvento').todas.addEventListener('change', ajustarForm);
  $('dlgCancelar').addEventListener('click', () => $('dlgEvento').close());
  $('apagarCancelar').addEventListener('click', () => $('dlgApagar').close());
  $('apagarUm').addEventListener('click', () => apagar(false));
  $('apagarTodas').addEventListener('click', () => apagar(true));
  $('sairBtn').addEventListener('click', async () => {
    await esquecerAparelho();
    await api('POST', '/app/sair').catch(() => {});
    mostrarEntrar(ehDemo ? 'demo-saiu' : 'saiu');
  });
  $('desconectarBtn').addEventListener('click', () => { document.querySelector('.menu').open = false; $('dlgDesconectar').showModal(); });
  $('descCancelar').addEventListener('click', () => $('dlgDesconectar').close());
  $('descConfirmar').addEventListener('click', async () => {
    $('descConfirmar').disabled = true;
    try {
      const sub = await assinaturaAtual();
      await api('POST', '/app/desconectar');
      if (sub) await sub.unsubscribe().catch(() => {});
      $('dlgDesconectar').close();
      mostrarEntrar('desconectado');
    } catch (e) {
      $('dlgDesconectar').close();
      if (!['sessao', 'convite', 'reconectar'].includes(e.codigo)) avisar(mensagem(e));
    } finally { $('descConfirmar').disabled = false; }
  });
  document.addEventListener('click', (e) => { const m = document.querySelector('.menu'); if (m.open && !m.contains(e.target)) m.open = false; });
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.shiftKey && e.key === 'ArrowLeft') irPara(ano, mes - 1);
    if (e.shiftKey && e.key === 'ArrowRight') irPara(ano, mes + 1);
  });
  // Voltou para a aba depois de um tempo: busca de novo (a pessoa pode ter mudado algo no app do Google).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !$('telaAgenda').hidden && Date.now() - ultimaCarga > 60_000) carregar();
  });
  const doMenu = (fn) => () => { document.querySelector('.menu').open = false; fn(); };
  $('avisosBtn').addEventListener('click', doMenu(abrirAvisos));
  for (const b of document.querySelectorAll('.funcao')) b.addEventListener('click', () => alternarFuncao(b.dataset.funcao));
  $('midiaBtn').addEventListener('click', doMenu(abrirMidia));
  $('midiaPermitir').addEventListener('click', pedirMidia);
  $('midiaFechar').addEventListener('click', () => $('dlgMidia').close());
  $('avisosAcao').addEventListener('click', alternarAvisos);
  $('avisosFechar').addEventListener('click', () => $('dlgAvisos').close());
  window.addEventListener('hashchange', () => {
    const k = new URLSearchParams(location.hash.slice(1)).get('dia');
    if (k) { history.replaceState(null, '', location.pathname); irParaDia(k); }
    if (location.hash === '#remedios' && funcoes.remedios) { history.replaceState(null, '', location.pathname); carregarRemedios(); $('cardRemedios').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
  $('remNovoBtn').addEventListener('click', () => abrirRemedio(null));
  $('remListaBtn').addEventListener('click', abrirRemLista);
  $('remListaNovo').addEventListener('click', () => { $('dlgRemLista').close(); abrirRemedio(null); });
  $('remListaFechar').addEventListener('click', () => $('dlgRemLista').close());
  $('remRelBtn').addEventListener('click', abrirRemRel);
  $('remRelFechar').addEventListener('click', () => $('dlgRemRel').close());
  for (const b of $('dlgRemRel').querySelectorAll('[data-dias]')) b.addEventListener('click', () => { remRelDias = Number(b.dataset.dias); desenharRemRel(); });
  $('formRemedio').addEventListener('submit', salvarRemedio);
  $('remCancelar').addEventListener('click', () => $('dlgRemedio').close());
  $('remFotoBtn').addEventListener('click', () => $('remFoto').click());
  $('remFoto').addEventListener('change', lerFotoCaixa);
  $('formRemEstoque').addEventListener('submit', salvarRemEstoque);
  $('remEstCancelar').addEventListener('click', () => $('dlgRemEstoque').close());
  $('remApagarCancelar').addEventListener('click', () => $('dlgRemApagar').close());
  $('remApagarSim').addEventListener('click', apagarRemedio);
  $('novaContaBtn').addEventListener('click', () => abrirEvento(null, sel, 'conta'));
  $('abaPagar').addEventListener('click', () => { visContas = 'pagar'; desenharCardContas(); });
  $('abaCategoria').addEventListener('click', () => { visContas = 'categoria'; desenharCardContas(); });
  for (const r of $('formEvento').tipo) r.addEventListener('change', () => {
    if (!editando && $('formEvento').tipo.value === 'conta' && $('formEvento').repetir.value === 'nao') $('formEvento').repetir.value = 'mensal';
    ajustarForm();
  });
  $('chatBtn').addEventListener('click', abrirChat);
  deslizarParaFechar();
  $('chatFechar').addEventListener('click', fecharChat);
  $('chatForm').addEventListener('submit', enviarChat);
  $('chatTexto').addEventListener('input', ajustarCaixa);
  $('chatTexto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !window.matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('chatForm').requestSubmit(); }
  });
  $('chatMic').addEventListener('click', gravarAudio);
  $('chatCancelarAudio').addEventListener('click', () => { audioCancelado = true; if (gravador) gravador.stop(); });
  $('chatTexto').addEventListener('input', botoesChat);
  $('chatFotoBtn').addEventListener('click', () => $('chatFoto').click());
  $('chatFotoTirar').addEventListener('click', () => mostrarFoto(null));
  $('chatFoto').addEventListener('change', async () => {
    const arq = $('chatFoto').files[0];
    $('chatFoto').value = '';
    if (!arq) return;
    try { mostrarFoto(await reduzirFoto(arq)); $('chatTexto').focus(); }
    catch (e) { $('chatLista').append(bolha({ de: 'icarus', texto: e.message, erro: true })); rolarChat(); }
  });
  $('chatSim').addEventListener('click', () => responderPendente(true));
  $('chatNao').addEventListener('click', () => responderPendente(false));
  $('chatLimpar').addEventListener('click', async () => {
    if (!confirm('Apagar a conversa? A agenda não muda.')) return;
    try { await api('DELETE', '/app/chat'); } catch { return; }
    mostrarPendente(null);
    $('chatLista').replaceChildren(vazioChat());
  });
  $('chat').addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharChat(); });
  iniciar();
});
