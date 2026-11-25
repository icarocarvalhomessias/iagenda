import "./ambiente.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { paraOpenAI, deOpenAI, criarProvedor } from "../../ia.ts";

test("paraOpenAI: sistema (junto no começo), imagem, chamadas e resultados de ferramenta", () => {
  const msgs = paraOpenAI("REGRAS", [
    { role: "user", content: "oi" },
    { role: "assistant", content: "olá" },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }, { type: "text", text: "esse boleto" }] },
    { role: "system", content: "Agora: 2026-12-01" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: "Vou olhar." },
      { type: "tool_use", id: "t1", name: "listar_eventos", input: { de: "2026-12-01", ate: "2026-12-01" } },
      { type: "tool_use", id: "t2", name: "listar_remedios", input: {} },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "t1", content: "{\"eventos\":[]}" },
      { type: "tool_result", tool_use_id: "t2", content: "Remédios desligado", is_error: true },
    ] },
  ]);
  assert.deepEqual(msgs, [
    { role: "system", content: "REGRAS\n\nAgora: 2026-12-01" },
    { role: "user", content: "oi" },
    { role: "assistant", content: "olá" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }, { type: "text", text: "esse boleto" }] },
    { role: "assistant", content: "Vou olhar.", tool_calls: [
      { id: "t1", type: "function", function: { name: "listar_eventos", arguments: "{\"de\":\"2026-12-01\",\"ate\":\"2026-12-01\"}" } },
      { id: "t2", type: "function", function: { name: "listar_remedios", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "t1", content: "{\"eventos\":[]}" },
    { role: "tool", tool_call_id: "t2", content: "ERRO: Remédios desligado" },
  ]);
});

test("deOpenAI: texto, chamadas, argumento quebrado e motivos de parada", () => {
  assert.deepEqual(deOpenAI({ choices: [{ finish_reason: "stop", message: { content: "Pronto." } }] }),
    { content: [{ type: "text", text: "Pronto." }], stop_reason: "end_turn" });
  const r = deOpenAI({ choices: [{ finish_reason: "stop", message: { content: null, tool_calls: [
    { id: "c1", type: "function", function: { name: "marcar_feito", arguments: "{\"id\":\"ev1\",\"feito\":true}" } },
    { id: "c2", type: "function", function: { name: "listar_eventos", arguments: "{quebrado" } },
  ] } }] });
  assert.equal(r.stop_reason, "tool_use");   // mesmo com "stop": valem as chamadas
  assert.deepEqual(r.content, [
    { type: "tool_use", id: "c1", name: "marcar_feito", input: { id: "ev1", feito: true } },
    { type: "tool_use", id: "c2", name: "listar_eventos", input: {} },
  ]);
  assert.equal(deOpenAI({ choices: [{ finish_reason: "length", message: { content: "..." } }] }).stop_reason, "max_tokens");
  assert.equal(deOpenAI({ choices: [{ finish_reason: "content_filter", message: {} }] }).stop_reason, "refusal");
  assert.equal(deOpenAI({ choices: [{ message: { refusal: "não posso" } }] }).stop_reason, "refusal");
  assert.deepEqual(deOpenAI({}), { content: [], stop_reason: "end_turn" });
});

test("criarProvedor: escolha e motivos de ficar desligado", () => {
  const base = { AGENDA_DADOS: process.env.AGENDA_DADOS };
  assert.equal(criarProvedor({ ...base }).motivo, "sem chave");
  const a = criarProvedor({ ...base, AGENDA_ANTHROPIC_CHAVE: "x" }).ia;
  assert.equal(a?.nome, "anthropic");
  assert.equal(a?.modelo, "claude-opus-5-5");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "openai", AGENDA_IA_CHAVE: "x" }).motivo, "falta AGENDA_MODELO");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "openai", AGENDA_MODELO: "m" }).motivo, "sem chave");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "openai", AGENDA_MODELO: "m", OPENAI_API_KEY: "x" }).ia?.nome, "openai");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "gemini", AGENDA_MODELO: "m", GEMINI_API_KEY: "x" }).ia?.nome, "gemini");
  // Ollama roda na própria máquina: dispensa chave.
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "ollama", AGENDA_MODELO: "qwen2.5" }).ia?.nome, "ollama");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "compativel", AGENDA_MODELO: "m" }).motivo, "falta AGENDA_IA_URL");
  assert.equal(criarProvedor({ ...base, AGENDA_IA: "Compativel", AGENDA_MODELO: "m", AGENDA_IA_URL: "http://127.0.0.1:1234/v1/" }).ia?.nome, "compativel");
  assert.match(criarProvedor({ ...base, AGENDA_IA: "skynet" }).motivo, /desconhecida/);
});
