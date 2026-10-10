import { MarketInsight } from "../types";

export type AiProvider = "gemini" | "claude" | "grok";

export type AiChatMessage = { role: "user" | "assistant"; content: string };

export async function getMarketInsights(
  symbol: string,
  priceData: any[],
  provider?: AiProvider
): Promise<MarketInsight> {
  const res = await fetch("/api/ai/market-insights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, priceData, provider }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & Partial<MarketInsight>;
  if (!res.ok) {
    // 402: 크레딧 부족 – 사용자에게 직접 안내
    if (res.status === 402) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : "AI API 크레딧이 부족합니다. .env에서 GEMINI_API_KEY 또는 CLAUDE_API_KEY를 확인하세요."
      );
    }
    throw new Error(
      typeof data.error === "string" ? data.error : `AI 분석 요청 실패 (${res.status})`
    );
  }
  return data as MarketInsight;
}

export async function sendAiChat(
  messages: AiChatMessage[],
  opts?: { provider?: AiProvider; context?: string; symbol?: string }
): Promise<string> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      provider: opts?.provider,
      context: opts?.context,
      symbol: opts?.symbol,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; reply?: string };
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : `AI 채팅 실패 (${res.status})`
    );
  }
  if (!data.reply) throw new Error("AI 채팅 응답이 비어 있습니다.");
  return data.reply;
}
