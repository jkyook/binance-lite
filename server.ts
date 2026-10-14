import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
import { z } from "zod";
import { generateClaudeMarketInsights } from "./claudeInsightsBackend";
import { generateMarketInsights as generateGeminiMarketInsights } from "./geminiInsightsBackend";
import { generateGrokMarketInsights } from "./grokInsightsBackend";
import { chatWithClaude, chatWithGemini, chatWithGrok, type ChatMessage } from "./aiChatBackend";

dotenv.config();

// systemd 환경변수가 .env보다 먼저 있으면 dotenv는 덮어쓰지 않는다.
// 그 경우 오래된 XAI_API_KEY가 남아 Grok이 400(Incorrect API key)을 반환한다.
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    for (const name of ["XAI_API_KEY", "GROK_MODEL", "GEMINI_API_KEY", "CLAUDE_API_KEY", "AI_PROVIDER"]) {
      const fromFile = parsed[name];
      if (!fromFile) continue;
      if (process.env[name] !== fromFile) {
        console.warn(
          `[Server Init] ${name} process env differs from .env; using .env`
        );
        process.env[name] = fromFile;
      }
    }
  }
} catch (err) {
  console.warn("[Server Init] .env reparse skipped", err);
}

// 주문 입력 검증 스키마 — symbol/quantity/side/type 정합성 강제
const SymbolSchema = z
  .string()
  .trim()
  .min(1, "symbol은 비어 있을 수 없습니다.")
  .transform(s => s.toUpperCase())
  .refine(s => /^[A-Z0-9]+$/.test(s), {
    message: "symbol은 영문 대문자/숫자만 허용됩니다.",
  });

const QuantitySchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quantity는 0보다 큰 유한한 숫자여야 합니다.",
      });
      return z.NEVER;
    }
    return n;
  });

const PriceSchema = z
  .union([z.number(), z.string()])
  .transform((v, ctx) => {
    const s = (typeof v === "number" ? v.toString() : String(v)).trim();
    if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "price는 0보다 큰 유한한 숫자여야 합니다.",
      });
      return z.NEVER;
    }
    return s;
  });

const OrderSchema = z
  .object({
    symbol: SymbolSchema,
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["MARKET", "LIMIT"]),
    quantity: QuantitySchema,
    price: PriceSchema.optional(),
    reduceOnly: z.union([z.boolean(), z.string()]).optional(),
  })
  .superRefine((order, ctx) => {
    if (order.type === "LIMIT" && order.price === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["price"],
        message: "LIMIT 주문에는 price가 필수입니다.",
      });
    }
  });

const BatchOrderSchema = z.object({
  orders: z.array(OrderSchema).min(1, "orders는 최소 1건 이상이어야 합니다."),
});

const TelegramSendSchema = z.object({
  text: z.string().trim().min(1, "text는 비어 있을 수 없습니다.").max(3900, "텔레그램 메시지는 3900자 이하로 보내주세요."),
});

const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
function readSecret(name: string): string {
  let raw = (process.env[name] || "").trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return raw;
}
const ORDER_PIN = readSecret("ORDER_PIN");
const BASE_URL = "https://fapi.binance.com";
const SPOT_BASE_URL = "https://api.binance.com";
const BAN_FILE = path.join(process.cwd(), "data", "binance_ban_until");

function readPersistedBanUntil(): number {
  const fromEnv = Number(process.env.BINANCE_BAN_UNTIL || 0);
  try {
    if (fs.existsSync(BAN_FILE)) {
      const n = Number(fs.readFileSync(BAN_FILE, "utf8").trim());
      if (Number.isFinite(n) && n > Date.now()) return Math.max(n, fromEnv || 0);
    }
  } catch {
    /* ignore */
  }
  return Number.isFinite(fromEnv) && fromEnv > Date.now() ? fromEnv : 0;
}

function persistBanUntil(until: number) {
  try {
    fs.mkdirSync(path.dirname(BAN_FILE), { recursive: true });
    fs.writeFileSync(BAN_FILE, String(until), "utf8");
  } catch (e) {
    console.warn("[Ban] persist failed:", (e as Error).message);
  }
}

let binanceBanUntil = readPersistedBanUntil();
if (binanceBanUntil > Date.now()) {
  console.warn(
    "[Server Init] Binance IP ban until",
    new Date(binanceBanUntil).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
    "KST (persisted)"
  );
}
let spotTickerCache: { at: number; map: Record<string, number> } | null = null;
let bookTickerCache: {
  at: number;
  map: Record<string, { bidPrice: string; askPrice: string }>;
} | null = null;
const BOOK_TICKER_CACHE_MS = 2_000;
let walletOverviewCache: { at: number; data: any } | null = null;
let walletDetailsCache: { at: number; data: any } | null = null;
const WALLET_OVERVIEW_CACHE_MS = 180_000; // 3분
const WALLET_DETAILS_CACHE_MS = 180_000;
const WALLET_DETAIL_GAP_MS = 450; // 상세 API 사이 간격 (IP 제한 완화)
let trades24hCache: { at: number; data: any } | null = null;
const TRADES_24H_CACHE_MS = 120_000; // 2분 — userTrades 심볼 순차 호출 보호

const DEFAULT_JUPITER_WALLET = "8nX7ULNGGapgbYrJzFsgKyPYog8jXtKREcWEMyvSjZG9";
const JUPITER_WALLET = (process.env.JUPITER_WALLET || DEFAULT_JUPITER_WALLET).trim();
const JUPITER_PORTFOLIO_CACHE_MS = 60_000;
let jupiterPortfolioCache: { at: number; data: any } | null = null;
const jupiterSymbolCache: Record<string, string> = {
  "11111111111111111111111111111111": "SOL",
  So11111111111111111111111111111111111111112: "SOL",
};
const JUPITER_PLATFORM_NAMES: Record<string, string> = {
  "wallet-tokens": "Holdings",
  "jupiter-exchange": "Jupiter",
  "jupiter-governance": "Jupiter DAO",
  orca: "Orca",
  raydium: "Raydium",
  "native-stake": "Validators",
};

console.log("[Server Init] BINANCE_API_KEY is", BINANCE_API_KEY ? "CONFIGURED" : "MISSING");
console.log("[Server Init] BINANCE_API_SECRET is", BINANCE_API_SECRET ? "CONFIGURED" : "MISSING");
console.log("[Server Init] GEMINI_API_KEY is", process.env.GEMINI_API_KEY ? "CONFIGURED" : "MISSING");
console.log("[Server Init] CLAUDE_API_KEY is", process.env.CLAUDE_API_KEY ? "CONFIGURED" : "MISSING");
console.log("[Server Init] XAI_API_KEY is", process.env.XAI_API_KEY ? "CONFIGURED" : "MISSING");
console.log("[Server Init] TELEGRAM_BOT_TOKEN is", TELEGRAM_BOT_TOKEN ? "CONFIGURED" : "MISSING");
console.log("[Server Init] TELEGRAM_CHAT_ID is", TELEGRAM_CHAT_ID ? "CONFIGURED" : "MISSING");
console.log("[Server Init] JUPITER_WALLET is", JUPITER_WALLET ? JUPITER_WALLET.slice(0, 4) + "…" + JUPITER_WALLET.slice(-4) : "MISSING");
console.log("[Server Init] ORDER_PIN is", ORDER_PIN ? "CONFIGURED" : "MISSING — orders blocked");

let lastKnownIp = "unknown";
fetch("https://api.ipify.org?format=json")
  .then(res => res.json())
  .then(data => {
    lastKnownIp = data.ip;
    console.log("[Server Init] External IP:", lastKnownIp);
  })
  .catch(() => console.warn("[Server Init] Could not determine external IP"));

function jupiterPlatformName(id: string): string {
  if (JUPITER_PLATFORM_NAMES[id]) return JUPITER_PLATFORM_NAMES[id];
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function jupiterTokenQty(amount: any): number {
  if (!amount || typeof amount !== "object") return 0;
  const raw = Number(amount.raw);
  const decimals = Number(amount.decimals ?? 0);
  if (!Number.isFinite(raw) || !Number.isFinite(decimals)) return 0;
  return raw / Math.pow(10, decimals);
}

function jupiterTokenRows(
  list: any[] | undefined,
  side: "balance" | "stake" | "supply" | "borrow" | "reward"
): Array<{ mint: string; qty: number; usd: number; side: string }> {
  if (!Array.isArray(list)) return [];
  const rows: Array<{ mint: string; qty: number; usd: number; side: string }> = [];
  for (const item of list) {
    const data = item?.data || {};
    const mint = String(data.address || "");
    const usd = Number(item?.value);
    const qty = jupiterTokenQty(data.amount);
    if (!mint || !Number.isFinite(usd)) continue;
    if (Math.abs(usd) < 0.01 && Math.abs(qty) < 1e-9) continue;
    rows.push({ mint, qty, usd, side });
  }
  return rows;
}

async function lookupJupiterSymbols(mints: string[]): Promise<void> {
  const missing = Array.from(new Set(mints.filter((mint) => mint && !jupiterSymbolCache[mint])));
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const url = `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(chunk.join(","))}`;
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const rows = await response.json();
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const id = String(row?.id || row?.address || "");
        const symbol = String(row?.symbol || "").trim();
        if (id && symbol) jupiterSymbolCache[id] = symbol;
      }
    } catch (err: any) {
      console.warn("[Jupiter] symbol lookup failed:", err?.message || err);
    }
  }
}

function requireOrderPin(req: express.Request, res: express.Response): boolean {
  if (!ORDER_PIN) {
    res.status(503).json({ error: "ORDER_PIN이 설정되지 않아 주문이 차단되었습니다." });
    return false;
  }
  const given = String(req.get("x-order-pin") || "");
  const a = Buffer.from(given);
  const b = Buffer.from(ORDER_PIN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: "주문 비밀번호가 올바르지 않습니다." });
    return false;
  }
  return true;
}

async function fetchJupiterPortfolio() {
  const url = `https://api.jup.ag/portfolio/v2/positions/${encodeURIComponent(JUPITER_WALLET)}?unpriced=false`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      origin: "https://jup.ag",
      referer: "https://jup.ag/",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    const error: any = new Error(`Jupiter portfolio ${response.status}: ${text.slice(0, 180)}`);
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  const payload = await response.json();
  const groups = new Map<
    string,
    {
      id: string;
      name: string;
      usd: number;
      rows: Array<{ mint: string; qty: number; usd: number; side: string }>;
    }
  >();

  for (const fetcher of payload?.fetcherResults || []) {
    for (const element of fetcher?.elements || []) {
      const usd = Number(element?.value);
      if (!Number.isFinite(usd) || Math.abs(usd) < 0.01) continue;
      const id = String(element.platformId || fetcher.id || "other");
      let group = groups.get(id);
      if (!group) {
        group = { id, name: jupiterPlatformName(id), usd: 0, rows: [] };
        groups.set(id, group);
      }
      group.usd += usd;
      const data = element.data || {};
      const supply = jupiterTokenRows(data.suppliedAssets, "supply");
      const borrow = jupiterTokenRows(data.borrowedAssets, "borrow");
      const reward = jupiterTokenRows(data.rewardAssets, "reward").filter((row) => Math.abs(row.usd) >= 1);
      if (supply.length || borrow.length) {
        group.rows.push(...supply, ...borrow, ...reward);
      } else {
        const side = element.label === "Staked" ? "stake" : "balance";
        group.rows.push(...jupiterTokenRows(data.assets, side), ...reward);
      }
    }
  }

  await lookupJupiterSymbols(
    Array.from(groups.values()).flatMap((group) => group.rows.map((row) => row.mint))
  );

  const summarized = Array.from(groups.values())
    .map((group) => {
      const merged = new Map<string, { symbol: string; qty: number; usd: number; side: string }>();
      for (const row of group.rows) {
        const key = `${row.side}:${row.mint}`;
        const symbol = jupiterSymbolCache[row.mint] || `${row.mint.slice(0, 4)}…`;
        const prev = merged.get(key);
        if (prev) {
          prev.qty += row.qty;
          prev.usd += row.usd;
        } else {
          merged.set(key, { symbol, qty: row.qty, usd: row.usd, side: row.side });
        }
      }
      return {
        id: group.id,
        name: group.name,
        usd: group.usd,
        rows: Array.from(merged.values()).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)),
      };
    })
    .filter((group) => Math.abs(group.usd) >= 0.01)
    .sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));

  return {
    address: JUPITER_WALLET,
    quote: "USD",
    totalUsd: summarized.reduce((sum, group) => sum + group.usd, 0),
    groups: summarized,
    updatedAt: Date.now(),
    cached: false,
    note: "Jupiter portfolio USD. Not included in Binance collateral.",
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Use JSON middleware at the top level
  app.use(express.json());

  // Logging middleware
  app.use((req, res, next) => {
    if (req.url.startsWith("/api")) {
      console.log(`[Incoming Request] ${req.method} ${req.url}`);
    }
    next();
  });

  const sendApiError = (res: express.Response, err: any) => {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    res.status(status).json({
      error: err?.message || "API request failed",
      ...(err?.banUntil ? { banUntil: err.banUntil } : {}),
    });
  };

  // AI 라우트는 Router보다 먼저 등록 (구버전 프로세스·라우팅 이슈 방지)
  app.post("/api/ai/market-insights", async (req, res) => {
    try {
      const { symbol, priceData } = req.body ?? {};
      if (!symbol || typeof symbol !== "string" || !Array.isArray(priceData)) {
        res.status(400).json({ error: "요청 본문에 symbol(문자열)과 priceData(배열)가 필요합니다." });
        return;
      }

      const sym = symbol.trim();
      const provider = selectAiProvider(req.body?.provider);

      // Helper: billing/quota errors can fall back to another configured provider.
      const isBillingError = (err: any) =>
        err?.status === 402 ||
        err?.status === 429 ||
        /credit balance|insufficient.*(credit|fund)|quota|billing|rate limit/i.test(err?.message ?? "");

      let insight;
      if (provider === "claude") {
        try {
          insight = await generateClaudeMarketInsights(requireEnv("CLAUDE_API_KEY"), sym, priceData);
        } catch (claudeErr: any) {
          if (isBillingError(claudeErr) && process.env.GEMINI_API_KEY) {
            // Claude 크레딧 부족 → Gemini로 자동 전환
            console.warn("[AI] Claude 크레딧 부족 – Gemini로 전환합니다.");
            insight = await generateGeminiMarketInsights(requireEnv("GEMINI_API_KEY"), sym, priceData);
          } else if (isBillingError(claudeErr)) {
            res.status(402).json({
              error: "Claude API 크레딧이 부족합니다. Anthropic Plans & Billing에서 크레딧을 충전하거나, .env에 GEMINI_API_KEY를 설정하세요."
            });
            return;
          } else {
            throw claudeErr;
          }
        }
      } else if (provider === "grok") {
        try {
          insight = await generateGrokMarketInsights(requireEnv("XAI_API_KEY"), sym, priceData);
        } catch (grokErr: any) {
          if (isBillingError(grokErr) && process.env.GEMINI_API_KEY) {
            console.warn("[AI] Grok 크레딧 부족 – Gemini로 전환합니다.");
            insight = await generateGeminiMarketInsights(requireEnv("GEMINI_API_KEY"), sym, priceData);
          } else if (isBillingError(grokErr) && process.env.CLAUDE_API_KEY) {
            console.warn("[AI] Grok 크레딧 부족 – Claude로 전환합니다.");
            insight = await generateClaudeMarketInsights(requireEnv("CLAUDE_API_KEY"), sym, priceData);
          } else if (isBillingError(grokErr)) {
            res.status(402).json({
              error: "Grok API 크레딧 또는 사용량 한도가 부족합니다. xAI Console에서 결제/한도를 확인하거나, .env에 GEMINI_API_KEY 또는 CLAUDE_API_KEY를 설정하세요."
            });
            return;
          } else {
            throw grokErr;
          }
        }
      } else {
        try {
          insight = await generateGeminiMarketInsights(requireEnv("GEMINI_API_KEY"), sym, priceData);
        } catch (geminiErr: any) {
          if (isBillingError(geminiErr) && process.env.CLAUDE_API_KEY) {
            console.warn("[AI] Gemini 크레딧 부족 – Claude로 전환합니다.");
            insight = await generateClaudeMarketInsights(requireEnv("CLAUDE_API_KEY"), sym, priceData);
          } else {
            throw geminiErr;
          }
        }
      }

      res.json(insight);
    } catch (err: any) {
      console.error("[AI market-insights]", err);
      const status = err.message?.includes("환경변수") ? 503 : 500;
      res.status(status).json({ error: err.message || "AI 분석에 실패했습니다." });
    }
  });

  app.post("/api/ai/chat", async (req, res) => {
    try {
      const { messages, context, symbol } = req.body ?? {};
      if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: "messages 배열이 필요합니다." });
        return;
      }
      const normalized: ChatMessage[] = messages
        .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 8000) }))
        .slice(-20);
      if (normalized.length === 0 || normalized[normalized.length - 1].role !== "user") {
        res.status(400).json({ error: "마지막 메시지는 user여야 합니다." });
        return;
      }

      const provider = selectAiProvider(req.body?.provider);
      const ctx = [
        typeof symbol === "string" ? `심볼: ${symbol}` : "",
        typeof context === "string" ? context.slice(0, 4000) : "",
      ]
        .filter(Boolean)
        .join("\n");

      const isBillingError = (err: any) =>
        err?.status === 402 ||
        err?.status === 429 ||
        /credit balance|insufficient.*(credit|fund)|quota|billing|rate limit/i.test(err?.message ?? "");

      let reply = "";
      const run = async (p: "gemini" | "claude" | "grok") => {
        if (p === "claude") return chatWithClaude(requireEnv("CLAUDE_API_KEY"), normalized, ctx);
        if (p === "grok") return chatWithGrok(requireEnv("XAI_API_KEY"), normalized, ctx);
        return chatWithGemini(requireEnv("GEMINI_API_KEY"), normalized, ctx);
      };

      const fallbackOrder: Array<"gemini" | "claude" | "grok"> = ["gemini", "claude", "grok"].filter(
        (p) => p !== provider
      ) as Array<"gemini" | "claude" | "grok">;

      try {
        reply = await run(provider);
      } catch (err: any) {
        if (!isBillingError(err)) throw err;
        let lastErr: any = err;
        let ok = false;
        for (const alt of fallbackOrder) {
          const hasKey =
            (alt === "gemini" && process.env.GEMINI_API_KEY) ||
            (alt === "claude" && process.env.CLAUDE_API_KEY) ||
            (alt === "grok" && process.env.XAI_API_KEY);
          if (!hasKey) continue;
          try {
            console.warn(`[AI chat] ${provider} 한도 – ${alt}로 전환`);
            reply = await run(alt);
            ok = true;
            break;
          } catch (e2: any) {
            lastErr = e2;
            if (!isBillingError(e2)) throw e2;
          }
        }
        if (!ok) {
          res.status(402).json({
            error:
              "AI API 크레딧/한도가 부족합니다. Gemini(AI Studio)·Claude·Grok 중 하나 이상을 충전하거나 .env 키를 확인하세요.",
          });
          return;
        }
        void lastErr;
      }

      res.json({ reply });
    } catch (err: any) {
      console.error("[AI chat]", err);
      const status = err.message?.includes("환경변수") ? 503 : 500;
      res.status(status).json({ error: err.message || "AI 채팅에 실패했습니다." });
    }
  });

  const apiRouter = express.Router();

  apiRouter.get("/health", async (req, res) => {
    try {
      const ipRes = await fetch("https://api.ipify.org?format=json");
      const ipData = await ipRes.json().catch(() => ({ ip: lastKnownIp }));
      res.json({ status: "ok", ip: ipData.ip });
    } catch (e) {
      res.json({ status: "ok", ip: lastKnownIp });
    }
  });

  apiRouter.get("/telegram/status", async (req, res) => {
    res.json({
      configured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
      hasBotToken: Boolean(TELEGRAM_BOT_TOKEN),
      hasChatId: Boolean(TELEGRAM_CHAT_ID),
    });
  });

  apiRouter.get("/telegram/updates", async (req, res) => {
    try {
      const data = await telegramRequest("getUpdates");
      const chats = Array.isArray(data?.result)
        ? data.result
            .map((update: any) => update.message?.chat || update.channel_post?.chat)
            .filter(Boolean)
            .map((chat: any) => ({
              id: chat.id,
              type: chat.type,
              title: chat.title,
              username: chat.username,
              firstName: chat.first_name,
              lastName: chat.last_name,
            }))
        : [];
      res.json({ chats });
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.post("/telegram/send", async (req, res) => {
    const parsed = TelegramSendSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`);
      res.status(400).json({ error: `요청 검증 실패: ${issues.join("; ")}` });
      return;
    }

    try {
      const data = await telegramRequest("sendMessage", {
        chat_id: requireTelegramChatId(),
        text: parsed.data.text,
        disable_web_page_preview: true,
      });
      res.json({ ok: true, messageId: data?.result?.message_id });
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.post("/futures/batch-order", async (req, res) => {
    if (!requireOrderPin(req, res)) return;
    console.log("[Route Hit] POST /api/futures/batch-order");
    const parsed = BatchOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`);
      res.status(400).json({ error: `요청 검증 실패: ${issues.join("; ")}` });
      return;
    }
    try {
      const normalizedOrders = parsed.data.orders.map(o => {
        const out: Record<string, unknown> = {
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          quantity: o.quantity.toString(),
        };
        if (o.price !== undefined) out.price = o.price;
        if (o.type === "LIMIT") out.timeInForce = "GTC";
        if (o.reduceOnly !== undefined) out.reduceOnly = o.reduceOnly.toString();
        return out;
      });

      const params: Record<string, string> = {
        batchOrders: JSON.stringify(normalizedOrders),
      };

      const data = await binanceRequest("/fapi/v1/batchOrders", "POST", params);
      res.json(data);
    } catch (err: any) {
      console.error("[Batch Order Error]", err.message);
      sendApiError(res, err);
    }
  });

  apiRouter.post("/futures/order", async (req, res) => {
    if (!requireOrderPin(req, res)) return;
    console.log("[Route Hit] POST /api/futures/order");
    const parsed = OrderSchema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`);
      res.status(400).json({ error: `요청 검증 실패: ${issues.join("; ")}` });
      return;
    }
    try {
      const { symbol, side, type, quantity, reduceOnly, price } = parsed.data;
      const params: Record<string, string> = {
        symbol,
        side,
        type,
        quantity: quantity.toString(),
      };
      if (reduceOnly !== undefined) params.reduceOnly = reduceOnly.toString();
      if (price !== undefined) params.price = price;
      if (type === "LIMIT") params.timeInForce = "GTC";

      const data = await binanceRequest("/fapi/v1/order", "POST", params);
      res.json(data);
    } catch (err: any) {
      console.error("[Order Error]", err.message);
      sendApiError(res, err);
    }
  });

  apiRouter.delete("/futures/order", async (req, res) => {
    if (!requireOrderPin(req, res)) return;
    console.log("[Route Hit] DELETE /api/futures/order");
    try {
      const { symbol, orderId } = req.body;
      if (!symbol || !orderId) {
        res.status(400).json({ error: "symbol과 orderId가 필요합니다." });
        return;
      }

      const params: Record<string, string> = {
        symbol: symbol.toString().trim().toUpperCase(),
        orderId: orderId.toString(),
      };

      const data = await binanceRequest("/fapi/v1/order", "DELETE", params);
      res.json(data);
    } catch (err: any) {
      console.error("[Cancel Order Error]", err.message);
      sendApiError(res, err);
    }
  });

  apiRouter.post("/futures/cancel-order", async (req, res) => {
    if (!requireOrderPin(req, res)) return;
    console.log("[Route Hit] POST /api/futures/cancel-order");
    try {
      const { symbol, orderId } = req.body;
      if (!symbol || !orderId) {
        res.status(400).json({ error: "symbol과 orderId가 필요합니다." });
        return;
      }

      const params: Record<string, string> = {
        symbol: symbol.toString().trim().toUpperCase(),
        orderId: orderId.toString(),
      };

      const data = await binanceRequest("/fapi/v1/order", "DELETE", params);
      res.json(data);
    } catch (err: any) {
      console.error("[Cancel Order Error]", err.message);
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/account", async (req, res) => {
    try {
      const data = await binanceRequest("/fapi/v2/account");
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/positions", async (req, res) => {
    try {
      const data = await binanceRequest("/fapi/v2/positionRisk");
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/open-orders", async (req, res) => {
    try {
      const data = await binanceRequest("/fapi/v1/openOrders");
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/trades", async (req, res) => {
    try {
      const { symbol, startTime, endTime, limit } = req.query;
      const params: Record<string, string> = {};
      if (symbol) params.symbol = symbol as string;
      if (startTime) params.startTime = startTime as string;
      if (endTime) params.endTime = endTime as string;
      if (limit) params.limit = limit as string;
      const data = await binanceRequest("/fapi/v1/userTrades", "GET", params);
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  /** 지난 24시간 선물 체결 매수/매도 합계 — 심볼 순차 조회, 2분 캐시 */
  apiRouter.get("/futures/trades-24h", async (req, res) => {
    try {
      const force = String(req.query.refresh || "") === "1";
      if (!force && trades24hCache && Date.now() - trades24hCache.at < TRADES_24H_CACHE_MS) {
        res.json({ ...trades24hCache.data, cached: true });
        return;
      }

      const endTime = Date.now();
      const startTime = endTime - 24 * 60 * 60 * 1000;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const collectIncomeSymbols = async (incomeType: string) => {
        const found = new Set<string>();
        let windowStart = startTime;
        let windowEnd = endTime;
        for (let page = 0; page < 8; page++) {
          const rows = await binanceRequest("/fapi/v1/income", "GET", {
            incomeType,
            startTime: String(windowStart),
            endTime: String(windowEnd),
            limit: "1000",
          });
          const list = Array.isArray(rows) ? rows : [];
          for (const row of list) {
            if (row?.symbol) found.add(String(row.symbol));
          }
          if (list.length < 1000) break;
          const times = list.map((r: any) => Number(r.time) || 0).filter((n: number) => n > 0);
          if (!times.length) break;
          const newestFirst = (Number(list[0]?.time) || 0) >= (Number(list[list.length - 1]?.time) || 0);
          if (newestFirst) {
            windowEnd = Math.min(...times) - 1;
          } else {
            windowStart = Math.max(...times) + 1;
          }
          if (windowEnd <= windowStart) break;
          await sleep(120);
        }
        return found;
      };

      const symbols = new Set<string>();
      for (const incomeType of ["COMMISSION", "REALIZED_PNL"]) {
        try {
          const found = await collectIncomeSymbols(incomeType);
          for (const s of found) symbols.add(s);
        } catch (e: any) {
          console.warn(`[trades-24h] income ${incomeType} failed:`, e?.message || e);
        }
      }

      const symbolList = Array.from(symbols).filter(Boolean);
      const mapped: Array<{
        symbol: string;
        id: number;
        orderId: number;
        side: "BUY" | "SELL";
        price: number;
        qty: number;
        quoteQty: number;
        time: number;
        realizedPnl: number;
      }> = [];
      const seenTrade = new Set<string>();

      for (let i = 0; i < symbolList.length; i++) {
        const symbol = symbolList[i];
        try {
          let fromId: string | undefined;
          for (let page = 0; page < 10; page++) {
            const params: Record<string, string> = {
              symbol,
              startTime: String(startTime),
              endTime: String(endTime),
              limit: "1000",
            };
            if (fromId) params.fromId = fromId;
            const raw = await binanceRequest("/fapi/v1/userTrades", "GET", params);
            const list = Array.isArray(raw) ? raw : [];
            for (const t of list) {
              const id = Number(t.id) || 0;
              const key = `${t.symbol || symbol}:${id}`;
              if (seenTrade.has(key)) continue;
              seenTrade.add(key);
              const price = parseFloat(t.price || "0") || 0;
              const qty = parseFloat(t.qty || "0") || 0;
              const quoteQty = parseFloat(t.quoteQty || "") || price * qty;
              const side = String(t.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
              mapped.push({
                symbol: String(t.symbol || symbol),
                id,
                orderId: Number(t.orderId) || 0,
                side,
                price,
                qty,
                quoteQty,
                time: Number(t.time) || 0,
                realizedPnl: parseFloat(t.realizedPnl || "0") || 0,
              });
            }
            if (list.length < 1000) break;
            const maxId = Math.max(...list.map((t: any) => Number(t.id) || 0));
            if (!Number.isFinite(maxId) || maxId <= 0) break;
            fromId = String(maxId + 1);
            await sleep(120);
          }
        } catch (e: any) {
          console.warn(`[trades-24h] ${symbol} failed:`, e?.message || e);
        }
        if (i < symbolList.length - 1) await sleep(120);
      }

      mapped.sort((a, b) => b.time - a.time);
      const buy = mapped.filter((t) => t.side === "BUY");
      const sell = mapped.filter((t) => t.side === "SELL");
      const data = {
        startTime,
        endTime,
        buyUsd: buy.reduce((s, t) => s + t.quoteQty, 0),
        sellUsd: sell.reduce((s, t) => s + t.quoteQty, 0),
        buy,
        sell,
        symbols: symbolList,
        updatedAt: Date.now(),
        cached: false,
      };
      trades24hCache = { at: Date.now(), data };
      res.json(data);
    } catch (err: any) {
      if (trades24hCache?.data) {
        res.json({ ...trades24hCache.data, cached: true, staleError: err?.message });
        return;
      }
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/funding", async (req, res) => {
    try {
      const { symbol } = req.query;
      const params: Record<string, string> = {};
      if (symbol) params.symbol = symbol as string;
      const data = await binanceRequest("/fapi/v1/premiumIndex", "GET", params);
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/income", async (req, res) => {
    try {
      const { symbol, incomeType, startTime, endTime, page, limit } = req.query;
      const params: Record<string, string> = {};
      if (symbol) params.symbol = symbol as string;
      if (incomeType) params.incomeType = incomeType as string;
      if (startTime) params.startTime = startTime as string;
      if (endTime) params.endTime = endTime as string;
      if (page) params.page = page as string;
      if (limit) params.limit = limit as string;

      const data = await binanceRequest("/fapi/v1/income", "GET", params);
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/book-ticker", async (req, res) => {
    try {
      if (Date.now() < binanceBanUntil) {
        const untilText = new Date(binanceBanUntil).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
        res.status(429).json({ error: `Binance IP ban active until ${untilText} KST` });
        return;
      }
      const now = Date.now();
      if (!bookTickerCache || now - bookTickerCache.at >= BOOK_TICKER_CACHE_MS) {
        const response = await fetch(`${BASE_URL}/fapi/v1/ticker/bookTicker`);
        const text = await response.text();
        let data: any = [];
        try {
          data = text ? JSON.parse(text) : [];
        } catch {
          data = { msg: text };
        }
        if (!response.ok) {
          const msg = String(data?.msg || data?.error || text || "bookTicker failed");
          if (response.status === 418 || data?.code === -1003) {
            const banUntilMatch = msg.match(/banned until (\d+)/i);
            const parsedBanUntil = banUntilMatch ? Number(banUntilMatch[1]) : 0;
            binanceBanUntil = Number.isFinite(parsedBanUntil) && parsedBanUntil > Date.now()
              ? parsedBanUntil
              : Date.now() + 60 * 60 * 1000;
            persistBanUntil(binanceBanUntil);
          }
          res.status(response.status === 418 || response.status === 429 ? 429 : response.status).json({ error: msg });
          return;
        }
        const rows = Array.isArray(data) ? data : [data];
        const map: Record<string, { bidPrice: string; askPrice: string }> = {};
        for (const row of rows) {
          const symbol = String(row?.symbol || "");
          const bidPrice = String(row?.bidPrice || "");
          const askPrice = String(row?.askPrice || "");
          if (!symbol || !(Number(bidPrice) > 0) || !(Number(askPrice) > 0)) continue;
          map[symbol] = { bidPrice, askPrice };
        }
        bookTickerCache = { at: now, map };
      }
      const symbol = String(req.query.symbol || "").trim().toUpperCase();
      if (symbol) {
        const row = bookTickerCache.map[symbol];
        if (!row) {
          res.status(404).json({ error: `${symbol} 호가를 찾지 못했습니다.` });
          return;
        }
        res.json({ symbol, bidPrice: row.bidPrice, askPrice: row.askPrice });
        return;
      }
      res.json({ tickers: bookTickerCache.map, updatedAt: bookTickerCache.at });
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  apiRouter.get("/futures/exchange-info", async (req, res) => {
    try {
      const response = await fetch(`${BASE_URL}/fapi/v1/exchangeInfo`);
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      sendApiError(res, err);
    }
  });

  /** Spot/Earn/Funding 등 지갑 총액(USDT) — 호출 1회, 캐시로 IP 제한 완화 */
  apiRouter.get("/wallets/overview", async (req, res) => {
    try {
      const force = String(req.query.refresh || "") === "1";
      if (!force && walletOverviewCache && Date.now() - walletOverviewCache.at < WALLET_OVERVIEW_CACHE_MS) {
        res.json({ ...walletOverviewCache.data, cached: true });
        return;
      }
      const raw = await binanceRequest(
        "/sapi/v1/asset/wallet/balance",
        "GET",
        { quoteAsset: "USDT" },
        { baseUrl: SPOT_BASE_URL }
      );
      const wallets = (Array.isArray(raw) ? raw : [])
        .map((w: any) => ({
          name: String(w.walletName || w.name || "Unknown"),
          balanceUsdt: parseFloat(w.balance || "0") || 0,
          activate: w.activate !== false,
        }))
        .filter((w: any) => w.activate || Math.abs(w.balanceUsdt) > 1e-8)
        .sort((a: any, b: any) => Math.abs(b.balanceUsdt) - Math.abs(a.balanceUsdt));
      const totalUsdt = wallets.reduce((s: number, w: any) => s + w.balanceUsdt, 0);
      const futuresWallet = wallets.find((w: any) => /usd.?s?-?m|usdm|usdⓈ/i.test(w.name));
      const data = {
        quoteAsset: "USDT",
        totalUsdt,
        futuresUsdt: futuresWallet?.balanceUsdt ?? null,
        wallets,
        updatedAt: Date.now(),
        cached: false,
      };
      walletOverviewCache = { at: Date.now(), data };
      res.json(data);
    } catch (err: any) {
      // 밴/오류 시 캐시가 있으면 그걸로 응답 (Exposed 유지)
      if (walletOverviewCache?.data) {
        res.json({ ...walletOverviewCache.data, cached: true, staleError: err?.message });
        return;
      }
      sendApiError(res, err);
    }
  });

  /** Spot/Funding/Earn 세부만 (USD-M은 클라이언트가 이미 보유 — fapi 재호출 안 함) */
  apiRouter.get("/wallets/details", async (req, res) => {
    try {
      const force = String(req.query.refresh || "") === "1";
      if (!force && walletDetailsCache && Date.now() - walletDetailsCache.at < WALLET_DETAILS_CACHE_MS) {
        res.json({ ...walletDetailsCache.data, cached: true });
        return;
      }

      const priceMap = await getSpotUsdtPriceMap();
      const errors: string[] = [];
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const soft = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch (e: any) {
          errors.push(`${label}: ${e?.message || e}`);
          return fallback;
        }
      };

      // 병렬 폭주 대신 순차 + 간격
      const spotAssets = await soft("Spot", async () => {
        const acc = await binanceRequest("/api/v3/account", "GET", {}, { baseUrl: SPOT_BASE_URL });
        return valueBalances(
          (acc.balances || []).map((b: any) => ({
            asset: b.asset,
            qty: (parseFloat(b.free || "0") || 0) + (parseFloat(b.locked || "0") || 0),
          })),
          priceMap
        );
      }, []);
      await sleep(WALLET_DETAIL_GAP_MS);

      const fundingAssets = await soft("Funding", async () => {
        const rows = await binanceRequest(
          "/sapi/v1/asset/get-funding-asset",
          "POST",
          { needBtcValuation: "false" },
          { baseUrl: SPOT_BASE_URL }
        );
        return valueBalances(
          (Array.isArray(rows) ? rows : []).map((r: any) => ({
            asset: r.asset,
            qty:
              (parseFloat(r.free || "0") || 0) +
              (parseFloat(r.locked || "0") || 0) +
              (parseFloat(r.freeze || "0") || 0),
          })),
          priceMap
        );
      }, []);
      await sleep(WALLET_DETAIL_GAP_MS);

      const earnFlex = await soft("EarnFlexible", async () => {
        const data = await binanceRequest(
          "/sapi/v1/simple-earn/flexible/position",
          "GET",
          { size: "100" },
          { baseUrl: SPOT_BASE_URL }
        );
        const rows = data?.rows || data || [];
        return valueBalances(
          (Array.isArray(rows) ? rows : []).map((r: any) => ({
            asset: r.asset,
            qty: parseFloat(r.totalAmount || r.amount || "0") || 0,
          })),
          priceMap
        );
      }, []);
      await sleep(WALLET_DETAIL_GAP_MS);

      const earnLocked = await soft("EarnLocked", async () => {
        const data = await binanceRequest(
          "/sapi/v1/simple-earn/locked/position",
          "GET",
          { size: "100" },
          { baseUrl: SPOT_BASE_URL }
        );
        const rows = data?.rows || data || [];
        return valueBalances(
          (Array.isArray(rows) ? rows : []).map((r: any) => ({
            asset: r.asset,
            qty: parseFloat(r.amount || r.totalAmount || "0") || 0,
          })),
          priceMap
        );
      }, []);

      const earnMerged = mergeAssetRows([...earnFlex, ...earnLocked]);
      const sections = [
        { name: "Spot", assets: spotAssets, usdt: sumUsdt(spotAssets) },
        { name: "Funding", assets: fundingAssets, usdt: sumUsdt(fundingAssets) },
        { name: "Earn", assets: earnMerged, usdt: sumUsdt(earnMerged) },
      ].filter((s) => s.assets.length > 0 || Math.abs(s.usdt) > 0.01);

      const data = {
        quoteAsset: "USDT",
        sections,
        totalUsdt: sections.reduce((s, x) => s + x.usdt, 0),
        errors,
        updatedAt: Date.now(),
        cached: false,
        note: "USD-M 세부는 클라이언트 futures account 사용(중복 REST 생략)",
      };
      walletDetailsCache = { at: Date.now(), data };
      res.json(data);
    } catch (err: any) {
      if (walletDetailsCache?.data) {
        res.json({ ...walletDetailsCache.data, cached: true, staleError: err?.message });
        return;
      }
      sendApiError(res, err);
    }
  });

  /** Jupiter portfolio (public wallet). USD 순자산 — 바이낸스 담보 합계에 넣지 않음. */
  apiRouter.get("/jupiter/portfolio", async (req, res) => {
    try {
      const force = String(req.query.refresh || "") === "1";
      if (!force && jupiterPortfolioCache && Date.now() - jupiterPortfolioCache.at < JUPITER_PORTFOLIO_CACHE_MS) {
        res.json({ ...jupiterPortfolioCache.data, cached: true });
        return;
      }
      const data = await fetchJupiterPortfolio();
      jupiterPortfolioCache = { at: Date.now(), data };
      res.json(data);
    } catch (err: any) {
      console.error("[Jupiter Portfolio Error]", err?.message || err);
      if (jupiterPortfolioCache?.data) {
        res.json({ ...jupiterPortfolioCache.data, cached: true, staleError: err?.message });
        return;
      }
      sendApiError(res, err);
    }
  });

  app.use("/api", apiRouter);

  // Router에서 처리되지 않은 /api 요청만 404 (Express 4에서 /api/* 패턴은 환경에 따라 비일관적일 수 있음)
  app.use("/api", (req, res) => {
    console.warn(`[API 404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });

  async function getSpotUsdtPriceMap(): Promise<Record<string, number>> {
    if (spotTickerCache && Date.now() - spotTickerCache.at < 60_000) return spotTickerCache.map;
    const response = await fetch(`${SPOT_BASE_URL}/api/v3/ticker/price`);
    const rows = await response.json();
    const map: Record<string, number> = {};
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const px = parseFloat(r.price);
        if (r.symbol && Number.isFinite(px) && px > 0) map[r.symbol] = px;
      }
    }
    spotTickerCache = { at: Date.now(), map };
    return map;
  }

  function valueBalances(
    rows: Array<{ asset: string; qty: number }>,
    priceMap: Record<string, number>,
    stables?: Set<string>
  ): Array<{ asset: string; qty: number; usdt: number }> {
    const STABLE =
      stables ||
      new Set(["USDT", "USDC", "BUSD", "FDUSD", "BFUSD", "TUSD", "USD1", "DAI", "USDP"]);
    const out: Array<{ asset: string; qty: number; usdt: number }> = [];
    for (const r of rows) {
      const asset = String(r.asset || "").toUpperCase();
      const qty = Number(r.qty) || 0;
      if (!asset || Math.abs(qty) < 1e-12) continue;
      let usdt = 0;
      if (STABLE.has(asset)) usdt = qty;
      else {
        const px = priceMap[`${asset}USDT`] || priceMap[`${asset}USDC`] || priceMap[`${asset}BUSD`];
        if (Number.isFinite(px) && px > 0) usdt = qty * px;
      }
      out.push({ asset, qty, usdt });
    }
    return out.sort((a, b) => Math.abs(b.usdt) - Math.abs(a.usdt));
  }

  function mergeAssetRows(
    rows: Array<{ asset: string; qty: number; usdt: number }>
  ): Array<{ asset: string; qty: number; usdt: number }> {
    const map = new Map<string, { asset: string; qty: number; usdt: number }>();
    for (const r of rows) {
      const prev = map.get(r.asset);
      if (!prev) map.set(r.asset, { ...r });
      else map.set(r.asset, { asset: r.asset, qty: prev.qty + r.qty, usdt: prev.usdt + r.usdt });
    }
    return Array.from(map.values()).sort((a, b) => Math.abs(b.usdt) - Math.abs(a.usdt));
  }

  function sumUsdt(rows: Array<{ usdt: number }>): number {
    return rows.reduce((s, r) => s + (r.usdt || 0), 0);
  }

  // Helper for signed Binance requests (futures fapi or spot/sapi)
  async function binanceRequest(
    endpoint: string,
    method: string = "GET",
    params: Record<string, string> = {},
    opts?: { baseUrl?: string }
  ) {
    const baseUrl = opts?.baseUrl || BASE_URL;
    if (Date.now() < binanceBanUntil) {
      const untilText = new Date(binanceBanUntil).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      const error: any = new Error(`Binance IP ban active until ${untilText} KST. Skipping retry to avoid extending the ban.`);
      error.status = 429;
      error.banUntil = binanceBanUntil;
      throw error;
    }

    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
      throw new Error("BINANCE_API_KEY and BINANCE_API_SECRET are required");
    }

    const timestamp = Date.now().toString();
    const signParams = new URLSearchParams({ ...params, timestamp, recvWindow: "60000" });
    const signature = crypto
      .createHmac("sha256", BINANCE_API_SECRET)
      .update(signParams.toString())
      .digest("hex");

    console.log(`[Binance Request] ${method} ${baseUrl}${endpoint} (with params: ${JSON.stringify(params)})`);

    let url: string;
    let fetchOptions: RequestInit;

    if (method === "GET" || method === "DELETE") {
      // For GET/DELETE: all params go in the query string
      url = `${baseUrl}${endpoint}?${signParams.toString()}&signature=${signature}`;
      fetchOptions = {
        method,
        headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
      };
    } else {
      // For POST/PUT: send params in the request body (application/x-www-form-urlencoded)
      // Only timestamp, recvWindow, and signature go in the URL for authentication traceability
      const bodyParams = new URLSearchParams({ ...params, timestamp, recvWindow: "60000", signature });
      url = `${baseUrl}${endpoint}`;
      fetchOptions = {
        method,
        headers: {
          "X-MBX-APIKEY": BINANCE_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: bodyParams.toString(),
      };
    }

    try {
      const response = await fetch(url, fetchOptions);

      const responseText = await response.text();
      let responseData: any;
      try {
        responseData = responseText ? JSON.parse(responseText) : {};
      } catch (e) {
        console.error(`[Binance Error] Failed to parse JSON from ${endpoint}. Response:`, responseText);
        responseData = { msg: responseText || "Empty response from Binance" };
      }

      if (!response.ok) {
        console.error(`[Binance Error] ${method} ${endpoint}:`, {
          status: response.status,
          data: responseData,
        });
        
        let msg = responseData.msg || responseData.error || `Binance API error (${response.status})`;
        const banUntilMatch = typeof msg === "string" ? msg.match(/banned until (\d+)/i) : null;
        if (response.status === 418 || responseData.code === -1003) {
          const parsedBanUntil = banUntilMatch ? Number(banUntilMatch[1]) : 0;
          binanceBanUntil = Number.isFinite(parsedBanUntil) && parsedBanUntil > Date.now()
            ? parsedBanUntil
            : Date.now() + 60 * 60 * 1000;
          persistBanUntil(binanceBanUntil);
          const untilText = new Date(binanceBanUntil).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
          msg = `Binance rate limit/IP ban active until ${untilText} KST. 자동 재시도를 중단했습니다.`;
        }
        if (typeof msg === 'string' && msg.includes("API-key, IP, or permissions")) {
          msg = `[AUTH_ERROR] 바이낸스 API 설정에서 'Enable Futures' 체크 및 IP 화이트리스트(${lastKnownIp})를 확인하세요.`;
        }
        const error: any = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        error.status = response.status === 418 || response.status === 429 ? 429 : response.status;
        if (binanceBanUntil > Date.now()) error.banUntil = binanceBanUntil;
        throw error;
      }

      return responseData;
    } catch (err: any) {
      console.error(`[Binance Request Failed] ${method} ${endpoint}:`, err.message);
      throw err;
    }
  }

  async function telegramRequest(method: string, body?: Record<string, unknown>) {
    if (!TELEGRAM_BOT_TOKEN) {
      const error: any = new Error("TELEGRAM_BOT_TOKEN 환경변수가 필요합니다.");
      error.status = 503;
      throw error;
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || data?.ok === false) {
      const error: any = new Error(data?.description || `Telegram API error (${response.status})`);
      error.status = response.status || 502;
      throw error;
    }

    return data;
  }

  function requireTelegramChatId() {
    if (!TELEGRAM_CHAT_ID) {
      const error: any = new Error("TELEGRAM_CHAT_ID 환경변수가 필요합니다. 먼저 봇에게 메시지를 보낸 뒤 /api/telegram/updates에서 chat id를 확인하세요.");
      error.status = 503;
      throw error;
    }
    return TELEGRAM_CHAT_ID;
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // LAN 노출 방지: 기본은 loopback만 바인딩, 의도적으로 외부 공개할 때만 LISTEN_HOST 설정
  const host = process.env.LISTEN_HOST || "127.0.0.1";
  app.listen(PORT, host, () => {
    console.log(`Server running on http://localhost:${PORT} (bound to ${host})`);
  });
}

type AiProvider = "gemini" | "claude" | "grok";

function selectAiProvider(requestedProvider?: unknown): AiProvider {
  const rawProvider =
    typeof requestedProvider === "string" && requestedProvider.trim()
      ? requestedProvider
      : process.env.AI_PROVIDER || "auto";
  const provider = rawProvider.toLowerCase();

  if (provider === "claude" || provider === "anthropic") return "claude";
  if (provider === "gemini" || provider === "google") return "gemini";
  if (provider === "grok" || provider === "xai" || provider === "x.ai") return "grok";
  if (provider !== "auto") {
    throw new Error("AI_PROVIDER는 gemini, claude, grok, auto 중 하나여야 합니다.");
  }

  if (process.env.XAI_API_KEY) return "grok";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.CLAUDE_API_KEY) return "claude";
  throw new Error("GEMINI_API_KEY, CLAUDE_API_KEY 또는 XAI_API_KEY 환경변수가 필요합니다.");
}

function requireEnv(name: "GEMINI_API_KEY" | "CLAUDE_API_KEY" | "XAI_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name}가 서버 환경변수에 설정되지 않았습니다.`);
  }
  // strip quotes / accidental inline-comment junk from .env copies
  return String(value).trim().replace(/^["']|["']$/g, "").split(/\s+#/)[0].trim();
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
