import { GoogleGenAI, Type } from "@google/genai";
import type { MarketInsight } from "./src/types";

export async function generateMarketInsights(
  apiKey: string,
  symbol: string,
  priceData: unknown[]
): Promise<MarketInsight> {
  const ai = new GoogleGenAI({ apiKey });

  const prompt = `당신은 전문 암호화폐 분석가입니다. 다음 ${symbol}의 가격 데이터를 분석하여 한국어로 시장 인사이트를 제공하세요.
  가격 데이터 (최근 24개 캔들): ${JSON.stringify(
    priceData.map((d: unknown) => {
      const row = d as unknown[];
      return { p: row[4], t: row[0] };
    })
  )}
  
  응답은 반드시 다음 JSON 형식을 따라야 합니다:
  {
    "trend": "bullish" | "bearish" | "neutral",
    "sentiment": "시장 감정 설명 (한국어)",
    "keyLevels": { "support": ["가격1", "가격2"], "resistance": ["가격1", "가격2"] },
    "summary": "현재 상황에 대한 짧은 2문장 요약 (한국어)"
  }`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_CHAT_MODEL || "gemini-3.8-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          trend: { type: Type.STRING, enum: ["bullish", "bearish", "neutral"] },
          sentiment: { type: Type.STRING, description: "시장 상태에 대한 한국어 설명" },
          keyLevels: {
            type: Type.OBJECT,
            properties: {
              support: { type: Type.ARRAY, items: { type: Type.STRING }, description: "주요 지지 가격대" },
              resistance: { type: Type.ARRAY, items: { type: Type.STRING }, description: "주요 저항 가격대" },
            },
            required: ["support", "resistance"],
          },
          summary: { type: Type.STRING, description: "한국어 요약 텍스트" },
        },
        required: ["trend", "sentiment", "keyLevels", "summary"],
      },
    },
  });

  const raw = response.text || "{}";
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(raw);
  } catch (e) {
    const preview = raw.slice(0, 200);
    throw new Error(`Gemini 응답을 JSON으로 해석할 수 없습니다: ${preview}`);
  }
  return {
    ...result,
    timestamp: Date.now(),
  } as MarketInsight;
}
