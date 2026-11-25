// agenda-web: a IA do chat, trocável. O chat (chat.ts) fala sempre no formato da Messages API da Anthropic
// (mensagens com blocos text, image, tool_use e tool_result; ferramentas com input_schema); aqui esse formato vai
// direto para a Anthropic ou é traduzido para a API de chat do OpenAI, que OpenAI, Gemini, Ollama e outros
// (OpenRouter, Groq, LM Studio, vLLM...) aceitam.
//
//   AGENDA_IA       anthropic (padrão) | openai | gemini | ollama | compativel
//   AGENDA_MODELO   o modelo, como o provedor chama (na Anthropic, padrão claude-opus-5-5; nos outros, obrigatório)
//   AGENDA_IA_URL   endereço da API compatível (padrão do provedor; obrigatório em "compativel")
//   AGENDA_IA_CHAVE a chave do provedor (no Ollama, dispensável). Na Anthropic também vale AGENDA_ANTHROPIC_CHAVE.
//
// A conversa, as ferramentas e as travas são as mesmas para todos; muda só quem responde. Modelo pequeno demais
// erra mais as ferramentas: o servidor confere cada uma do mesmo jeito, mas a conversa fica pior.
import Anthropic from "@anthropic-ai/sdk";
import { segredo } from "./config.ts";

export type Ferramenta = { name: string; description: string; input_schema: any };
export type Pedido = {
  sistema: string;
  ferramentas: Ferramenta[];
  mensagens: any[];        // formato Anthropic; role "system" no meio da conversa também vale
  maxTokens: number;
  forcar?: string;         // nome da ferramenta que a IA tem de chamar (leitura da caixa de remédio)
};
export type Resultado = {
  content: any[];          // blocos no formato Anthropic: text e tool_use (e thinking, que só a Anthropic usa)
  stop_reason: "end_turn" | "tool_use" | "refusal" | "max_tokens";
  entrada: number;
  saida: number;
};
// chave: a chave foi recusada; ocupada: limite, sobrecarga ou sem conexão (tentar depois); fora: outro erro.
export class ErroIA extends Error {
  tipo: "chave" | "ocupada" | "fora";
  constructor(tipo: "chave" | "ocupada" | "fora", mensagem: string) { super(mensagem); this.tipo = tipo; }
}
export type Provedor = { nome: string; modelo: string; responder(p: Pedido): Promise<Resultado> };

// ---------- Anthropic ----------
function anthropic(chave: string, modelo: string, esforco: string): Provedor {
  const cliente = new Anthropic({ apiKey: chave, baseURL: process.env.AGENDA_ANTHROPIC_URL || undefined, maxRetries: 2, timeout: 90_000 });
  return {
    nome: "anthropic", modelo,
    async responder(p) {
      let r: any;
      try {
        r = p.forcar
          // Ferramenta obrigatória não combina com o raciocínio estendido: chamada simples.
          ? await cliente.messages.create({
            model: modelo, max_tokens: p.maxTokens, system: p.sistema, tools: p.ferramentas as any,
            tool_choice: { type: "tool", name: p.forcar }, messages: p.mensagens,
          } as any)
          : await cliente.beta.messages.create({
            model: modelo, max_tokens: p.maxTokens,
            output_config: { effort: esforco },
            cache_control: { type: "ephemeral" },
            ...(modelo.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
            system: p.sistema, tools: p.ferramentas, messages: p.mensagens,
          } as any);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new ErroIA("chave", "a chave da Anthropic foi recusada");
        if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && (e.status === 529 || (e.status ?? 0) >= 500))) throw new ErroIA("ocupada", `Anthropic ${e.status}`);
        if (e instanceof Anthropic.APIConnectionError) throw new ErroIA("ocupada", "sem conexão com a Anthropic");
        if (e instanceof Anthropic.APIError) throw new ErroIA("fora", `Anthropic ${e.status}: ${e.message.slice(0, 300)}`);
        throw e;
      }
      const u = r.usage ?? {};
      return {
        content: r.content, stop_reason: r.stop_reason,
        entrada: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        saida: u.output_tokens ?? 0,
      };
    },
  };
}

// ---------- compatível com OpenAI (Chat Completions) ----------
const texto = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");

// Formato Anthropic -> mensagens do OpenAI. Exportada para os testes.
export function paraOpenAI(sistema: string, mensagens: any[]): any[] {
  // Mensagem de sistema no meio da conversa (a hora de agora, as funções ligadas) vai para o prompt do começo:
  // nem toda API compatível aceita "system" fora da primeira posição.
  const extras = mensagens.filter((m) => m.role === "system").map((m) => texto(m.content)).filter(Boolean);
  const saida: any[] = [{ role: "system", content: [sistema, ...extras].join("\n\n") }];
  for (const m of mensagens) {
    if (m.role === "system") continue;
    if (typeof m.content === "string") { saida.push({ role: m.role, content: m.content }); continue; }
    const blocos: any[] = m.content ?? [];
    if (m.role === "assistant") {
      const chamadas = blocos.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      saida.push({ role: "assistant", content: texto(blocos) || null, ...(chamadas.length ? { tool_calls: chamadas } : {}) });
      continue;
    }
    // Resultados das ferramentas viram mensagens "tool", uma por chamada.
    for (const b of blocos.filter((x) => x.type === "tool_result")) {
      saida.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "ERRO: " : "") + texto(b.content) });
    }
    const resto = blocos.filter((x) => x.type === "text" || x.type === "image").map((b) => b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    if (resto.length) saida.push({ role: "user", content: resto });
  }
  return saida;
}

// Resposta do OpenAI -> blocos e motivo de parada no formato Anthropic. Exportada para os testes.
export function deOpenAI(j: any): Pick<Resultado, "content" | "stop_reason"> {
  const escolha = j?.choices?.[0] ?? {};
  const msg = escolha.message ?? {};
  if (msg.refusal) return { content: [{ type: "text", text: String(msg.refusal) }], stop_reason: "refusal" };
  const content: any[] = [];
  const t = typeof msg.content === "string" ? msg.content.trim() : texto(msg.content).trim();
  if (t) content.push({ type: "text", text: t });
  for (const c of msg.tool_calls ?? []) {
    if (c?.type && c.type !== "function") continue;
    let input: any = {};
    try { input = JSON.parse(c.function?.arguments || "{}"); } catch { /* argumento quebrado: vai vazio, e o servidor recusa */ }
    content.push({ type: "tool_use", id: String(c.id || `chamada_${content.length}`), name: String(c.function?.name ?? ""), input: input && typeof input === "object" ? input : {} });
  }
  // Alguns provedores mandam "stop" mesmo com chamadas de ferramenta: valem as chamadas.
  const stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use"
    : escolha.finish_reason === "length" ? "max_tokens"
    : escolha.finish_reason === "content_filter" ? "refusal" : "end_turn";
  return { content, stop_reason };
}

function compativel(nome: string, url: string, chave: string, modelo: string): Provedor {
  const esforco = process.env.AGENDA_ESFORCO?.trim();   // só vai se for pedido (nem todo modelo aceita)
  return {
    nome, modelo,
    async responder(p) {
      const corpo: any = {
        model: modelo,
        messages: paraOpenAI(p.sistema, p.mensagens),
        tools: p.ferramentas.map((f) => ({ type: "function", function: { name: f.name, description: f.description, parameters: f.input_schema } })),
        // A API da OpenAI trocou max_tokens por max_completion_tokens; as compatíveis seguem com o antigo.
        [nome === "openai" ? "max_completion_tokens" : "max_tokens"]: p.maxTokens,
        ...(p.forcar ? { tool_choice: { type: "function", function: { name: p.forcar } } } : {}),
        ...(esforco && nome !== "ollama" ? { reasoning_effort: esforco } : {}),
      };
      let r: Response | null = null;
      for (let tentativa = 0; tentativa < 3; tentativa++) {
        try {
          r = await fetch(url + "/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(chave ? { Authorization: `Bearer ${chave}` } : {}) },
            body: JSON.stringify(corpo),
            signal: AbortSignal.timeout(nome === "ollama" ? 180_000 : 90_000),
          });
        } catch {
          if (tentativa === 2) throw new ErroIA("ocupada", `sem conexão com ${url}`);
          await new Promise((ok) => setTimeout(ok, 1000 * (tentativa + 1)));
          continue;
        }
        if (r.status !== 429 && r.status < 500) break;
        if (tentativa < 2) await new Promise((ok) => setTimeout(ok, 1000 * (tentativa + 1)));
      }
      if (!r) throw new ErroIA("ocupada", `sem conexão com ${url}`);
      if (r.status === 401 || r.status === 403) throw new ErroIA("chave", `a chave de ${nome} foi recusada`);
      if (r.status === 429 || r.status >= 500) throw new ErroIA("ocupada", `${nome} ${r.status}`);
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j) throw new ErroIA("fora", `${nome} ${r.status}: ${JSON.stringify(j?.error ?? j ?? "").slice(0, 300)}`);
      return { ...deOpenAI(j), entrada: j.usage?.prompt_tokens ?? 0, saida: j.usage?.completion_tokens ?? 0 };
    },
  };
}

// ---------- escolha pelo ambiente ----------
const URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://127.0.0.1:11434/v1",
};
const CHAVES_DE_SEMPRE: Record<string, string> = { openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };

// O provedor configurado, ou null (chat desligado) com o motivo.
export function criarProvedor(env = process.env): { ia: Provedor | null; motivo: string } {
  const nome = (env.AGENDA_IA ?? "anthropic").trim().toLowerCase();
  const modelo = env.AGENDA_MODELO?.trim() ?? "";
  if (nome === "anthropic") {
    const chave = segredo("AGENDA_IA_CHAVE", "ia-chave", env) || segredo("AGENDA_ANTHROPIC_CHAVE", "anthropic-chave", env) || env.ANTHROPIC_API_KEY?.trim() || "";
    if (!chave) return { ia: null, motivo: "sem chave" };
    return { ia: anthropic(chave, modelo || "claude-opus-5-5", env.AGENDA_ESFORCO?.trim() || "low"), motivo: "" };
  }
  if (!["openai", "gemini", "ollama", "compativel"].includes(nome)) return { ia: null, motivo: `AGENDA_IA desconhecida: ${nome}` };
  const url = (env.AGENDA_IA_URL?.trim() || URLS[nome] || "").replace(/\/$/, "");
  if (!url) return { ia: null, motivo: "falta AGENDA_IA_URL" };
  if (!modelo) return { ia: null, motivo: "falta AGENDA_MODELO" };
  const chave = segredo("AGENDA_IA_CHAVE", "ia-chave", env) || (CHAVES_DE_SEMPRE[nome] ? env[CHAVES_DE_SEMPRE[nome]]?.trim() ?? "" : "");
  if (!chave && nome !== "ollama" && nome !== "compativel") return { ia: null, motivo: "sem chave" };
  return { ia: compativel(nome, url, chave, modelo), motivo: "" };
}
