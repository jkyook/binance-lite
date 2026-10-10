import Anthropic from "@anthropic-ai/sdk";
import type { MarketInsight } from "./src/types";

export async function generateClaudeMarketInsights(
  apiKey: string,
  symbol: string,
  priceData: unknown[]
): Promise<MarketInsight> {
  const anthropic = new Anthropic({ apiKey });
  const model = process.env.CLAUDE_MODEL || "claude-3-5-haiku-latest";

  const candleData = priceData.map((d: unknown) => {
    const row = d as unknown[];
    return { p: row[4], t: row[0] };
  });

  const response = await anthropic.messages.create({
    model,
    max_tokens: 800,
    temperature: 0.2,
    system:
      "당신은 전문 암호화폐 분석가입니다. 반드시 유효한 JSON 객체 하나만 응답하고, 마크다운 코드블록은 사용하지 마세요.",
    messages: [
      {
        role: "user",
        content: `다음 ${symbol}의 가격 데이터를 분석하여 한국어로 시장 인사이트를 제공하세요.
가격 데이터 (최근 24개 캔들): ${JSON.stringify(candleData)}

응답은 반드시 다음 JSON 형식을 따라야 합니다:
{
  "trend": "bullish" | "bearish" | "neutral",
  "sentiment": "시장 감정 설명 (한국어)",
  "keyLevels": { "support": ["가격1", "가격2"], "resistance": ["가격1", "가격2"] },
  "summary": "현재 상황에 대한 짧은 2문장 요약 (한국어)"
}`,
      },
    ],
  });

  const text = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text);
  } catch (e) {
    const preview = text.slice(0, 200);
    throw new Error(`Claude 응답을 JSON으로 해석할 수 없습니다: ${preview}`);
  }
  return {
    ...result,
    timestamp: Date.now(),
  } as MarketInsight;
}
