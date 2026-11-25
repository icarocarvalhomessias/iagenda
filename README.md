# IAgenda

Agenda Google com um chat de IA que cuida dela por você. A pessoa entra com a conta Google, vê o mês, e pode pedir no chat (por texto, foto ou áudio) para criar, mudar, apagar ou marcar compromissos como feitos. Além dos compromissos, a IAgenda controla **contas a pagar** e **remédios**, e manda **avisos por push** no celular.

Projeto pessoal de Icaro Carvalho. Hoje roda para um grupo pequeno de convidados.

## O que faz

- **Agenda do mês** lida direto do Google Calendar da pessoa. Nada dos eventos é copiado para o servidor: a fonte de verdade é a própria agenda Google.
- **Chat com a Icarus**, a assistente, com uso de ferramentas (`listar_eventos`, `criar_evento`, `editar_evento`, `remover_evento`, `marcar_feito` e as de remédios). A IA é trocável: Anthropic (padrão), OpenAI, Gemini, Ollama (no próprio servidor) ou qualquer API compatível com a do OpenAI.
  - Foto de boleto, conta, convite ou caixa de remédio: a IA tira o que precisa (valor, vencimento, data, dados da caixa).
  - Áudio: transcrito no próprio servidor com whisper.cpp e apagado em seguida.
- **Contas a pagar**: um tipo de evento de dia inteiro, com valor e categoria guardados em `extendedProperties.private` do Google. Marcar como pago põe "✓" no título.
- **Remédios**: cadastro (dose, horários, unidades por caixa), estoque calculado pelos movimentos, check-in do dia e relatório de faltas. É dado de saúde: fica só no SQLite do servidor, separado por pessoa, e nunca vai para o Google.
- **Avisos por push** (Web Push): "hoje" de manhã, "amanhã" à noite, 1 hora antes de cada evento, remédios no horário e remédio acabando.
- **Funções que cada pessoa liga ou desliga** (Compromissos, Contas, Remédios): desligada, some da página, do chat e dos avisos.
- PWA instalável no celular.
- **Modo demonstração** (opcional): "Experimentar sem conta" abre uma agenda de exemplo, guardada no próprio servidor, para quem não tem convite conhecer a IAgenda sem entregar a conta Google.

## Segurança

O chat mexe em dados reais de outras pessoas, então boa parte do código é sobre limites:

- **Três travas contra uso fora do assunto**: um filtro no servidor antes da IA (frases de ataque, comandos, blocos codificados); a ferramenta `fora_do_assunto`, que a IA chama para qualquer outra coisa e à qual o servidor responde com uma frase fixa; e uma pausa do chat depois de alguns pedidos fora do assunto no dia.
- **Apagar ou mudar uma série inteira não acontece pela palavra da IA**: vira um pedido pendente que só o botão "Confirmar" da tela executa.
- Título e descrição de convite são tratados como dado, nunca como instrução (qualquer pessoa pode mandar um convite).
- Limites por mensagem (quantos eventos dá para criar, mudar ou apagar) e por dia.
- Login com Google feito no próprio servidor (OAuth 2.0 com PKCE e `state` amarrado a um cookie do navegador), só para e-mails convidados.
- O refresh token do Google fica no SQLite cifrado com AES-256-GCM; o access token, só na memória. O navegador recebe apenas um cookie de sessão aleatório (`HttpOnly; SameSite=Strict; Secure`), e o banco guarda só o hash dele.
- "Sair e desconectar o Google" revoga a autorização no Google e apaga a pessoa, a conversa, os remédios e os avisos.
- CSP restrita, todo texto vindo do Google entra na página por `textContent`, conferência de origem nas rotas que mudam algo.
- Web Push implementado só com `node:crypto` (RFC 8291, `aes128gcm` e JWT VAPID ES256), aceitando apenas os hosts de push dos navegadores.
- Em produção, o serviço systemd roda com usuário próprio, sem sudo e com o sistema de arquivos travado (`deploy/agenda-web.service`).

## Stack

- Node 22+ com TypeScript rodando direto (type stripping do Node), sem build.
- `node:http`, `node:sqlite` e `node:crypto`; a única dependência é o SDK da Anthropic (os outros provedores vão por `fetch`). Para desenvolver, só `typescript` e `@types/node` (checagem de tipos).
- Testes com o `node:test`, sem biblioteca.
- Front-end em HTML, CSS e JavaScript puros (`publico/`).

## Arquivos

| Arquivo | O que faz |
|---|---|
| `servidor.ts` | Servidor HTTP, rotas `/auth/*` e `/app/*`, sessão, cabeçalhos de segurança |
| `auth.ts` | Login com Google, convites, sessões e o refresh token cifrado |
| `admin.ts` | Linha de comando: convidar, tirar convite, listar e apagar pessoas |
| `agenda.ts` | Google Calendar: listar, criar, editar, apagar, marcar feito |
| `chat.ts` | Chat: prompt, ferramentas, travas, confirmação, foto e áudio |
| `ia.ts` | A IA do chat: Anthropic ou API compatível com OpenAI (tradução das mensagens e das ferramentas) |
| `remedios.ts` | Remédios, estoque, doses e relatório |
| `push.ts` | Web Push e a rodada de avisos a cada 5 minutos |
| `funcoes.ts` | Funções ligadas e desligadas por pessoa |
| `demo.ts` | Modo demonstração: visitante sem conta, dados de exemplo e limpeza |
| `calendario-local.ts` | Agenda guardada no SQLite que responde como o Google Calendar (usada pela demonstração) |
| `apagar.ts` | Apagar tudo de uma pessoa (desconectar, `admin.ts apagar`, visitante que saiu) |
| `banco.ts` | SQLite |
| `config.ts` | Leitura dos segredos (variável, arquivo ou credencial do systemd) |
| `publico/` | A página (agenda, chat, remédios) e a política de privacidade |
| `teste/` | Servidor falso (login, Google, Anthropic e API compatível com OpenAI) para rodar tudo no computador com dados fictícios |
| `teste/auto/` | Testes automáticos (`npm test`) |
| `.github/` | CI: testes, tipos, imagem Docker e procura de segredos |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Hospedar com Docker |
| `deploy/` | Caddyfile (HTTPS) e exemplo de serviço systemd |

## Rodar no computador

Não precisa de conta Google nem de chave de API: o `teste/falso.ts` imita o login do Google, o Google Calendar e a API da Anthropic com dados fictícios.

```
npm install
npm run local
```

Depois abra <http://127.0.0.1:8091> (use `127.0.0.1`, não `localhost`) e clique em "Entrar com Google". A tela de login falsa deixa escolher cada caso: a pessoa convidada, alguém sem convite, quem desmarca a permissão da agenda e quem cancela. "Experimentar sem conta" abre o modo demonstração.

## Testes

```
npm test         # unidade e de ponta a ponta
npm run tipos    # checagem de tipos (TypeScript estrito), sem compilar nada
```

- **Unidade**: validação dos eventos e das contas, a agenda local (repetições, exceções, mês sem dia 31, horário de verão), avisos da hora, travas do chat, remédios (estoque, doses, relatório), sessões e o começo do login (PKCE, `state`).
- **Ponta a ponta** (`teste/auto/servidor.test.ts`): sobe o `servidor.ts` de verdade com o `teste/falso.ts` em portas próprias e passa pelo login com Google (convidado, sem convite, sem a permissão da agenda, cancelado), cabeçalhos de segurança, proteção contra CSRF, criar e apagar na agenda, o chat com confirmação e a trava, a demonstração (sem nenhum pedido ao Google), o desconectar (que revoga a autorização) e o chat inteiro com uma IA compatível com OpenAI (ferramentas, foto, confirmação e leitura da caixa passando pela tradução do `ia.ts`).
- Nenhum teste fala com serviço de verdade nem precisa de chave.

O GitHub Actions (`.github/workflows/testes.yml`) roda os testes e os tipos no Node 22 e 24, constrói a imagem Docker e confere o container subindo no modo demonstração, e procura segredos no histórico com o gitleaks.

`teste/trava-ia.ts` é à parte: confere as travas do chat com a IA de verdade (gasta alguns centavos) e só roda à mão.

## Modo demonstração

Com `AGENDA_DEMO=1`, a tela de entrar ganha o botão **Experimentar sem conta**. Cada visitante recebe uma agenda só dele, com contas (uma atrasada, uma vencendo hoje, as do mês passado pagas), compromissos (um convite de outra pessoa, uma série semanal, uma viagem de vários dias) e dois remédios com a última semana de check-in, tudo com datas em volta de hoje.

- Nada vai para o Google: a agenda do visitante fica no SQLite (`calendario-local.ts`), que responde como a API do Google Calendar. Por isso a página, o chat e os avisos usam exatamente o mesmo código de quem entra com Google.
- O visitante dura `AGENDA_DEMO_HORAS` (24 h) e é apagado ao sair. No máximo `AGENDA_DEMO_MAX` visitantes ao mesmo tempo, e 5 entradas por minuto por IP.
- O chat usa a IA configurada, se houver, com limite próprio: `AGENDA_DEMO_CHAT_DIA` mensagens por visitante e `AGENDA_DEMO_CHAT_TOTAL` por dia somando todos (o teto de gasto da demonstração). Sem chave, a demonstração funciona sem o chat.
- Pode rodar junto com o login do Google (convidados entram com Google, o resto experimenta) ou sozinha: sem `AGENDA_GOOGLE_CLIENT_ID`, só aparece o botão da demonstração.

## Hospedar com Docker

Precisa de um servidor com Docker, um domínio apontando para ele e um cliente OAuth do Google (próxima seção).

```
git clone https://github.com/<você>/iagenda.git && cd iagenda
cp .env.example .env          # preencha: AGENDA_SITE, AGENDA_DOMINIO, o cliente do Google e a chave mestra
docker compose --profile https up -d
docker compose exec iagenda node admin.ts convidar fulana@gmail.com
```

O perfil `https` sobe o [Caddy](https://caddyserver.com/) na frente, com certificado automático para `AGENDA_DOMINIO`; nesse caso use `AGENDA_PROXY=1`. Sem o perfil, a IAgenda fica só em `http://127.0.0.1:8091`, para usar atrás do proxy que você já tem.

- Os dados (pessoas, conversas, remédios, chaves dos avisos) ficam no volume `iagenda-dados`. Faça backup dele **e** da `AGENDA_CHAVE_MESTRA`, que fica no `.env`, fora do volume: sem ela, as autorizações guardadas não abrem e todo mundo precisa entrar de novo.
- Atualizar: `git pull && docker compose --profile https up -d --build`.
- O áudio do chat precisa do [whisper.cpp](https://github.com/ggml-org/whisper.cpp), que não vem na imagem. Sem ele, o botão do microfone não aparece e o resto funciona.

Sem Docker, com Node 22.18 ou mais novo: `npm ci --omit=dev`, as mesmas variáveis do `.env.example` e `npm start`. Em `deploy/agenda-web.service` há um exemplo de serviço systemd, com os segredos por `LoadCredential`.

## IA do chat

O chat fala sempre no formato da Messages API da Anthropic; o `ia.ts` manda direto para a Anthropic ou traduz para a API de chat do OpenAI (mensagens, imagens, ferramentas e resultados). O prompt, as ferramentas e as travas são os mesmos para todos, e o servidor confere cada ação da IA do mesmo jeito.

| `AGENDA_IA` | Precisa de | Observação |
|---|---|---|
| `anthropic` (padrão) | `AGENDA_ANTHROPIC_CHAVE` | Modelo padrão `claude-opus-5-5`, com esforço (`AGENDA_ESFORCO`) e cache do prompt |
| `openai` | `AGENDA_IA_CHAVE` (ou `OPENAI_API_KEY`) e `AGENDA_MODELO` | |
| `gemini` | `AGENDA_IA_CHAVE` (ou `GEMINI_API_KEY`) e `AGENDA_MODELO` | Pela API compatível do Gemini |
| `ollama` | `AGENDA_MODELO` | Roda no próprio servidor (`http://127.0.0.1:11434/v1`), sem chave e sem os dados saírem dali |
| `compativel` | `AGENDA_IA_URL` e `AGENDA_MODELO` (chave, se pedir) | OpenRouter, Groq, LM Studio, vLLM... |

`AGENDA_MODELO` é o nome do modelo como o provedor chama. Prefira um modelo bom em uso de ferramentas e que leia imagens (foto de boleto e caixa de remédio): modelo pequeno demais erra mais as ferramentas. Para conferir as travas com a IA escolhida, rode `node teste/trava-ia.ts` com as mesmas variáveis (gasta alguns centavos).

Para testar no computador com um Ollama local: `AGENDA_IA=ollama AGENDA_MODELO=<modelo> npm run local`.

## Login com Google

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative a **Google Calendar API**.
2. Em "Tela de consentimento OAuth", escolha o tipo externo e adicione os escopos `openid`, `email`, `profile` e `.../auth/calendar.events`. Publicado como "Em produção" sem verificação, o app aceita até 100 pessoas (com o aviso de "app não verificado"); em "Teste", o login vence a cada 7 dias.
3. Em "Credenciais", crie um **ID do cliente OAuth** do tipo "Aplicativo da Web", com o URI de redirecionamento `https://SEU-DOMINIO/auth/google/retorno` (para testar no computador, também `http://127.0.0.1:8091/auth/google/retorno`).
4. Configure `AGENDA_SITE`, `AGENDA_GOOGLE_CLIENT_ID` e o segredo do cliente (tabela abaixo).
5. Convide quem pode entrar:

```
node admin.ts convidar fulana@gmail.com
node admin.ts listar
node admin.ts tirar fulana@gmail.com      # fecha as sessões; os dados ficam
node admin.ts apagar fulana@gmail.com     # revoga no Google e apaga tudo da pessoa
```

Ou use `AGENDA_CONVITES=fulana@gmail.com,beltrano@gmail.com` (`*` deixa qualquer conta Google entrar).

Rode o `admin.ts` com as mesmas variáveis do servidor (pelo menos `AGENDA_DADOS` e `AGENDA_CHAVE_MESTRA`), para usar o mesmo banco. No Docker, `docker compose exec iagenda node admin.ts ...` já faz isso.

## Variáveis de ambiente

Os segredos (marcados com 🔑) aceitam três formas: o valor direto (`NOME=...`), um arquivo (`NOME_ARQUIVO=/run/secrets/...`) ou uma credencial do systemd (`LoadCredential`, nome entre parênteses).

| Variável | Padrão | Para quê |
|---|---|---|
| `AGENDA_SITE` | `http://127.0.0.1:8091` | Endereço público: retorno do login e links dos avisos. Com `https://`, o cookie vai com `Secure` |
| `AGENDA_HOST`, `AGENDA_PORTA` | `127.0.0.1`, `8091` | Onde o servidor escuta (`0.0.0.0` no Docker) |
| `AGENDA_PROXY` | `0` | `1` atrás de proxy reverso: o IP do limite de pedidos vem do `X-Forwarded-For` |
| `AGENDA_GOOGLE_CLIENT_ID` | | ID do cliente OAuth do Google |
| `AGENDA_GOOGLE_CLIENT_SECRET` 🔑 | | Segredo do cliente (`google-client-secret`) |
| `AGENDA_CHAVE_MESTRA` 🔑 | gerada em `dados/` | 32 bytes em base64 ou hex (`openssl rand -base64 32`) que cifram as autorizações do Google. Em produção, sempre fora da pasta de dados (`chave-mestra`) |
| `AGENDA_CONVITES` | | E-mails liberados, separados por vírgula (`*` para todos), além dos de `admin.ts convidar` |
| `AGENDA_IA` | `anthropic` | Quem responde no chat: `anthropic`, `openai`, `gemini`, `ollama` ou `compativel` (seção "IA do chat") |
| `AGENDA_ANTHROPIC_CHAVE` 🔑 | `ANTHROPIC_API_KEY` | Chave da API da Anthropic (`anthropic-chave`). Sem chave (e fora do Ollama), o chat fica desligado e a agenda funciona |
| `AGENDA_IA_CHAVE` 🔑 | `OPENAI_API_KEY`, `GEMINI_API_KEY` | Chave dos outros provedores (`ia-chave`) |
| `AGENDA_IA_URL` | do provedor | Endereço da API compatível com OpenAI |
| `AGENDA_MODELO` | `claude-opus-5-5` na Anthropic | Modelo do chat (obrigatório fora da Anthropic) |
| `AGENDA_ESFORCO` | `low` na Anthropic | Esforço de raciocínio (`low`, `medium`, `high`); nos outros, só vai se for definido |
| `AGENDA_CHAT_DIA` | `100` | Mensagens por pessoa por dia |
| `AGENDA_DEMO` | `0` | `1` liga o modo demonstração ("Experimentar sem conta") |
| `AGENDA_DEMO_HORAS` | `24` | Quanto tempo dura cada visitante |
| `AGENDA_DEMO_MAX` | `500` | Visitantes ao mesmo tempo |
| `AGENDA_DEMO_CHAT_DIA`, `AGENDA_DEMO_CHAT_TOTAL` | `15`, `300` | Mensagens do chat por visitante e por dia somando todos os visitantes |
| `AGENDA_WHISPER`, `AGENDA_WHISPER_MODELO` | `/usr/local/bin/whisper-cli` | whisper.cpp e o modelo, para o áudio do chat |
| `AGENDA_DADOS` | `./dados` | Pasta do SQLite e das chaves dos avisos (geradas na primeira vez) |
| `AGENDA_INSEGURO` | pelo `AGENDA_SITE` | `1` força o cookie sem `Secure`; `0` força com |
