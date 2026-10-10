import type { MarketInsight } from "./src/types";

export async function generateGrokMarketInsights(
  apiKey: string,
  symbol: string,
  priceData: unknown[]
): Promise<MarketInsight> {
  const model = process.env.GROK_MODEL || "grok-4";
  const candleData = priceData.map((d: unknown) => {
    const row = d as unknown[];
    return { p: row[4], t: row[0] };
  });

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "당신은 전문 암호화폐 분석가입니다. 반드시 유효한 JSON 객체 하나만 응답하고, 마크다운 코드블록은 사용하지 마세요.",
        },
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
    }),
  });

  const responseText = await response.text();
  let payload: any = {};
  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch (e) {
    payload = { message: responseText };
  }

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      payload?.message ||
      responseText ||
      `Grok API error (${response.status})`;
    const error = new Error(`Grok API error (${response.status}): ${message}`);
    (error as any).status = response.status;
    throw error;
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Grok API 응답에서 분석 결과를 찾지 못했습니다.");
  }

  const cleanedText = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(cleanedText);
  } catch (e) {
    const preview = cleanedText.slice(0, 200);
    throw new Error(`Grok 응답을 JSON으로 해석할 수 없습니다: ${preview}`);
  }
  return {
    ...result,
    timestamp: Date.now(),
  } as MarketInsight;
}
