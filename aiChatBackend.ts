import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

export type ChatMessage = { role: "user" | "assistant"; content: string };

function buildSystemPrompt(context?: string): string {
  return [
    "당신은 Binance USD-M 선물 트레이딩 어시스턴트입니다.",
    "한국어로 짧고 명확하게 답하세요. 투자 조언이 아니라 분석·설명 도우미임을 인지하세요.",
    context ? `현재 화면 컨텍스트:\n${context}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function chatWithGemini(
  apiKey: string,
  messages: ChatMessage[],
  context?: string
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const history = messages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  const prompt = `${buildSystemPrompt(context)}\n\n대화:\n${history}\n\nAssistant:`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_CHAT_MODEL || "gemini-3.8-flash",
    contents: prompt,
  });
  const text = (response.text || "").trim();
  if (!text) throw new Error("Gemini 채팅 응답이 비어 있습니다.");
  return text;
}

export async function chatWithClaude(
  apiKey: string,
  messages: ChatMessage[],
  context?: string
): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL || "claude-3-5-haiku-latest";
  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    temperature: 0.4,
    system: buildSystemPrompt(context),
    messages: messages.map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
  });
  const text = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Claude 채팅 응답이 비어 있습니다.");
  return text;
}

export async function chatWithGrok(
  apiKey: string,
  messages: ChatMessage[],
  context?: string
): Promise<string> {
  const model = process.env.GROK_MODEL || "grok-4";
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: buildSystemPrompt(context) },
        ...messages.map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content,
        })),
      ],
    }),
  });
  const responseText = await response.text();
  let payload: any = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Grok 응답 파싱 실패: ${responseText.slice(0, 200)}`);
  }
  if (!response.ok) {
    const err: any = new Error(payload?.error?.message || `Grok chat failed (${response.status})`);
    err.status = response.status;
    throw err;
  }
  const text = payload?.choices?.[0]?.message?.content?.trim?.() || "";
  if (!text) throw new Error("Grok 채팅 응답이 비어 있습니다.");
  return text;
}
