# Contributing

Thanks for wanting to help! Issues and pull requests are welcome, in English or Portuguese.

## Getting started

```
npm install
npm run local    # the app at http://127.0.0.1:8091, with fake Google and fake AI
npm test         # unit and end-to-end tests
npm run tipos    # strict type check
```

Nothing needs a Google account or an API key: `teste/falso.ts` fakes Google sign-in, Google Calendar, Anthropic and an OpenAI-compatible API.

## Guidelines

- **Keep it small.** Node's standard library first; a new dependency needs a strong reason.
- **No build step.** Node runs the `.ts` files directly (type stripping), so use only erasable TypeScript (no `enum`, no `namespace`, no parameter properties). `npm run tipos` checks this.
- **Tests come with the change.** Unit tests in `teste/auto/*.test.ts`; anything that crosses HTTP goes in `teste/auto/servidor.test.ts`. If you touch the chat, the fake AI script in `teste/falso.ts` (`roteiro`) is where new cases go.
- **The chat must stay on a leash.** New tools are checked by the server, never trusted from the AI; deleting or changing many things goes through the on-screen "Confirmar"; text from Google events is data, never instructions.
- **Never commit secrets or personal data.** Use the fake values in `teste/`. CI runs gitleaks on the whole history.
- The app and the code are in Brazilian Portuguese (names, comments, UI). Please keep new code consistent with that.

## Pull requests

1. Fork and create a branch.
2. Make sure `npm test` and `npm run tipos` pass.
3. Describe what changed and how you tested it (a screenshot helps for UI changes).

---

**Português:** contribuições são bem-vindas, em português ou inglês. Rode `npm run local`, `npm test` e `npm run tipos`; mande testes junto com a mudança; nada de segredo ou dado pessoal no código.
