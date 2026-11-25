# IAgenda

Agenda Google com um chat de IA que cuida dela por você. A pessoa entra com a conta Google, vê o mês, e pode pedir no chat (por texto, foto ou áudio) para criar, mudar, apagar ou marcar compromissos como feitos. Além dos compromissos, a IAgenda controla **contas a pagar** e **remédios**, e manda **avisos por push** no celular.

Projeto pessoal de Icaro Carvalho. Hoje roda para um grupo pequeno de convidados.

## O que faz

- **Agenda do mês** lida direto do Google Calendar da pessoa. Nada dos eventos é copiado para o servidor: a fonte de verdade é a própria agenda Google.
- **Chat com a Icarus**, a assistente, feito com a Messages API da Anthropic e uso de ferramentas (`listar_eventos`, `criar_evento`, `editar_evento`, `remover_evento`, `marcar_feito` e as de remédios).
  - Foto de boleto, conta, convite ou caixa de remédio: a IA tira o que precisa (valor, vencimento, data, dados da caixa).
  - Áudio: transcrito no próprio servidor com whisper.cpp e apagado em seguida.
- **Contas a pagar**: um tipo de evento de dia inteiro, com valor e categoria guardados em `extendedProperties.private` do Google. Marcar como pago põe "✓" no título.
- **Remédios**: cadastro (dose, horários, unidades por caixa), estoque calculado pelos movimentos, check-in do dia e relatório de faltas. É dado de saúde: fica só no SQLite do servidor, separado por pessoa, e nunca vai para o Google.
- **Avisos por push** (Web Push): "hoje" de manhã, "amanhã" à noite, 1 hora antes de cada evento, remédios no horário e remédio acabando.
- **Funções que cada pessoa liga ou desliga** (Compromissos, Contas, Remédios): desligada, some da página, do chat e dos avisos.
- PWA instalável no celular.

## Segurança

O chat mexe em dados reais de outras pessoas, então boa parte do código é sobre limites:

- **Três travas contra uso fora do assunto**: um filtro no servidor antes da IA (frases de ataque, comandos, blocos codificados); a ferramenta `fora_do_assunto`, que a IA chama para qualquer outra coisa e à qual o servidor responde com uma frase fixa; e uma pausa do chat depois de alguns pedidos fora do assunto no dia.
- **Apagar ou mudar uma série inteira não acontece pela palavra da IA**: vira um pedido pendente que só o botão "Confirmar" da tela executa.
- Título e descrição de convite são tratados como dado, nunca como instrução (qualquer pessoa pode mandar um convite).
- Limites por mensagem (quantos eventos dá para criar, mudar ou apagar) e por dia.
- O access token do Google fica só na memória do processo; o navegador recebe apenas um cookie `HttpOnly; SameSite=Strict; Secure`.
- CSP restrita, todo texto vindo do Google entra na página por `textContent`, conferência de origem nas rotas que mudam algo.
- Web Push implementado só com `node:crypto` (RFC 8291, `aes128gcm` e JWT VAPID ES256), aceitando apenas os hosts de push dos navegadores.
- Em produção, o serviço systemd roda com usuário próprio, sem sudo e com o sistema de arquivos travado (`deploy/agenda-web.service`).

## Stack

- Node 22+ com TypeScript rodando direto (type stripping do Node), sem build.
- `node:http`, `node:sqlite` e `node:crypto`; a única dependência é o SDK da Anthropic.
- Front-end em HTML, CSS e JavaScript puros (`publico/`).

## Arquivos

| Arquivo | O que faz |
|---|---|
| `servidor.ts` | Servidor HTTP, rotas `/app/*`, sessão, cabeçalhos de segurança |
| `agenda.ts` | Login (pelo serviço de contas) e Google Calendar: listar, criar, editar, apagar, marcar feito |
| `chat.ts` | Chat: prompt, ferramentas, travas, confirmação, foto e áudio |
| `remedios.ts` | Remédios, estoque, doses e relatório |
| `push.ts` | Web Push e a rodada de avisos a cada 5 minutos |
| `funcoes.ts` | Funções ligadas e desligadas por pessoa |
| `banco.ts` | SQLite |
| `publico/` | A página (agenda, chat, remédios) e a política de privacidade |
| `teste/` | Servidor falso (login, Google e Anthropic) para rodar tudo no computador com dados fictícios |

## Rodar no computador

Não precisa de conta Google nem de chave de API: o `teste/falso.ts` imita o serviço de login, o Google Calendar e a API da Anthropic com dados fictícios.

```
npm install
node teste/local.ts
```

Depois abra <http://127.0.0.1:8091/#codigo=codigo-de-teste-1234567890>.

## Login

O login com Google não fica neste repositório: ele é feito por um serviço separado (outro projeto meu, em .NET), que guarda o refresh token do Google criptografado, controla a lista de convidados e emite o JWT. A IAgenda conversa com ele por estas rotas:

| Rota | Para quê |
|---|---|
| `GET /api/auth/google/start` | Começa o login com Google e volta para a IAgenda com `#codigo=...` |
| `POST /api/auth/google/sessao` | Troca o código pelo JWT da pessoa |
| `GET /api/auth/me` | Quem está logado |
| `GET /api/auth/google/acesso` | Access token do Google da pessoa (exige o segredo do serviço no cabeçalho `X-Agenda-Servico`) |
| `DELETE /api/auth/google` | Revoga o Google e apaga a conta |

Para usar com outro provedor de login, basta trocar as funções de `agenda.ts` que chamam essas rotas.

## Variáveis de ambiente

| Variável | Padrão | Para quê |
|---|---|---|
| `AGENDA_HOST`, `AGENDA_PORTA` | `127.0.0.1`, `8091` | Onde o servidor escuta |
| `AGENDA_CONTAS` | `http://127.0.0.1:5000` | Endereço do serviço de login |
| `AGENDA_SITE` | `http://127.0.0.1:8091` | Endereço público (usado nos avisos) |
| `AGENDA_SEGREDO` | | Arquivo com o segredo do serviço (ou `LoadCredential` do systemd) |
| `AGENDA_ANTHROPIC_CHAVE` | | Arquivo com a chave da API da Anthropic. Sem ela, o chat fica desligado |
| `AGENDA_MODELO`, `AGENDA_ESFORCO` | `claude-opus-5-5`, `low` | Modelo e esforço do chat |
| `AGENDA_CHAT_DIA` | `100` | Mensagens por pessoa por dia |
| `AGENDA_WHISPER`, `AGENDA_WHISPER_MODELO` | | whisper.cpp para o áudio |
| `AGENDA_DADOS` | `./dados` | Pasta do SQLite e das chaves VAPID (geradas na primeira vez) |
| `AGENDA_INSEGURO=1` | | Cookie sem `Secure`, só para testar sem HTTPS |
