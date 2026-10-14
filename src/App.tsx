import { useEffect, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  BarChart3,
  ShieldAlert,
  Zap,
  RefreshCw,
  Settings,
  Bell,
  ArrowRightLeft,
  ListFilter,
  DollarSign,
  PieChart,
  X,
} from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, PieChart as RePieChart, Pie, Cell, Legend } from 'recharts';
import { AssetStats, MarketInsight, FuturesPosition, FuturesOrder, FuturesTrade, FuturesTrades24h, HistoricalSnapshot, FuturesIncome } from './types';
import { BinanceService } from './services/binanceService';
import { AiProvider, AiChatMessage, getMarketInsights, sendAiChat } from './services/geminiService';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
// USD-M 주문 한도 300건/10초, 1200건/분. 450ms면 약 22건/10초라 한도에 닿지 않는다.
// 호가 전체 조회(가중치 5)는 8건마다 다시 받아 1호가가 오래 묵지 않게 한다.
const BULK_ORDER_GAP_MS = 450;
const BULK_BOOK_REFRESH_EVERY = 8;
const AI_PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'grok', label: 'Grok' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'claude', label: 'Claude' },
];
const PORTFOLIO_COLORS = ['#3b82f6', '#10b981', '#f43f5e', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#14b8a6', '#6366f1'];
const ENABLE_USER_TRADES_SYNC = (import.meta as any).env?.VITE_ENABLE_USER_TRADES_SYNC === 'true';

type LiveTickerUpdate = Partial<AssetStats> & Pick<AssetStats, 'price'>;

const formatSeoulTime = (timestamp?: number) => {
  if (!timestamp) return '대기 중';

  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
};

const formatIncomeAmount = (raw: string | number) => {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  const body = abs >= 1 ? v.toFixed(2) : abs >= 0.01 ? v.toFixed(4) : v.toFixed(6);
  return v > 0 ? `+${body}` : body;
};

const formatPct = (raw?: string | number | null) => {
  if (raw === undefined || raw === null || raw === '') return '—';
  const v = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/%/g, ''));
  if (!Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
};

const formatQty = (raw: string | number) => {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(v)) return '0';
  const abs = Math.abs(v);
  if (abs >= 100) return Math.round(v).toLocaleString();
  if (abs >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  if (abs >= 0.01) return v.toFixed(4).replace(/\.?0+$/, '');
  return v.toFixed(6).replace(/\.?0+$/, '');
};

const formatUsdCompact = (raw: string | number) => {
  const v = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString();
};

const formatTickerPrice = (raw?: string | number | null) => {
  const v = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  if (!Number.isFinite(v) || v <= 0) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits });
};

/** KPI: 위 USD, 아래 KRW */
const KpiDualMoney = ({
  usd,
  rate,
  signed,
  valueClassName = 'text-white',
}: {
  usd: number;
  rate: number | null;
  signed?: boolean;
  valueClassName?: string;
}) => {
  const n = Number.isFinite(usd) ? usd : 0;
  const sign = signed && n >= 0 ? '+' : '';
  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <span className={`text-[16.1px] font-mono tabular-nums ${valueClassName}`}>
        {sign}${formatUsdCompact(n)}
      </span>
      {rate != null && Number.isFinite(rate) ? (
        <span className={`text-[11.5px] font-mono tabular-nums text-ink-400 ${signed ? (n >= 0 ? 'text-ok/70' : 'text-danger/70') : ''}`}>
          {sign}₩{formatUsdCompact(n * rate)}
        </span>
      ) : null}
    </div>
  );
};

const isRateLimitError = (msg?: string | null) =>
  !!msg && /ip ban|banned until|rate limit|418|-1003|too many requests/i.test(msg);

const historyRangeLabel = (days: number) => (days === 92 ? '3M' : `${days}D`);

type IncomeListFilter = 'ALL' | 'REALIZED_PNL' | 'FUNDING_FEE' | 'COMMISSION';

export default function App() {
  const [stats, setStats] = useState<Record<string, AssetStats & { history: number[] }>>({});
  const [insights, setInsights] = useState<Record<string, MarketInsight>>({});
  const [activeSymbol, setActiveSymbol] = useState('BTCUSDT');
  const [aiProvider, setAiProvider] = useState<AiProvider>('grok');
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiChatInput, setAiChatInput] = useState('');
  const [aiChatBusy, setAiChatBusy] = useState(false);
  const [aiChatMessages, setAiChatMessages] = useState<AiChatMessage[]>([]);
  const aiChatListRef = useRef<HTMLDivElement | null>(null);
  const [positions, setPositions] = useState<FuturesPosition[]>([]);
  const [openOrders, setOpenOrders] = useState<FuturesOrder[]>([]);
  const [trades, setTrades] = useState<FuturesTrade[]>([]);
  const [incomeHistory, setIncomeHistory] = useState<FuturesIncome[]>([]);
  const [incomeRange, setIncomeRange] = useState<{ start: number; end: number } | null>(null);
  const [accountBalance, setAccountBalance] = useState('0.00');
  const [accountInfo, setAccountInfo] = useState<any>(null);
  const [walletAssetsOpen, setWalletAssetsOpen] = useState(false);
  const walletChipRef = useRef<HTMLDivElement | null>(null);
  const [allWalletsOpen, setAllWalletsOpen] = useState(false);
  const allWalletsChipRef = useRef<HTMLDivElement | null>(null);
  const [allWalletsOverview, setAllWalletsOverview] = useState<{
    totalUsdt: number;
    wallets: Array<{ name: string; balanceUsdt: number; activate: boolean }>;
  } | null>(null);
  const [allWalletsDetails, setAllWalletsDetails] = useState<{
    sections: Array<{ name: string; usdt: number; assets: Array<{ asset: string; qty: number; usdt: number }> }>;
    errors?: string[];
  } | null>(null);
  const [allWalletsLoading, setAllWalletsLoading] = useState(false);
  const [allWalletsError, setAllWalletsError] = useState<string | null>(null);
  const [expandedWalletSection, setExpandedWalletSection] = useState<string | null>(null);
  const [exposedOpen, setExposedOpen] = useState(false);
  const exposedChipRef = useRef<HTMLDivElement | null>(null);
  const [expandedExposedSection, setExpandedExposedSection] = useState<string | null>(null);
  const [jupiterOpen, setJupiterOpen] = useState(false);
  const jupiterChipRef = useRef<HTMLDivElement | null>(null);
  const [trades24h, setTrades24h] = useState<FuturesTrades24h | null>(null);
  const [trades24hOpen, setTrades24hOpen] = useState(false);
  const [trades24hSection, setTrades24hSection] = useState<'BUY' | 'SELL' | null>(null);
  const [trades24hLoading, setTrades24hLoading] = useState(false);
  const [trades24hError, setTrades24hError] = useState<string | null>(null);
  const trades24hChipRef = useRef<HTMLDivElement | null>(null);
  const trades24hAtRef = useRef(0);
  const TRADES_24H_GAP_MS = 120_000;
  const [jupiterPortfolio, setJupiterPortfolio] = useState<{
    address: string;
    totalUsd: number;
    groups: Array<{
      id: string;
      name: string;
      usd: number;
      rows: Array<{ symbol: string; qty: number; usd: number; side: string }>;
    }>;
    updatedAt?: number;
  } | null>(null);
  const [jupiterLoading, setJupiterLoading] = useState(false);
  const [jupiterError, setJupiterError] = useState<string | null>(null);
  const [expandedJupiterGroup, setExpandedJupiterGroup] = useState<string | null>(null);
  const allWalletsOverviewAtRef = useRef(0);
  const allWalletsDetailsAtRef = useRef(0);
  const ALL_WALLETS_OVERVIEW_GAP_MS = 300_000; // 자동 갱신 5분
  const ALL_WALLETS_DETAILS_GAP_MS = 180_000; // 클릭 상세 최소 3분
  const [fundingRates, setFundingRates] = useState<Record<string, any>>({});
  const [history, setHistory] = useState<HistoricalSnapshot[]>([]);
  const [historicalPrices, setHistoricalPrices] = useState<Record<string, { time: number, price: number }[]>>({});
  const [exchangeInfo, setExchangeInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const dismissedErrorRef = useRef<string | null>(null);
  const [expandedPosition, setExpandedPosition] = useState(false);
  const [expandedOrders, setExpandedOrders] = useState(false);
  const [expandedTrades, setExpandedTrades] = useState(false);
  const [expandedIncome, setExpandedIncome] = useState(false);
  const [selectedOpenOrderKey, setSelectedOpenOrderKey] = useState<string | null>(null);
  const [cancellingOrderKey, setCancellingOrderKey] = useState<string | null>(null);
  const [placingBuyOrderKey, setPlacingBuyOrderKey] = useState<string | null>(null);
  const [showLimitBuyForm, setShowLimitBuyForm] = useState(false);
  const [limitBuyPrice, setLimitBuyPrice] = useState('');
  const [limitBuyQty, setLimitBuyQty] = useState('');
  const [showCoinDetails, setShowCoinDetails] = useState(false);
  const [tradeSort, setTradeSort] = useState<'time' | 'pnl'>('time');
  const [showScenarios, setShowScenarios] = useState(false);
  const [orderPercent, setOrderPercent] = useState(0.1);
  const [bulkAllPositions, setBulkAllPositions] = useState(false);
  const [usdKrwRate, setUsdKrwRate] = useState<number | null>(null);
  const [serverIp, setServerIp] = useState<string | null>(null);
  const [sendingTelegram, setSendingTelegram] = useState(false);
  // Stores cleanup functions returned by getLiveTicker (not raw WebSocket refs)
  const wsRefs = useRef<Record<string, () => void>>({});
  const [wsConnected, setWsConnected] = useState<Record<string, boolean>>({});
  const [priceFlash, setPriceFlash] = useState<Record<string, 'up' | 'down' | null>>({});
  const [lastPriceUpdatedAt, setLastPriceUpdatedAt] = useState<Record<string, number>>({});
  const prevPrices = useRef<Record<string, string>>({});
  const positionsRef = useRef<FuturesPosition[]>([]);
  const activeSymbolRef = useRef(activeSymbol);

  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { activeSymbolRef.current = activeSymbol; }, [activeSymbol]);

  const applyLiveTickerUpdate = (symbol: string, update: LiveTickerUpdate) => {
    setLastPriceUpdatedAt(prev => ({ ...prev, [symbol]: Date.now() }));

    const prev = prevPrices.current[symbol];
    if (prev && prev !== update.price) {
      const dir = parseFloat(update.price) > parseFloat(prev) ? 'up' : 'down';
      setPriceFlash(f => ({ ...f, [symbol]: dir }));
      setTimeout(() => setPriceFlash(f => ({ ...f, [symbol]: null })), 600);
    }
    prevPrices.current[symbol] = update.price;

    setStats(currentStats => {
      const current = currentStats[symbol];
      if (current && current.price === update.price) return currentStats;

      const newHistory = current?.history ? [...current.history] : [];
      if (newHistory.length > 0) {
        newHistory[newHistory.length - 1] = parseFloat(update.price);
      }

      const base = current || {
        symbol,
        price: update.price,
        change24h: '0',
        high24h: '0',
        low24h: '0',
        volume: '0',
        history: newHistory
      };

      return {
        ...currentStats,
        [symbol]: { ...base, ...update, symbol, history: newHistory }
      };
    });
  };

  const fetchExchangeRate = () => {
    fetch('https://api.exchangerate-api.com/v4/latest/USD')
      .then(res => res.json())
      .then(data => {
        if (data.rates && data.rates.KRW) {
          setUsdKrwRate(data.rates.KRW);
        }
      })
      .catch(err => console.error("Exchange rate fetch failed:", err));
  };

  // Check health and IP
  useEffect(() => {
    fetchExchangeRate();
    fetch('/api/health')
      .then(res => res.json())
      .then(data => {
        if (data.ip) setServerIp(data.ip);
      })
      .catch(err => console.error("Health check failed:", err));
  }, []);

  // Fetch Exchange Info
  useEffect(() => {
    fetch('/api/futures/exchange-info')
      .then(res => res.json())
      .then(data => setExchangeInfo(data))
      .catch(err => console.error("Exchange info failed:", err));
  }, []);

  const formatQuantity = (symbol: string, quantity: number) => {
    if (!exchangeInfo) return quantity.toFixed(3);
    const symInfo = exchangeInfo.symbols?.find((s: any) => s.symbol === symbol);
    if (!symInfo) return quantity.toFixed(3);
    
    const lotSizeFilter = symInfo.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    if (!lotSizeFilter) return quantity.toFixed(3);
    
    const stepSize = lotSizeFilter.stepSize;
    // Safely calculate precision from stepSize string
    const stepStr = parseFloat(stepSize).toString();
    const fixedPrecision = stepStr.indexOf('.') === -1 ? 0 : stepStr.split('.')[1].length;
    
    const factor = Math.pow(10, fixedPrecision);
    const formatted = (Math.floor(quantity * factor) / factor).toFixed(fixedPrecision);
    
    // Check against minQty. If calculated quantity is less than minQty, return minQty
    if (parseFloat(formatted) < parseFloat(lotSizeFilter.minQty)) {
      return lotSizeFilter.minQty;
    }
    
    return formatted;
  };

  const ceilToStep = (quantity: number, stepSize: string) => {
    const step = parseFloat(stepSize);
    if (!(step > 0) || !(quantity > 0)) return '';
    const trimmed = String(stepSize).replace(/0+$/, '');
    const decimals = trimmed.includes('.') ? (trimmed.split('.')[1] || '').length : 0;
    const steps = Math.ceil(quantity / step - 1e-10);
    return (steps * step).toFixed(decimals);
  };

  // 보유 비율이 최소 수량·최소 주문금액보다 작으면 주문 가능한 최소 수량으로 올린다.
  const bulkQuantity = (symbol: string, rawQty: number, price: string) => {
    const symInfo = exchangeInfo?.symbols?.find((s: any) => s.symbol === symbol);
    const lot = symInfo?.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    const notionalFilter = symInfo?.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL');
    const minQty = parseFloat(lot?.minQty || '0');
    const minNotional = parseFloat(notionalFilter?.notional || notionalFilter?.minNotional || '0');
    const px = parseFloat(price);
    let need = rawQty;
    if (minQty > need) need = minQty;
    if (minNotional > 0 && px > 0 && minNotional / px > need) need = minNotional / px;
    if (!lot?.stepSize) return formatQuantity(symbol, need);
    let qty = ceilToStep(need, String(lot.stepSize));
    const step = parseFloat(lot.stepSize);
    if (minNotional > 0 && px > 0 && step > 0 && parseFloat(qty) * px < minNotional) {
      qty = ceilToStep(parseFloat(qty) + step, String(lot.stepSize));
    }
    return qty;
  };

  const alignToStep = (raw: string, step: string) => {
    const trimmed = String(step).replace(/0+$/, '');
    const decimals = trimmed.includes('.') ? (trimmed.split('.')[1] || '').length : 0;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return '';
    const factor = Math.pow(10, decimals);
    const snapped = Math.floor(n * factor + 1e-8) / factor;
    if (!(snapped > 0)) return '';
    return snapped.toFixed(decimals);
  };

  const formatLimitPrice = (symbol: string, raw: string) => {
    const symInfo = exchangeInfo?.symbols?.find((s: any) => s.symbol === symbol);
    const tick = symInfo?.filters?.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize;
    if (!tick) return Number(raw) > 0 ? String(raw) : '';
    return alignToStep(raw, String(tick));
  };

  const [bulkOrderResults, setBulkOrderResults] = useState<{ symbol: string, side: string, quantity: string, price?: string, status: 'success' | 'fail', error?: string }[] | null>(null);
  const [manualOrderSymbol, setManualOrderSymbol] = useState('BTCUSDT');
  const heldSymbols = useMemo(
    () => Array.from(new Set(positions.map(p => p.symbol).filter(Boolean))).sort(),
    [positions],
  );
  useEffect(() => {
    if (!heldSymbols.length) return;
    if (!heldSymbols.includes(manualOrderSymbol)) setManualOrderSymbol(heldSymbols[0]);
  }, [heldSymbols, manualOrderSymbol]);
  const [manualOrderQty, setManualOrderQty] = useState('0.001');
  const [manualOrderSide, setManualOrderSide] = useState<'BUY' | 'SELL'>('BUY');
  const [submittingManualOrder, setSubmittingManualOrder] = useState(false);
  const [debugLog, setDebugLog] = useState<{ msg: string, time: string }[]>([]);

  // Income 표시 기간 (7/30/90/3M). 3M은 Binance 보존 한계(약 3개월) 근사값 92일.
  const [historyDays, setHistoryDays] = useState<number>(7);
  const historyDaysRef = useRef(historyDays);
  useEffect(() => { historyDaysRef.current = historyDays; }, [historyDays]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyProgress, setHistoryProgress] = useState<{ iter: number; collected: number }>({ iter: 0, collected: 0 });
  const [incomeListFilter, setIncomeListFilter] = useState<IncomeListFilter>('REALIZED_PNL');
  // 동시 fetch 방지 + stale 응답 차단용 id
  const historyFetchIdRef = useRef(0);
  const historyFetchPromiseRef = useRef<Promise<void> | null>(null);
  const historyInFlightDaysRef = useRef<number | null>(null);

  const addLog = (msg: string) => {
    setDebugLog(prev => [{ msg, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 10));
  };

  // Scenario — USD-M 담보 + Spot/Funding/Earn 등 (선물 지갑 제외해 이중계산 방지)
  const scenarioCollateral = useMemo(() => {
    const STABLE_ASSETS = new Set([
      'USDT', 'USDC', 'BUSD', 'FDUSD', 'BFUSD', 'TUSD', 'USD1', 'DAI', 'USDP',
    ]);
    const isFuturesWalletName = (name: string) =>
      /futures|usd.?s?-?m|coin.?-?m|usdⓈ|usdm|coinm/i.test(name);

    let futuresStable = 0;
    let futuresVolatile = 0;
    let futuresWallet = 0;
    const stableSet = new Set<string>();
    const volatileSet = new Set<string>();

    if (accountInfo?.assets) {
      futuresWallet = parseFloat(accountInfo.totalWalletBalance || '0') || 0;
      accountInfo.assets.forEach((asset: any) => {
        const sym = String(asset.asset || '').toUpperCase();
        const cwb = parseFloat(asset.crossWalletBalance ?? asset.walletBalance ?? '0');
        if (!Number.isFinite(cwb) || Math.abs(cwb) < 1e-12) return;
        if (STABLE_ASSETS.has(sym)) {
          if (cwb > 0) {
            futuresStable += cwb;
            stableSet.add(sym);
          }
        } else {
          volatileSet.add(sym);
        }
      });
      futuresStable = Math.max(0, Math.min(futuresStable, futuresWallet));
      futuresVolatile = Math.max(0, futuresWallet - futuresStable);
    }

    let extraStable = 0;
    let extraVolatile = 0;
    const extraByWallet: Array<{ name: string; stable: number; volatile: number }> = [];
    const coveredExtraNames = new Set<string>();

    if (allWalletsDetails?.sections?.length) {
      for (const sec of allWalletsDetails.sections) {
        if (isFuturesWalletName(sec.name)) continue;
        coveredExtraNames.add(sec.name.toLowerCase());
        let s = 0;
        let v = 0;
        for (const a of sec.assets || []) {
          const sym = String(a.asset || '').toUpperCase();
          const usdt = Number(a.usdt) || 0;
          if (Math.abs(usdt) < 1e-8) continue;
          if (STABLE_ASSETS.has(sym)) {
            s += usdt;
            stableSet.add(sym);
          } else {
            v += usdt;
            volatileSet.add(sym);
          }
        }
        // 자산 행이 비어도 섹션 usdt가 있으면 변동으로 보수 반영
        if (s + v < 1e-6 && Math.abs(sec.usdt || 0) > 0.01) {
          v += Number(sec.usdt) || 0;
        }
        extraStable += s;
        extraVolatile += v;
        if (s + v > 0.01) extraByWallet.push({ name: sec.name, stable: s, volatile: v });
      }
    }

    // 상세에 없는 지갑(Options 등)은 overview 총액만 변동자산으로 추가
    if (allWalletsOverview?.wallets?.length) {
      for (const w of allWalletsOverview.wallets) {
        if (isFuturesWalletName(w.name)) continue;
        const key = w.name.toLowerCase();
        if ([...coveredExtraNames].some((c) => key.includes(c) || c.includes(key))) continue;
        // Spot/Funding/Earn 이름은 상세가 있으면 스킵됨
        if (/spot|funding|earn|savings|flexible|locked/i.test(w.name) && coveredExtraNames.size > 0) {
          const matched = [...coveredExtraNames].some((c) =>
            /spot|funding|earn/.test(c) && new RegExp(c.split(/\s+/)[0], 'i').test(w.name)
          );
          if (matched) continue;
        }
        const bal = Number(w.balanceUsdt) || 0;
        if (Math.abs(bal) < 0.01) continue;
        // 이미 동명/유사 섹션이 있으면 스킵
        if (extraByWallet.some((e) => e.name.toLowerCase() === key)) continue;
        if (/spot|funding|earn/i.test(w.name) && extraByWallet.some((e) => /spot|funding|earn/i.test(e.name))) {
          continue;
        }
        extraVolatile += bal;
        extraByWallet.push({ name: w.name, stable: 0, volatile: bal });
      }
    }

    const stableUsdt = futuresStable + extraStable;
    const volatileUsdt = futuresVolatile + extraVolatile;

    let jupiterStable = 0;
    let jupiterVolatile = 0;
    if (jupiterPortfolio?.groups?.length) {
      for (const group of jupiterPortfolio.groups) {
        for (const row of group.rows) {
          const sym = String(row.symbol || '').toUpperCase();
          const usd = Number(row.usd) || 0;
          if (!sym || Math.abs(usd) < 0.01) continue;
          const signed = row.side === 'borrow' ? -usd : usd;
          if (STABLE_ASSETS.has(sym)) {
            jupiterStable += signed;
            stableSet.add(row.side === 'borrow' ? `${sym}대출` : sym);
          } else {
            jupiterVolatile += signed;
            volatileSet.add(row.side === 'borrow' ? `${sym}대출` : sym);
          }
        }
      }
    }
    // 별도 JLP(5,808.05)는 API 밖 포지션이라 순자산·담보에 넣지 않는다. Exposed 노셔널에만 표시.
    if (Math.abs(jupiterStable) + Math.abs(jupiterVolatile) > 0.01) {
      extraByWallet.push({ name: 'Jupiter', stable: jupiterStable, volatile: jupiterVolatile });
    }

    return {
      stableUsdt: stableUsdt + jupiterStable,
      volatileUsdt: volatileUsdt + jupiterVolatile,
      totalWallet: stableUsdt + volatileUsdt + jupiterStable + jupiterVolatile,
      futuresWallet,
      extraWallet: extraStable + extraVolatile + jupiterStable + jupiterVolatile,
      extraByWallet,
      stableAssets: Array.from(stableSet),
      volatileAssets: Array.from(volatileSet),
      includesOtherWallets: extraStable + extraVolatile + Math.abs(jupiterStable) + Math.abs(jupiterVolatile) > 0.01,
      jupiterUsd: jupiterStable + jupiterVolatile,
    };
  }, [accountInfo, allWalletsDetails, allWalletsOverview, jupiterPortfolio]);

  useEffect(() => {
    if (!walletAssetsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!walletChipRef.current?.contains(e.target as Node)) {
        setWalletAssetsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [walletAssetsOpen]);

  useEffect(() => {
    if (!allWalletsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!allWalletsChipRef.current?.contains(e.target as Node)) {
        setAllWalletsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [allWalletsOpen]);

  useEffect(() => {
    if (!trades24hOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!trades24hChipRef.current?.contains(e.target as Node)) {
        setTrades24hOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [trades24hOpen]);

  const fetchTrades24h = async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    if (!force && trades24hAtRef.current > 0 && Date.now() - trades24hAtRef.current < TRADES_24H_GAP_MS) {
      return;
    }
    setTrades24hLoading(true);
    try {
      const data = await BinanceService.getFuturesTrades24h(force);
      trades24hAtRef.current = Date.now();
      setTrades24h(data);
      setTrades24hError(null);
    } catch (e: any) {
      setTrades24hError(e?.message || '24h 체결 조회 실패');
    } finally {
      setTrades24hLoading(false);
    }
  };

  const fetchAllWalletsOverview = async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    if (!force && Date.now() - allWalletsOverviewAtRef.current < ALL_WALLETS_OVERVIEW_GAP_MS) {
      return;
    }
    try {
      // force여도 서버 캐시(3분) 우선 — IP 제한 완화. 강제 REST는 refresh=1
      const data = await BinanceService.getWalletsOverview(force);
      allWalletsOverviewAtRef.current = Date.now();
      setAllWalletsOverview({ totalUsdt: data.totalUsdt, wallets: data.wallets || [] });
      setAllWalletsError(null);
    } catch (e: any) {
      setAllWalletsError(e?.message || '지갑 총액 조회 실패');
    }
  };

  const fetchAllWalletsDetails = async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    if (!force && allWalletsDetails && Date.now() - allWalletsDetailsAtRef.current < ALL_WALLETS_DETAILS_GAP_MS) {
      return;
    }
    setAllWalletsLoading(true);
    try {
      const data = await BinanceService.getWalletsDetails(force);
      setAllWalletsDetails({ sections: data.sections || [], errors: data.errors });
      allWalletsDetailsAtRef.current = Date.now();
      setAllWalletsError(null);
    } catch (e: any) {
      setAllWalletsError(e?.message || '지갑 상세 조회 실패');
    } finally {
      setAllWalletsLoading(false);
    }
  };

  const fetchJupiterPortfolio = async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    if (force) setJupiterLoading(true);
    try {
      const data = await BinanceService.getJupiterPortfolio(force);
      setJupiterPortfolio({
        address: data.address,
        totalUsd: data.totalUsd,
        groups: data.groups || [],
        updatedAt: data.updatedAt,
      });
      setJupiterError(data.staleError || null);
    } catch (e: any) {
      setJupiterError(e?.message || 'Jupiter 잔고 조회 실패');
    } finally {
      if (force) setJupiterLoading(false);
    }
  };

  useEffect(() => {
    void fetchJupiterPortfolio();
    const timer = setInterval(() => { void fetchJupiterPortfolio(); }, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!jupiterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!jupiterChipRef.current?.contains(e.target as Node)) {
        setJupiterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [jupiterOpen]);

  useEffect(() => {
    if (!exposedOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!exposedChipRef.current?.contains(e.target as Node)) {
        setExposedOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [exposedOpen]);

  // Wallet 호버/클릭용 담보 자산 내역 (수량 + USDT 평가액)
  // 주의: multi-asset에서 BTC/ETH 등의 marginBalance·walletBalance는 코인 수량이지 USDT가 아님
  const walletCollateralRows = useMemo(() => {
    if (!accountInfo?.assets) return [];
    const STABLE_ASSETS = new Set([
      'USDT', 'USDC', 'BUSD', 'FDUSD', 'BFUSD', 'TUSD', 'USD1', 'DAI', 'USDP',
    ]);
    const markOf = (asset: string): number => {
      const sym = `${asset}USDT`;
      const pxRaw =
        stats[sym]?.price ??
        positions.find((p) => p.symbol === sym)?.markPrice ??
        fundingRates[sym]?.markPrice;
      const px = typeof pxRaw === 'number' ? pxRaw : parseFloat(String(pxRaw ?? ''));
      return Number.isFinite(px) && px > 0 ? px : NaN;
    };
    return accountInfo.assets
      .map((a: any) => {
        const asset = String(a.asset || '').toUpperCase();
        const stable = STABLE_ASSETS.has(asset);
        const wallet = parseFloat(a.walletBalance || '0');
        const cross = parseFloat(a.crossWalletBalance ?? a.walletBalance ?? '0');
        const qty = Number.isFinite(cross) ? cross : (Number.isFinite(wallet) ? wallet : 0);
        let usdt = 0;
        let mark = NaN;
        if (stable) {
          // 스테이블: 수량 ≈ USDT
          usdt = qty;
          mark = 1;
        } else {
          mark = markOf(asset);
          usdt = Number.isFinite(mark) ? qty * mark : 0;
        }
        return { asset, qty, usdt, mark, stable };
      })
      .filter((r) => Math.abs(r.qty) > 1e-12)
      .sort((a, b) => Math.abs(b.usdt) - Math.abs(a.usdt));
  }, [accountInfo, stats, positions, fundingRates]);

  const walletCollateralUsdtSum = useMemo(
    () => walletCollateralRows.reduce((s, r) => s + r.usdt, 0),
    [walletCollateralRows]
  );

  // All Wallets 세부: Spot/Funding/Earn(API) + USD-M(로컬 account, fapi 재조회 없음)
  const allWalletsDetailSections = useMemo(() => {
    const sections = [...(allWalletsDetails?.sections || [])];
    const hasFutures = sections.some((s) => /futures|usd.?s?-?m|usdm|usdⓈ/i.test(s.name));
    if (!hasFutures && walletCollateralRows.length > 0) {
      sections.push({
        name: 'USDⓈ-M Futures',
        usdt: parseFloat(accountBalance) || walletCollateralUsdtSum,
        assets: walletCollateralRows.map((r) => ({ asset: r.asset, qty: r.qty, usdt: r.usdt })),
      });
    }
    return sections;
  }, [allWalletsDetails, walletCollateralRows, walletCollateralUsdtSum, accountBalance]);

  const scenarioResults = useMemo(() => {
    if (!accountInfo || !accountInfo.assets) return [];

    const scenarios = [-50, -40, -30, -20, -10, -5, 0, 5, 10, 20, 30, 50, 100, 200, 300];
    const { stableUsdt: stableCollateralUsdt, volatileUsdt: volatileCollateralUsdt } = scenarioCollateral;

    return scenarios.map(pct => {
      const change = pct / 100;
      let totalUPNL = 0;
      let totalMaintMargin = 0;
      let totalExposure = 0;
      let scenarioNetExposure = 0;

      positions.forEach(pos => {
        const amt = parseFloat(pos.positionAmt);
        const markPrice = parseFloat(pos.markPrice);
        const entryPrice = parseFloat(pos.entryPrice);

        const posInfo = accountInfo.positions?.find((p: any) => p.symbol === pos.symbol);
        const currentMaintMargin = parseFloat(posInfo?.maintMargin || '0');
        const currentNotional = Math.abs(amt * markPrice);
        const maintMarginRate = currentNotional > 0 ? currentMaintMargin / currentNotional : 0.004;

        const newMarkPrice = markPrice * (1 + change);
        const newUPNL = amt * (newMarkPrice - entryPrice);
        const newNotional = Math.abs(amt * newMarkPrice);
        const newMaintMargin = newNotional * (maintMarginRate || 0.004);

        totalUPNL += newUPNL;
        totalMaintMargin += newMaintMargin;
        totalExposure += newNotional;
        scenarioNetExposure += amt * newMarkPrice;
      });

      // 스테이블 고정 + 비스테이블 담보 × (1+Δ%)
      const scenarioWalletBalance =
        stableCollateralUsdt + volatileCollateralUsdt * Math.max(0, 1 + change);
      const marginBalance = scenarioWalletBalance + totalUPNL;
      const marginBuffer = marginBalance - totalMaintMargin;

      // MR은 연속값. MB≤0이면 분모가 깨지므로 큰 값으로 표현(하드캡 100% 금지 → 표가 갑자기 안 바뀜)
      let marginRatio: number;
      if (totalMaintMargin <= 0) {
        marginRatio = 0;
      } else if (marginBalance <= 0) {
        marginRatio = 999;
      } else {
        marginRatio = (totalMaintMargin / marginBalance) * 100;
      }

      const absoluteNetExposure = Math.abs(scenarioNetExposure);
      const effectiveLeverage = marginBalance > 0 ? totalExposure / marginBalance : 0;
      // Cushion: 순노출 대비 버퍼 %. 이미 청산이면 0 이하로 유지(표시는 표에서 처리)
      const cushionPercent =
        absoluteNetExposure > 0 ? (marginBuffer / absoluteNetExposure) * 100 : (marginBuffer >= 0 ? 999 : 0);

      const liquidated = marginBuffer <= 0 || marginRatio >= 100;

      return {
        pct,
        upnl: totalUPNL,
        walletBalance: scenarioWalletBalance,
        marginBalance,
        marginRatio,
        marginBuffer,
        cushionPercent,
        pnlToCollateral: scenarioWalletBalance > 0 ? (totalUPNL / scenarioWalletBalance) * 100 : -100,
        effectiveLeverage,
        exposure: totalExposure,
        maintMargin: totalMaintMargin,
        liquidated,
      };
    });
  }, [accountInfo, positions, scenarioCollateral]);

  // Estimate Liquidation Price for Active Symbol
  const liquidationPriceEstimate = useMemo(() => {
    if (!accountInfo || !accountInfo.assets || positions.length === 0) return null;
    const pos = positions.find(p => p.symbol === activeSymbol);
    if (!pos) return null;

    const amount = parseFloat(pos.positionAmt);
    if (amount === 0) return null;

    const entry = parseFloat(pos.entryPrice);
    
    // Total Clean Wallet Balance (sum of assets value in USDT without current uPnL)
    const totalCleanWalletBalance = accountInfo.assets.reduce((sum: number, a: any) => {
      const upnl = parseFloat(a.unrealizedProfit || '0');
      const mb = parseFloat(a.marginBalance || '0');
      return sum + (mb - upnl);
    }, 0);
    
    // Sum of UPNL for OTHER positions (uPnL = Size * (Mark - Entry))
    const otherUPNL = positions.filter(p => p.symbol !== activeSymbol).reduce((sum, p) => {
      const amount = parseFloat(p.positionAmt);
      const mark = parseFloat(p.markPrice);
      const entry = parseFloat(p.entryPrice);
      return sum + (amount * (mark - entry));
    }, 0);
    
    // Maint Margin for OTHER positions
    const otherMaintMargin = positions.filter(p => p.symbol !== activeSymbol).reduce((sum, p) => {
      const info = accountInfo.positions?.find((apiP: any) => apiP.symbol === p.symbol);
      return sum + parseFloat(info?.maintMargin || '0');
    }, 0);

    // Maintenance Margin Rate for current position
    const currentInfo = accountInfo.positions?.find((apiP: any) => apiP.symbol === activeSymbol);
    const maintMarginRate = parseFloat(currentInfo?.maintMargin || '0') / Math.max(1, Math.abs(parseFloat(currentInfo?.notional || '1')));
    
    const mmr = maintMarginRate || 0.004;

    // Formula for Cross Margin Liquidation Price (P_liq):
    // WB + otherUPNL + S_j * (P_liq - E_j) = sum(MM_i_other) + abs(S_j) * P_liq * MMR_j
    // P_liq * (S_j - abs(S_j) * MMR_j) = otherMaintMargin - totalCleanWalletBalance - otherUPNL + (S_j * E_j)
    // P_liq = (otherMaintMargin - totalCleanWalletBalance - otherUPNL + S_j * E_j) / (S_j - abs(S_j) * MMR_j)
    
    const numerator = otherMaintMargin - totalCleanWalletBalance - otherUPNL + (amount * entry);
    const denominator = amount - (Math.abs(amount) * mmr);

    if (denominator === 0) return null;
    const liqPrice = numerator / denominator;
    return Number.isFinite(liqPrice) && liqPrice > 0 ? liqPrice : null;
  }, [accountInfo, positions, activeSymbol]);

  // 변수명 sevenDayIncome은 호환을 위해 유지 (기간은 historyDays).
  const rangedIncome = useMemo(() => {
    return incomeHistory
      .filter(i => {
        if (!incomeRange) return true;
        return i.time >= incomeRange.start && i.time <= incomeRange.end;
      })
      .sort((a, b) => b.time - a.time);
  }, [incomeHistory, incomeRange]);

  const sevenDayIncome = useMemo(() => {
    if (incomeListFilter === 'ALL') return rangedIncome;
    return rangedIncome.filter(i => i.incomeType === incomeListFilter);
  }, [rangedIncome, incomeListFilter]);

  // 체결 패널: userTrades가 비어 있으면 REALIZED_PNL로 대체 표시
  const realizedHistory = useMemo(() => {
    return rangedIncome
      .filter(i => i.incomeType === 'REALIZED_PNL')
      .sort((a, b) => b.time - a.time);
  }, [rangedIncome]);

  // Aggregate는 필터와 무관하게 선택 기간 전체(rangedIncome) 기준
  const aggregatedIncome = useMemo(() => {
    const daily: Record<string, { date: string, income: number, expense: number, pnl: number }> = {};
    const fundingByCoin: Record<string, number> = {};
    const pnlByCoin: Record<string, number> = {};
    const commissionByCoin: Record<string, number> = {};

    rangedIncome.forEach(i => {
      const date = new Date(i.time).toLocaleDateString();
      const val = parseFloat(i.income);

      if (!daily[date]) daily[date] = { date, income: 0, expense: 0, pnl: 0 };

      if (i.incomeType === 'FUNDING_FEE') {
        if (val > 0) {
          daily[date].income += val;
        } else {
          daily[date].expense += Math.abs(val);
        }
        fundingByCoin[i.symbol] = (fundingByCoin[i.symbol] || 0) + val;
      } else if (i.incomeType === 'REALIZED_PNL') {
        daily[date].pnl += val;
        pnlByCoin[i.symbol] = (pnlByCoin[i.symbol] || 0) + val;
      } else if (i.incomeType === 'COMMISSION') {
        daily[date].expense += Math.abs(val);
        commissionByCoin[i.symbol] = (commissionByCoin[i.symbol] || 0) + val;
      }
    });

    const netIncome = rangedIncome
      .filter(i => ['REALIZED_PNL', 'FUNDING_FEE', 'COMMISSION'].includes(i.incomeType))
      .reduce((acc, i) => acc + parseFloat(i.income), 0);

    const realizedPnl = rangedIncome
      .filter(i => i.incomeType === 'REALIZED_PNL')
      .reduce((acc, i) => acc + parseFloat(i.income), 0);

    const fundingFees = rangedIncome
      .filter(i => i.incomeType === 'FUNDING_FEE')
      .reduce((acc, i) => acc + parseFloat(i.income), 0);

    return {
      daily: Object.values(daily).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
      funding: fundingByCoin,
      pnl: pnlByCoin,
      commission: commissionByCoin,
      netIncome,
      realizedPnl,
      fundingFees
    };
  }, [rangedIncome]);

  const estimated7DPNL = useMemo(() => {
    const allTimestamps = new Set<number>();
    Object.values(historicalPrices as Record<string, any[]>).forEach(hist => (hist as any[]).forEach(p => allTimestamps.add(p.time)));
    const sortedTimes = Array.from(allTimestamps).sort((a, b) => a - b);
    
    return sortedTimes.map(time => {
      let totalExp = 0;
      let totalUPNL = 0;
      
      positions.forEach(pos => {
        const hist = historicalPrices[pos.symbol];
        if (hist) {
          const point = hist.find(p => p.time === time);
          if (point) {
            const amount = parseFloat(pos.positionAmt);
            const entry = parseFloat(pos.entryPrice);
            const histPrice = point.price;
            totalExp += Math.abs(amount * histPrice);
            totalUPNL += amount * (histPrice - entry);
          }
        }
      });
      
      return {
        time,
        date: new Date(time).toLocaleDateString([], { month: 'numeric', day: 'numeric', hour: '2-digit' }),
        exposure: totalExp,
        pnl: totalUPNL
      };
    }).filter(d => d.exposure > 0);
  }, [historicalPrices, positions]);

  // 1. WebSocket Management
  useEffect(() => {
    const symbolsToSubscribe = new Set([activeSymbol, ...SYMBOLS, ...positions.map(p => p.symbol)]);

    // Teardown connections no longer needed
    Object.keys(wsRefs.current).forEach(symbol => {
      if (!symbolsToSubscribe.has(symbol)) {
        console.log(`[WS] Closing connection for ${symbol}`);
        wsRefs.current[symbol](); // invoke cleanup
        delete wsRefs.current[symbol];
        setWsConnected(prev => { const n = { ...prev }; delete n[symbol]; return n; });
      }
    });

    symbolsToSubscribe.forEach(symbol => {
      if (wsRefs.current[symbol]) return; // already managed (reconnects internally)
      try {
        console.log(`[WS] Opening connection for ${symbol}`);
        wsRefs.current[symbol] = BinanceService.getLiveTicker(
          symbol,
          (update) => {
            applyLiveTickerUpdate(symbol, update);
          },
          (connected) => {
            setWsConnected(c => ({ ...c, [symbol]: connected }));
          }
        );
      } catch (e) {
        console.error(`Socket error for ${symbol}`, e);
      }
    });

    // Cleanup all on unmount
    return () => {
      Object.keys(wsRefs.current).forEach(sym => wsRefs.current[sym]?.());
      wsRefs.current = {};
    };
  }, [activeSymbol, positions]);

  // WebSocket is primary, but this keeps Active Market Intel moving when browser WS is blocked or reconnecting.
  useEffect(() => {
    let cancelled = false;

    const pollActivePrice = async () => {
      const symbols = Array.from(new Set([activeSymbol, 'BTCUSDT']));
      await Promise.all(symbols.map(async (symbol) => {
        const price = await BinanceService.getPrice(symbol);
        if (cancelled || !price || price === '0') return;
        applyLiveTickerUpdate(symbol, { symbol, price });
      }));
    };

    pollActivePrice();
    const interval = setInterval(pollActivePrice, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [activeSymbol]);

  // Browser tab ticker — Binance-style live BTC last price in the document title
  const btcLastPrice = stats['BTCUSDT']?.price;
  useEffect(() => {
    const formatted = formatTickerPrice(btcLastPrice);
    document.title = formatted ? `${formatted} | BTCUSDT | Binance Lite` : 'Binance Lite';
  }, [btcLastPrice]);

  // 2. Initial Data Fetching
  useEffect(() => {
    const initData = async () => {
      const symbolsForKlines = Array.from(new Set([...SYMBOLS, activeSymbol, ...positions.map(p => p.symbol)]));
      
      const fetch24hKlines = async () => {
        for (const symbol of symbolsForKlines) {
          try {
            const [klines, ticker] = await Promise.all([
              BinanceService.getKlines(symbol, '1h', 24),
              BinanceService.get24hTicker(symbol)
            ]);

            setStats(prev => {
              const history = klines && klines.length > 0 
                ? klines.map((k: any) => parseFloat(k[4]))
                : (prev[symbol]?.history || []);
              
              const price = ticker?.price || (klines.length > 0 ? klines[klines.length - 1][4].toString() : '0');
              if (price && price !== '0') {
                setLastPriceUpdatedAt(prev => ({ ...prev, [symbol]: Date.now() }));
              }

              return {
                ...prev,
                [symbol]: {
                  ...(prev[symbol] || {}),
                  symbol,
                  price,
                  change24h: ticker?.change24h || '0',
                  high24h: ticker?.high24h || '0',
                  low24h: ticker?.low24h || '0',
                  volume: ticker?.volume || '0',
                  history
                } as any
              };
            });
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (e) {
            console.error(`Failed init data for ${symbol}`, e);
          }
        }
      };

      await fetch24hKlines();
      await fetchFuturesData();
      await fetchHistoryData();
    };

    initData();
    // EC2/free-tier: REST 부담 완화 (로컬 원본 60s보다 길게)
    const interval = setInterval(fetchFuturesData, 120000);
    const historyInterval = setInterval(fetchHistoryData, 600000);

    return () => {
      clearInterval(interval);
      clearInterval(historyInterval);
    };
  }, []); // Run once on mount

  // historyDays 변경 시 200ms debounce 후 재fetch. 마운트 시점은 initData가 처리하므로 첫 렌더는 스킵.
  const isInitialRangeMount = useRef(true);
  useEffect(() => {
    if (isInitialRangeMount.current) {
      isInitialRangeMount.current = false;
      return;
    }
    const timer = setTimeout(() => { fetchHistoryData(); }, 200);
    return () => clearTimeout(timer);
  }, [historyDays]);

  // 3. Separate effect for long-term history based on positions
  useEffect(() => {
    const fetchLongTermHistory = async () => {
      const symbolsWithPos = positions.map(p => p.symbol);
      const newHistories: Record<string, { time: number, price: number }[]> = {};
      
      for (const symbol of symbolsWithPos) {
        // Only fetch if we don't have it already
        if (!historicalPrices[symbol]) {
          try {
            const klines = await BinanceService.getKlines(symbol, '4h', 42); 
            newHistories[symbol] = klines.map((k: any) => ({
              time: k[0],
              price: parseFloat(k[4])
            }));
            // Wait a bit between calls to avoid rate limit if many positions
            await new Promise(resolve => setTimeout(resolve, 600));
          } catch (e) {
            console.error(`Failed to fetch 4h klines for ${symbol}`, e);
          }
        }
      }
      
      if (Object.keys(newHistories).length > 0) {
        setHistoricalPrices(prev => ({ ...prev, ...newHistories }));
      }
    };

    if (positions.length > 0) {
      fetchLongTermHistory();
    }
  }, [positions]);

  // 4. Cleanup on unmount is handled inside the WebSocket Management effect above.

  const refreshAll = async () => {
    setIsAnalysing(true);
    fetchExchangeRate();
    try {
      await Promise.all([fetchFuturesData(), fetchHistoryData()]);
      setError(null);
    } catch (err) {
      setError("Refresh failed: IP might be restricted");
    } finally {
      setIsAnalysing(false);
    }
  };

  const fetchHistoryData = async () => {
    const daysWanted = historyDaysRef.current;

    // 같은 기간이 이미 진행 중이면 재사용. 기간이 바뀌면 이전 fetch를 stale 처리 후 새로 시작.
    if (historyFetchPromiseRef.current && historyInFlightDaysRef.current === daysWanted) {
      return historyFetchPromiseRef.current;
    }
    if (historyFetchPromiseRef.current) {
      historyFetchIdRef.current += 1; // in-flight 결과를 폐기
      try {
        await historyFetchPromiseRef.current;
      } catch {
        /* ignore */
      }
    }

    const myId = ++historyFetchIdRef.current;
    historyInFlightDaysRef.current = daysWanted;

    const runPromise = (async () => {
      const days = historyDaysRef.current;
      setHistoryLoading(true);
      setHistoryProgress({ iter: 0, collected: 0 });
      try {
        const now = Date.now();
        const displayStartMs = now - days * 24 * 60 * 60 * 1000;
        setIncomeRange({ start: displayStartMs, end: now });

        const onIncomeProgress = (p: { iter: number; collected: number }) => {
          if (myId === historyFetchIdRef.current) {
            setHistoryProgress({ iter: p.iter, collected: p.collected });
          }
        };

        // 1차: 실현/수수료만 빠르게 → History·요약에 바로 반영
        const coreIncome = await BinanceService.fetchIncomeHistory(
          displayStartMs,
          now,
          onIncomeProgress,
          {
            incomeTypes: ['REALIZED_PNL', 'COMMISSION'],
            delayMs: 120,
            dedupeKey: `core:${days}`,
          }
        ).catch(err => {
          console.error('Income(core) fetch failed:', err);
          return [] as FuturesIncome[];
        });

        if (myId !== historyFetchIdRef.current) return;
        let ranged = coreIncome.filter(i => i.time >= displayStartMs && i.time <= now);
        setIncomeHistory(ranged);

        // 2차: 펀딩 (건수 많음) — Net Income 정확도용
        const fundingIncome = await BinanceService.fetchIncomeHistory(
          displayStartMs,
          now,
          onIncomeProgress,
          {
            incomeTypes: ['FUNDING_FEE'],
            delayMs: 180,
            dedupeKey: `funding:${days}`,
          }
        ).catch(err => {
          console.error('Income(funding) fetch failed:', err);
          return [] as FuturesIncome[];
        });

        if (myId !== historyFetchIdRef.current) return;
        if (fundingIncome.length > 0) {
          const seen = new Set(ranged.map(i => `${i.tranId}_${i.incomeType}_${i.time}_${i.income}`));
          const merged = [...ranged];
          for (const item of fundingIncome) {
            if (item.time < displayStartMs || item.time > now) continue;
            const key = `${item.tranId}_${item.incomeType}_${item.time}_${item.income}`;
            if (!seen.has(key)) {
              seen.add(key);
              merged.push(item);
            }
          }
          ranged = merged;
          setIncomeHistory(merged);
        }

        if (!ENABLE_USER_TRADES_SYNC) {
          // REALIZED_PNL로 History 패널을 채우므로 userTrades는 생략 (IP ban 방지).
          if (myId === historyFetchIdRef.current) setTrades([]);
          return;
        }

        const realizedSymbols = ranged
          .filter(i => i.incomeType === 'REALIZED_PNL' && i.symbol)
          .map(i => i.symbol);
        const currentPositions = positionsRef.current;
        const currentActiveSymbol = activeSymbolRef.current;
        const activeSymbols = new Set<string>([
          currentActiveSymbol,
          ...realizedSymbols,
          ...currentPositions.map(p => p.symbol),
        ]);

        // 실현 심볼 우선, 최대 8개
        const symbolsToFetch = [
          ...realizedSymbols.filter((s, idx, arr) => arr.indexOf(s) === idx),
          ...Array.from(activeSymbols),
        ].filter((s, idx, arr) => arr.indexOf(s) === idx).slice(0, 8);

        console.log('[History] Syncing userTrades for:', symbolsToFetch);
        const allTrades: FuturesTrade[] = [];
        for (const symbol of symbolsToFetch) {
          try {
            const symbolTrades = await BinanceService.getFuturesTrades(symbol, {
              startTime: displayStartMs,
              endTime: now,
              limit: 1000,
            });
            if (symbolTrades?.length) allTrades.push(...symbolTrades);
            await new Promise(r => setTimeout(r, 150));
          } catch (err) {
            console.warn(`Trades failed for ${symbol}:`, err);
          }
        }

        const sortedTrades = allTrades.sort((a, b) => b.time - a.time);
        console.log(`[History] Total trades found: ${sortedTrades.length}`);
        if (myId === historyFetchIdRef.current) setTrades(sortedTrades);
      } catch (err) {
        console.error('Global history fetch error:', err);
      } finally {
        if (myId === historyFetchIdRef.current) setHistoryLoading(false);
      }
    })();

    historyFetchPromiseRef.current = runPromise.finally(() => {
      if (historyFetchPromiseRef.current === runPromise) {
        historyFetchPromiseRef.current = null;
        historyInFlightDaysRef.current = null;
      }
    });
    return historyFetchPromiseRef.current;
  };

  const fetchFuturesData = async () => {
      try {
        const [pos, orders, acc, funding] = await Promise.all([
          BinanceService.getFuturesPositions(),
          BinanceService.getFuturesOpenOrders(),
          BinanceService.getFuturesAccount(),
          BinanceService.getFuturesFunding()
        ]);
        
        setPositions(pos);
        setOpenOrders(orders);
        setAccountInfo(acc);
        setAccountBalance(acc.totalWalletBalance || '0.00');
        
        const fundingMap: Record<string, any> = {};
        if (Array.isArray(funding)) {
          funding.forEach((f: any) => fundingMap[f.symbol] = f);
        } else if (funding.symbol) {
          fundingMap[funding.symbol] = funding;
        }
        setFundingRates(fundingMap);

        // 전체 지갑 총액만 드물게 갱신 (상세는 클릭 시에만 — IP 제한 완화)
        void fetchAllWalletsOverview({ force: false });
        void fetchTrades24h({ force: false });

        // Calculate Totals for History
        const totalUPNLVal = pos.reduce((acc, p) => acc + parseFloat(p.unRealizedProfit), 0);
        const exposureVal = pos.reduce((acc, p) => acc + (Math.abs(parseFloat(p.positionAmt)) * parseFloat(p.markPrice)), 0);
        const balanceVal = parseFloat(acc.totalWalletBalance || '0');

        setHistory(prev => {
          const newSnapshot: HistoricalSnapshot = {
            timestamp: Date.now(),
            totalBalance: balanceVal,
            totalUPNL: totalUPNLVal,
            exposure: exposureVal,
            fundingValue: 0 // Simplification for now
          };
          const next = [...prev, newSnapshot];
          return next.slice(-30); // Keep last 30 data points
        });
        
        dismissedErrorRef.current = null;
        setDismissedError(null);
        setError(null);
      } catch (err: any) {
        console.error("Futures data fetch error:", err);
        const msg = err?.message || 'API request failed';
        if (dismissedErrorRef.current !== msg) setError(msg);
      }
    };

  const dismissError = () => {
    if (error) {
      dismissedErrorRef.current = error;
      setDismissedError(error);
    }
    setError(null);
  };

  const loadBook = async (symbol?: string): Promise<Record<string, { bidPrice: string; askPrice: string }>> => {
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    const res = await fetch(`/api/futures/book-ticker${q}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || data?.msg || `호가 조회 실패 (${res.status})`);
    if (symbol) {
      return { [symbol]: { bidPrice: String(data.bidPrice), askPrice: String(data.askPrice) } };
    }
    return data.tickers || {};
  };

  const touchPrice = (
    book: Record<string, { bidPrice: string; askPrice: string }>,
    symbol: string,
    side: 'BUY' | 'SELL',
  ) => {
    const row = book[symbol];
    if (!row) return '';
    const raw = side === 'BUY' ? row.bidPrice : row.askPrice;
    return formatLimitPrice(symbol, raw);
  };

  const executeManualOrder = async () => {
    if (submittingManualOrder) return;
    const symbol = manualOrderSymbol.toUpperCase().trim();
    const quantity = formatQuantity(symbol, parseFloat(manualOrderQty));
    if (!(parseFloat(quantity) > 0)) {
      alert('수량을 확인해 주세요.');
      return;
    }
    setSubmittingManualOrder(true);
    addLog(`Manual Order Start: ${manualOrderSide} ${quantity} ${symbol} @ best ${manualOrderSide === 'BUY' ? 'bid' : 'ask'}`);
    try {
      const book = await loadBook(symbol);
      const price = touchPrice(book, symbol, manualOrderSide);
      if (!price) {
        addLog('FAILED: 1호가를 가져오지 못했습니다.');
        alert(`${symbol} 1호가를 가져오지 못했습니다.`);
        return;
      }
      const touchLabel = manualOrderSide === 'BUY' ? '매수1호가' : '매도1호가';
      if (!window.confirm(`${manualOrderSide} ${quantity} ${symbol} @ ${price} (${touchLabel} 지정가) 주문을 실행합니다. 진행할까요?`)) return;

      const payload = {
        symbol,
        side: manualOrderSide,
        type: 'LIMIT',
        quantity,
        price,
      };

      const endpoint = '/api/futures/order';
      addLog(`Requesting: POST ${endpoint} LIMIT @ ${price}...`);

      const res = await BinanceService.authorizedOrder(endpoint, payload);

      addLog(`Response Status: ${res.status}`);
      const text = await res.text();

      if (!res.ok) {
        addLog(`FAILED: ${text}`);
      } else {
        const data = JSON.parse(text);
        addLog(`SUCCESS: ORDER_ID ${data.orderId}`);
        fetchFuturesData();
      }
    } catch (e: any) {
      addLog(`CATCH ERROR: ${e.message}`);
      console.error("Manual order error:", e);
    } finally {
      setSubmittingManualOrder(false);
    }
  };

  const handleCancelOpenOrder = async () => {
    const selectedOrder = openOrders.find(order => `${order.symbol}-${order.orderId}` === selectedOpenOrderKey);
    if (!selectedOrder || cancellingOrderKey) return;

    const orderLabel = `${selectedOrder.side} ${selectedOrder.symbol} #${selectedOrder.orderId}`;
    if (!confirm(`${orderLabel} 미체결 주문을 취소하시겠습니까?`)) return;

    const orderKey = `${selectedOrder.symbol}-${selectedOrder.orderId}`;
    setCancellingOrderKey(orderKey);
    addLog(`Cancel Order Start: ${orderLabel}`);
    try {
      await BinanceService.cancelFuturesOrder(selectedOrder.symbol, selectedOrder.orderId);
      addLog(`CANCELLED: ORDER_ID ${selectedOrder.orderId}`);
      setSelectedOpenOrderKey(null);
      await fetchFuturesData();
    } catch (e: any) {
      addLog(`CANCEL FAILED: ${e.message}`);
      alert(e.message || '주문 취소에 실패했습니다.');
    } finally {
      setCancellingOrderKey(null);
    }
  };

  const handleLimitBuyFromSelectedOrder = async () => {
    const selectedOrder = openOrders.find(order => `${order.symbol}-${order.orderId}` === selectedOpenOrderKey);
    if (!selectedOrder || placingBuyOrderKey) return;

    const originalQty = parseFloat(selectedOrder.origQty);
    const executedQty = parseFloat(selectedOrder.executedQty || '0');
    const remainingQty = Math.max(0, originalQty - executedQty);
    const defaultPrice = parseFloat(selectedOrder.price);
    setLimitBuyPrice(Number.isFinite(defaultPrice) && defaultPrice > 0 ? defaultPrice.toString() : '');
    setLimitBuyQty(remainingQty > 0 ? remainingQty.toString() : selectedOrder.origQty);
    setShowLimitBuyForm(true);
  };

  const submitLimitBuyOrder = async () => {
    const selectedOrder = openOrders.find(order => `${order.symbol}-${order.orderId}` === selectedOpenOrderKey);
    if (!selectedOrder || placingBuyOrderKey) return;

    const orderKey = `${selectedOrder.symbol}-${selectedOrder.orderId}`;
    const price = parseFloat(limitBuyPrice);
    const quantity = parseFloat(limitBuyQty);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      alert('가격과 수량은 0보다 큰 숫자로 입력해야 합니다.');
      return;
    }

    setPlacingBuyOrderKey(orderKey);
    addLog(`Limit Buy Start: BUY ${limitBuyQty} ${selectedOrder.symbol} @ ${limitBuyPrice}`);
    try {
      const res = await BinanceService.authorizedOrder('/api/futures/order', {
          symbol: selectedOrder.symbol,
          side: 'BUY',
          type: 'LIMIT',
          quantity: limitBuyQty.trim(),
          price: limitBuyPrice.trim(),
        });

      const text = await res.text();
      if (!res.ok) {
        addLog(`LIMIT BUY FAILED: ${text}`);
        let errorMessage = text;
        try {
          const data = JSON.parse(text);
          errorMessage = data.error || data.msg || text;
        } catch (e) {
          // Use raw server text when it is not JSON.
        }
        alert(errorMessage || '지정가 매수 주문에 실패했습니다.');
        return;
      }

      const data = JSON.parse(text);
      addLog(`LIMIT BUY SUCCESS: ORDER_ID ${data.orderId}`);
      setShowLimitBuyForm(false);
      await fetchFuturesData();
    } catch (e: any) {
      addLog(`LIMIT BUY ERROR: ${e.message}`);
      alert(e.message || '지정가 매수 주문 중 오류가 발생했습니다.');
    } finally {
      setPlacingBuyOrderKey(null);
    }
  };

  const handleBulkOrder = async (side: 'BUY' | 'SELL', onlyType: 'LONG' | 'SHORT') => {
    if (isAnalysing) return;

    // 슬라이더 0.5는 0.5%. 보유 1 ETH → 0.005 ETH.
    const positionFraction = orderPercent / 100;
    const allHeld = bulkAllPositions;
    const targets = positions.filter(p => {
       const amt = parseFloat(p.positionAmt);
       if (!(amt !== 0)) return false;
       if (allHeld) return true;
       if (onlyType === 'LONG') return amt > 0;
       if (onlyType === 'SHORT') return amt < 0;
       return false;
    });

    if (targets.length === 0) {
      alert(allHeld ? '보유 중인 포지션이 없습니다.' : `No active ${onlyType} positions found.`);
      return;
    }

    const touchLabel = side === 'BUY' ? '매수1호가' : '매도1호가';
    const scopeLabel = allHeld
      ? `롱·숏 보유 ${targets.length}개 전체`
      : `${onlyType} ${targets.length}개`;
    const etaSec = Math.ceil((targets.length * BULK_ORDER_GAP_MS) / 1000);
    if (!confirm(`${scopeLabel}에 각각 보유 수량의 ${orderPercent}% ${side === 'BUY' ? '롱' : '숏'}을 ${touchLabel} 지정가로 넣습니다. 1 ETH면 ${positionFraction.toFixed(4)} ETH. 주문 간격 ${BULK_ORDER_GAP_MS}ms (약 ${etaSec}초). 진행할까요?`)) {
      return;
    }

    setIsAnalysing(true);
    const results: { symbol: string, side: string, quantity: string, price?: string, status: 'success' | 'fail', error?: string }[] = [];

    try {
      let book: Record<string, { bidPrice: string; askPrice: string }> = {};
      let bookLoadedAt = -BULK_BOOK_REFRESH_EVERY;
      for (let i = 0; i < targets.length; i++) {
        const pos = targets[i];
        const symbol = pos.symbol.trim().toUpperCase();
        if (i - bookLoadedAt >= BULK_BOOK_REFRESH_EVERY) {
          try {
            book = await loadBook();
            bookLoadedAt = i;
          } catch (e: any) {
            const msg = e?.message || '호가 조회 실패';
            if (/ban|429|418|-1003|too many/i.test(msg)) {
              for (let j = i; j < targets.length; j++) {
                results.push({ symbol: targets[j].symbol, side, quantity: '?', status: 'fail', error: `중단: ${msg}` });
              }
              break;
            }
            results.push({ symbol, side, quantity: '?', status: 'fail', error: msg });
            await new Promise(r => setTimeout(r, BULK_ORDER_GAP_MS));
            continue;
          }
        }

        const heldQty = Math.abs(parseFloat(pos.positionAmt));
        const price = touchPrice(book, symbol, side);
        if (!price) {
          results.push({ symbol, side, quantity: '0', status: 'fail', error: '1호가 없음' });
          continue;
        }
        const fmtQuantity = bulkQuantity(symbol, heldQty * positionFraction, price);
        if (!(parseFloat(fmtQuantity) > 0)) {
          results.push({ symbol, side, quantity: '0', status: 'fail', error: 'Quantity too small' });
          continue;
        }

        try {
          const res = await BinanceService.authorizedOrder('/api/futures/order', {
            symbol,
            side,
            type: 'LIMIT',
            quantity: fmtQuantity,
            price,
          });
          const text = await res.text();
          if (!res.ok) {
            let errorMessage = text || `Server error (${res.status})`;
            try {
              const err = JSON.parse(text);
              errorMessage = err.error || err.msg || errorMessage;
              if (err.code === -4164) errorMessage = 'Order value below minimum ($5)';
            } catch {
              /* raw text */
            }
            results.push({ symbol, side, quantity: fmtQuantity, price, status: 'fail', error: errorMessage });
            if (/ban|429|418|-1003|too many/i.test(errorMessage)) {
              for (let j = i + 1; j < targets.length; j++) {
                results.push({ symbol: targets[j].symbol, side, quantity: '?', status: 'fail', error: '중단: API 제한' });
              }
              break;
            }
          } else {
            const data = JSON.parse(text);
            if (data.orderId) {
              results.push({ symbol, side, quantity: fmtQuantity, price, status: 'success', error: `@ ${price}` });
            } else {
              let errMsg = data.msg || 'Item failed';
              if (data.code === -4164) errMsg = 'Order value below minimum ($5)';
              results.push({ symbol, side, quantity: fmtQuantity, price, status: 'fail', error: errMsg });
            }
          }
        } catch (e: any) {
          results.push({ symbol, side, quantity: fmtQuantity, price, status: 'fail', error: e.message });
        }

        if (i < targets.length - 1) {
          await new Promise(r => setTimeout(r, BULK_ORDER_GAP_MS));
        }
      }
      
      setBulkOrderResults(results);
      try {
        await fetchFuturesData();
      } catch (refreshErr) {
        console.error('Position refresh after bulk order failed:', refreshErr);
      }
    } catch (err: any) {
      console.error("Bulk order process error:", err);
      alert(`Error during bulk order process: ${err.message}`);
    } finally {
      setIsAnalysing(false);
    }
  };

  const runAnalysis = async () => {
    if (isAnalysing) return;
    setIsAnalysing(true);
    try {
      const klines = await BinanceService.getKlines(activeSymbol);
      if (!klines.length) {
        alert("바이낸스에서 캔들 데이터를 가져오지 못했습니다. 네트워크를 확인하거나 잠시 후 다시 시도하세요.");
        return;
      }
      const insight = await getMarketInsights(activeSymbol, klines, aiProvider);
      setInsights(prev => ({ ...prev, [activeSymbol]: insight }));
    } catch (error) {
      console.error(error);
      const msg = error instanceof Error ? error.message : "AI 분석 중 오류가 발생했습니다.";
      alert(msg);
    } finally {
      setIsAnalysing(false);
    }
  };

  const activeStats = stats[activeSymbol];
  const activeInsight = insights[activeSymbol];
  const currentPosition = positions.find(p => p.symbol === activeSymbol);
  const activePriceUpdatedAt = lastPriceUpdatedAt[activeSymbol];

  const totalUPNL = positions.reduce((acc, p) => acc + parseFloat(p.unRealizedProfit), 0);
  const totalExposure = positions.reduce((acc, p) => acc + (Math.abs(parseFloat(p.positionAmt)) * parseFloat(p.markPrice)), 0);
  const netExposure = positions.reduce((acc, p) => acc + (parseFloat(p.positionAmt) * parseFloat(p.markPrice)), 0);
  // Exposed = 포지션 노셔널 + 전체 지갑(USDT) + Jupiter 순자산(USD).
  // overview에 USD-M이 이미 포함되어 중복 없음. overview 없으면 USD-M wallet만 fallback.
  // Jupiter API 자산·대출만 시나리오 순자산에 넣는다. 별도 JLP는 포지션이라 순자산에서 제외.
  const allWalletsUsdtForExposed =
    allWalletsOverview && Number.isFinite(allWalletsOverview.totalUsdt)
      ? allWalletsOverview.totalUsdt
      : parseFloat(accountBalance) || 0;
  const jupiterUsdForExposed =
    jupiterPortfolio && Number.isFinite(jupiterPortfolio.totalUsd) ? jupiterPortfolio.totalUsd : 0;
  // API 순자산 밖 Jupiter 디파이 JLP. 2026-10-10 $27,000 / $4.648722 로 수량을 고정하고 시세로 재평가.
  const jupiterDefiJlpQty = 27_000 / 4.648722;
  let jupiterDefiJlpPrice = 4.648722;
  if (jupiterPortfolio) {
    let pricedQty = 0;
    for (const group of jupiterPortfolio.groups) {
      for (const row of group.rows) {
        if (row.symbol !== 'JLP' || !(row.qty > 0) || !(row.usd > 0)) continue;
        if (row.qty > pricedQty) {
          pricedQty = row.qty;
          jupiterDefiJlpPrice = row.usd / row.qty;
        }
      }
    }
  }
  const jupiterDefiExtraUsd = jupiterDefiJlpQty * jupiterDefiJlpPrice;
  const totalValuationPlusWallet =
    totalExposure + allWalletsUsdtForExposed + jupiterUsdForExposed + jupiterDefiExtraUsd;
  const exposedPositionRows = positions
    .map((p) => ({
      symbol: p.symbol,
      usd: Math.abs(parseFloat(p.positionAmt) || 0) * (parseFloat(p.markPrice) || 0),
    }))
    .filter((row) => Number.isFinite(row.usd) && row.usd >= 1)
    .sort((a, b) => b.usd - a.usd);
  const headerQuoteSymbols = useMemo(() => {
    return positions
      .map((p) => ({
        symbol: p.symbol,
        usd: Math.abs(parseFloat(p.positionAmt) || 0) * (parseFloat(p.markPrice) || 0),
        mark: parseFloat(p.markPrice) || 0,
      }))
      .filter((row) => Number.isFinite(row.usd) && row.usd >= 300)
      .sort((a, b) => b.usd - a.usd);
  }, [positions]);

  useEffect(() => {
    const el = aiChatListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [aiChatMessages, aiChatBusy]);

  const sendAiChatMessage = async () => {
    const text = aiChatInput.trim();
    if (!text || aiChatBusy) return;
    const nextMessages: AiChatMessage[] = [...aiChatMessages, { role: 'user', content: text }];
    setAiChatMessages(nextMessages);
    setAiChatInput('');
    setAiChatBusy(true);
    try {
      const context = [
        `심볼: ${activeSymbol}`,
        `가격: ${activeStats?.price ?? 'n/a'}`,
        `포지션수: ${positions.length}`,
        `Notional: ${Math.round(totalExposure)}`,
        `uPNL: ${Math.round(totalUPNL)}`,
        `Wallet: ${accountBalance}`,
        `Margin: ${accountInfo?.totalMarginBalance ?? 'n/a'}`,
        activeInsight ? `최근 센티먼트: ${activeInsight.sentiment}` : '',
        activeInsight?.summary ? `요약: ${activeInsight.summary}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const reply = await sendAiChat(nextMessages, {
        provider: aiProvider,
        symbol: activeSymbol,
        context,
      });
      setAiChatMessages(prev => [...prev, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setAiChatMessages(prev => [
        ...prev,
        { role: 'assistant', content: `오류: ${e?.message || '채팅 실패'}` },
      ]);
    } finally {
      setAiChatBusy(false);
    }
  };

  const handleSendTelegramSummary = async () => {
    if (sendingTelegram) return;

    const formatSigned = (value: number, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
    const topPositions = [...positions]
      .sort((a, b) => Math.abs(parseFloat(b.positionAmt) * parseFloat(b.markPrice)) - Math.abs(parseFloat(a.positionAmt) * parseFloat(a.markPrice)))
      .slice(0, 8)
      .map(pos => {
        const amount = parseFloat(pos.positionAmt);
        const notional = Math.abs(amount * parseFloat(pos.markPrice));
        const side = amount >= 0 ? 'LONG' : 'SHORT';
        return `- ${pos.symbol} ${side} ${pos.leverage}x | ${Math.round(notional).toLocaleString()} USDT | uPNL ${formatSigned(parseFloat(pos.unRealizedProfit))}`;
      });

    const message = [
      `[Binance Futures Summary]`,
      `Time: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`,
      ``,
      `Wallet Balance: ${Number(accountBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`,
      `Margin Balance: ${Number(accountInfo?.totalMarginBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`,
      `Total uPNL: ${formatSigned(totalUPNL)} USDT`,
      `Exposure: ${Math.round(totalExposure).toLocaleString()} USDT`,
      `Net Exposure: ${formatSigned(netExposure, 0)} USDT`,
      `Open Positions: ${positions.length}`,
      `Open Orders: ${openOrders.length}`,
      ``,
      `${historyDays}D Realized PNL: ${formatSigned(aggregatedIncome.realizedPnl)} USDT`,
      `${historyDays}D Funding: ${formatSigned(aggregatedIncome.fundingFees)} USDT`,
      `${historyDays}D Net Income: ${formatSigned(aggregatedIncome.netIncome)} USDT`,
      ``,
      `Top Positions`,
      topPositions.length ? topPositions.join('\n') : '- No active positions',
    ].join('\n');

    setSendingTelegram(true);
    try {
      await BinanceService.sendTelegramMessage(message);
      addLog('TELEGRAM SENT: portfolio summary');
      alert('텔레그램으로 현재 요약을 전송했습니다.');
    } catch (e: any) {
      addLog(`TELEGRAM FAILED: ${e.message}`);
      alert(e.message || '텔레그램 전송에 실패했습니다.');
    } finally {
      setSendingTelegram(false);
    }
  };

  const positionAllocationData = useMemo(() => {
    const rawAllocations = positions
      .map(p => {
        const amount = Math.abs(parseFloat(p.positionAmt));
        const markPrice = parseFloat(p.markPrice);
        const value = amount * markPrice;
        return {
          symbol: p.symbol,
          name: p.symbol.replace('USDT', ''),
          value,
          pnl: parseFloat(p.unRealizedProfit)
        };
      })
      .filter(p => Number.isFinite(p.value) && p.value > 0)
      .sort((a, b) => b.value - a.value);

    const threshold = Math.max(100, totalExposure * 0.01);
    const major = rawAllocations.filter(p => p.value >= threshold);
    const minor = rawAllocations.filter(p => p.value < threshold);
    const groupedAllocations = [...major];

    if (minor.length > 0) {
      groupedAllocations.push({
        symbol: 'OTHERS',
        name: 'Others',
        value: minor.reduce((sum, p) => sum + p.value, 0),
        pnl: minor.reduce((sum, p) => sum + (Number.isFinite(p.pnl) ? p.pnl : 0), 0)
      });
    }

    return groupedAllocations
      .filter(p => Number.isFinite(p.value) && p.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((p, index) => ({
        ...p,
        color: PORTFOLIO_COLORS[index % PORTFOLIO_COLORS.length]
      }));
  }, [positions, totalExposure]);
  const allocationTotal = positionAllocationData.reduce((sum, p) => sum + p.value, 0);
  const openOrderTotals = useMemo(() => {
    return openOrders.reduce(
      (acc, order) => {
        const price = parseFloat(order.price);
        const originalQty = parseFloat(order.origQty);
        const executedQty = parseFloat(order.executedQty || '0');
        const remainingQty = Math.max(0, originalQty - executedQty);
        const notional = (Number.isFinite(price) ? price : 0) * remainingQty;

        acc.totalNotional += notional;
        acc.totalQty += remainingQty;
        if (order.side === 'BUY') acc.buyNotional += notional;
        if (order.side === 'SELL') acc.sellNotional += notional;
        return acc;
      },
      { totalNotional: 0, buyNotional: 0, sellNotional: 0, totalQty: 0 }
    );
  }, [openOrders]);
  const selectedOpenOrder = openOrders.find(order => `${order.symbol}-${order.orderId}` === selectedOpenOrderKey);

  const activeFunding = fundingRates[activeSymbol];

  return (
    <div className="flex min-h-screen text-ink-300 overflow-hidden font-sans selection:bg-accent/25">
      {/* Left rail */}
      <aside className="w-[240px] xl:w-[272px] shrink-0 border-r border-white/[0.06] bg-ink-950/70 flex flex-col z-50">
        <div className="px-5 py-5 flex items-center gap-3 border-b border-white/[0.06]">
          <div className="w-9 h-9 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center">
            <Activity className="text-accent" size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold tracking-tight text-white text-sm">Binance Lite</div>
            <form action="/api/logout" method="POST">
              <button type="submit" className="text-[10px] text-ink-400 hover:text-white">로그아웃</button>
            </form>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-5 overflow-y-auto custom-scrollbar">
          <div>
            <div className="metric-label mb-3 flex items-center justify-between px-1">
              <span>Market</span>
              {wsConnected[activeSymbol] ? (
                <span className="flex items-center gap-1.5 text-[9px] font-semibold text-ok normal-case tracking-normal">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ok opacity-60" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-ok" />
                  </span>
                  LIVE
                </span>
              ) : (
                <span className="text-[9px] text-ink-400 normal-case tracking-normal">connecting…</span>
              )}
            </div>

            <div className={`panel-soft p-4 ${wsConnected[activeSymbol] ? 'border-accent/20' : ''}`}>
              <div className="flex justify-between items-start mb-3">
                <div>
                  <div className="text-[10px] text-ink-400 font-medium mb-0.5">{activeSymbol}</div>
                  <div
                    className={`text-2xl font-mono tracking-tight tabular-nums transition-colors duration-300 ${
                      priceFlash[activeSymbol] === 'up'
                        ? 'text-ok'
                        : priceFlash[activeSymbol] === 'down'
                        ? 'text-danger'
                        : 'text-white'
                    }`}
                  >
                    ${parseFloat(activeStats?.price || '0').toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                  <div className="mt-1 text-[10px] text-ink-400">{formatSeoulTime(activePriceUpdatedAt)} KST</div>
                </div>
                <div className={`text-xs font-semibold px-2 py-0.5 rounded-md ${parseFloat(activeStats?.change24h || '0') >= 0 ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>
                  {formatPct(activeStats?.change24h)}
                </div>
              </div>

              <div className="h-14 opacity-90">
                {activeStats?.history && activeStats.history.length > 1 && (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={activeStats.history.map((h, i) => ({ val: h, i }))}>
                      <YAxis hide domain={['auto', 'auto']} />
                      <Line
                        type="monotone"
                        dataKey="val"
                        stroke={parseFloat(activeStats?.change24h || '0') >= 0 ? '#7fd99a' : '#f07178'}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div className="p-2 rounded-lg bg-ink-950/50 border border-white/[0.04]">
                  <span className="text-ink-400 block mb-0.5 text-[9px]">24H HIGH</span>
                  <span className="text-white">${parseFloat(activeStats?.high24h || '0').toLocaleString()}</span>
                </div>
                <div className="p-2 rounded-lg bg-ink-950/50 border border-white/[0.04]">
                  <span className="text-ink-400 block mb-0.5 text-[9px]">24H LOW</span>
                  <span className="text-white">${parseFloat(activeStats?.low24h || '0').toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-white/[0.06] pt-4">
            <div className="metric-label mb-3 flex items-center justify-between px-1">
              <span className="flex items-center gap-1.5"><Zap size={11} className="text-warn" /> Bulk</span>
              <span className="text-accent normal-case tracking-normal">{orderPercent}%</span>
            </div>
            <input
              type="range"
              min="0.05"
              max="1.0"
              step="0.05"
              value={orderPercent}
              onChange={(e) => setOrderPercent(parseFloat(e.target.value))}
              className="w-full h-1.5 bg-ink-700 rounded-full appearance-none cursor-pointer accent-[var(--color-accent)] mb-3"
            />
            <label className="mb-2 flex items-start gap-2 text-[10px] leading-snug text-ink-300 cursor-pointer">
              <input
                type="checkbox"
                checked={bulkAllPositions}
                onChange={(e) => setBulkAllPositions(e.target.checked)}
                className="mt-0.5 accent-[var(--color-accent)]"
              />
              <span>전체 포지션. 체크 후 롱을 누르면 롱·숏 보유 종목 모두에 롱(매수1호가)이 들어갑니다.</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => handleBulkOrder('BUY', 'LONG')}
                disabled={isAnalysing}
                className="flex flex-col items-center gap-1 p-2.5 rounded-xl bg-ok/10 hover:bg-ok/15 border border-ok/25 transition-all disabled:opacity-50"
              >
                <TrendingUp size={15} className="text-ok" />
                <span className="text-[9px] font-semibold text-ok">LONG +{orderPercent}%</span>
              </button>
              <button
                onClick={() => handleBulkOrder('SELL', 'SHORT')}
                disabled={isAnalysing}
                className="flex flex-col items-center gap-1 p-2.5 rounded-xl bg-danger/10 hover:bg-danger/15 border border-danger/25 transition-all disabled:opacity-50"
              >
                <TrendingDown size={15} className="text-danger" />
                <span className="text-[9px] font-semibold text-danger">SHORT +{orderPercent}%</span>
              </button>
            </div>
            <p className="mt-2 text-[9px] text-ink-400 leading-snug">보유 수량의 {orderPercent}%. 1 ETH면 {(orderPercent / 100).toFixed(4)} ETH. 매수1·매도1 지정가, 주문 사이 {BULK_ORDER_GAP_MS}ms.</p>
          </div>

          <div>
            <div className="metric-label mb-3 flex justify-between items-center px-1">
              <span>Positions ({positions.length})</span>
              {positions.length > 5 && (
                <button onClick={() => setExpandedPosition(!expandedPosition)} className="text-accent hover:underline normal-case tracking-normal text-[10px]">
                  {expandedPosition ? '접기' : '더보기'}
                </button>
              )}
            </div>
            <div className="space-y-1.5 overflow-y-auto custom-scrollbar" style={{ maxHeight: expandedPosition ? 420 : 260 }}>
              {[...positions]
                .sort((a, b) => Math.abs(parseFloat(b.positionAmt) * parseFloat(b.markPrice)) - Math.abs(parseFloat(a.positionAmt) * parseFloat(a.markPrice)))
                .slice(0, expandedPosition ? positions.length : 5)
                .map((pos) => (
                  <button
                    key={pos.symbol}
                    type="button"
                    onClick={() => setActiveSymbol(pos.symbol)}
                    className={`w-full text-left px-3 py-2.5 rounded-xl border transition-colors ${
                      pos.symbol === activeSymbol ? 'border-accent/40 bg-accent-dim' : 'border-white/[0.04] bg-ink-900/40 hover:border-white/10'
                    }`}
                  >
                    <div className="flex justify-between text-xs mb-0.5 gap-2">
                      <span className="font-semibold text-white truncate">{pos.symbol}</span>
                      <span className={`shrink-0 font-mono ${parseFloat(pos.unRealizedProfit) >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {parseFloat(pos.unRealizedProfit) >= 0 ? '+' : ''}{formatUsdCompact(pos.unRealizedProfit)}
                      </span>
                    </div>
                    <div className="text-[10px] text-ink-400 flex justify-between font-mono gap-2">
                      <span>{pos.leverage}x · {pos.marginType}</span>
                      <span className={parseFloat(pos.positionAmt) >= 0 ? 'text-ok/80' : 'text-danger/80'}>
                        {parseFloat(pos.positionAmt) >= 0 ? '+' : ''}{formatQty(pos.positionAmt)}
                      </span>
                    </div>
                  </button>
                ))}
              {positions.length === 0 && (
                <div className="px-2 py-3 text-xs text-ink-400 leading-relaxed">
                  {error || isRateLimitError(dismissedError)
                    ? '일시적으로 포지션을 불러오지 못했습니다. 제한이 끝나면 Sync 하세요.'
                    : '열린 포지션이 없습니다'}
                </div>
              )}
            </div>
          </div>
        </nav>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="border-b border-white/[0.06] bg-ink-950/40 backdrop-blur-md sticky top-0 z-40">
          <div className="min-h-[56px] flex items-center gap-3 px-4 lg:px-6 py-1">
            <div className="hidden xl:flex items-center gap-2 shrink-0">
              <span className="text-ink-400 font-mono text-[11px]">/{activeSymbol}</span>
            </div>

            <div className="flex-1 flex justify-start gap-1 overflow-x-auto custom-scrollbar min-w-0">
              {(headerQuoteSymbols.length
                ? headerQuoteSymbols
                : SYMBOLS.map((symbol) => ({ symbol, usd: 0, mark: 0 }))
              ).map((quote) => {
                const symbol = quote.symbol;
                const ch = parseFloat(stats[symbol]?.change24h || '0');
                const tickerPrice = formatTickerPrice(stats[symbol]?.price);
                return (
                  <button
                    key={symbol}
                    onClick={() => setActiveSymbol(symbol)}
                    title={`${symbol} 포지션 $${formatUsdCompact(quote.usd)}`}
                    className={`flex items-center gap-2 px-2 py-1 rounded-lg border transition-all shrink-0 ${
                      activeSymbol === symbol ? 'bg-accent-dim border-accent/35' : 'border-transparent opacity-80 hover:opacity-100'
                    }`}
                  >
                    <div className="flex flex-col min-w-[72px] items-start leading-tight">
                      <span className="text-[10px] font-semibold text-white">{symbol.replace(/USDT|USDC/g, '')}</span>
                      <span className={`text-[10px] font-mono tabular-nums ${ch >= 0 ? 'text-ok' : 'text-danger'}`}>
                        {tickerPrice ? `$${tickerPrice}` : '…'}
                        <span className="ml-1 opacity-80">
                          {stats[symbol]?.change24h != null ? formatPct(stats[symbol].change24h) : ''}
                        </span>
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex gap-1.5 items-center shrink-0">
              <button
                onClick={refreshAll}
                disabled={isAnalysing}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-ink-850 hover:bg-ink-800 text-ink-300 text-[11px] font-medium disabled:opacity-50"
              >
                <ArrowRightLeft size={13} className={isAnalysing ? 'animate-spin' : ''} />
                <span className="hidden sm:inline">Sync</span>
              </button>
              <button
                onClick={handleSendTelegramSummary}
                disabled={sendingTelegram}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-white/[0.08] bg-ink-850 hover:bg-ink-800 text-ink-300 text-[11px] font-medium disabled:opacity-50"
                title="텔레그램 요약"
              >
                <Bell size={13} className={sendingTelegram ? 'animate-pulse text-accent' : 'text-accent'} />
              </button>
              <div className="hidden md:flex items-center gap-0.5 bg-ink-950 border border-white/[0.06] rounded-lg p-0.5">
                {AI_PROVIDERS.map(provider => (
                  <button
                    key={provider.id}
                    onClick={() => setAiProvider(provider.id)}
                    disabled={isAnalysing}
                    className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all disabled:opacity-50 ${
                      aiProvider === provider.id ? 'bg-accent text-ink-950' : 'text-ink-400 hover:text-white'
                    }`}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
              <button
                onClick={runAnalysis}
                disabled={isAnalysing}
                className="px-2.5 py-1.5 rounded-lg bg-accent hover:brightness-110 text-ink-950 text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-50"
              >
                {isAnalysing ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
                AI
              </button>
            </div>
          </div>

          <div className="px-4 lg:px-6 pb-3 flex flex-wrap gap-2">
            <div
              ref={exposedChipRef}
              className={`kpi-chip relative cursor-pointer select-none ${exposedOpen ? 'border-accent/40' : ''}`}
              onClick={() => setExposedOpen((open) => !open)}
              title={exposedOpen ? '클릭하면 닫기' : '클릭하면 전체노출 내역'}
            >
              <span className="metric-label">Exposed</span>
              <KpiDualMoney usd={totalValuationPlusWallet} rate={usdKrwRate} />
              <div
                className={`absolute left-0 top-full z-[60] mt-1.5 w-[min(380px,calc(100vw-2rem))] rounded-xl border border-white/10 bg-ink-950/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md ${
                  exposedOpen ? 'block pointer-events-auto' : 'hidden pointer-events-none'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                    전체노출
                  </span>
                  {exposedOpen && (
                    <button
                      type="button"
                      className="text-[10px] text-ink-500 hover:text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        setExposedOpen(false);
                      }}
                    >
                      닫기
                    </button>
                  )}
                </div>
                <div className="space-y-1.5 max-h-[min(420px,55vh)] overflow-y-auto custom-scrollbar overscroll-contain">
                  <div className="rounded-lg border border-white/[0.05] overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-white/[0.03]"
                      onClick={() => setExpandedExposedSection((cur) => (cur === 'position' ? null : 'position'))}
                    >
                      <span className="text-ink-300">포지션</span>
                      <span className="text-accent tabular-nums">${formatUsdCompact(totalExposure)}</span>
                    </button>
                    {expandedExposedSection === 'position' && (
                      <ul className="px-2 pb-1.5 space-y-0.5 border-t border-white/[0.04]">
                        {exposedPositionRows.slice(0, 40).map((row) => (
                          <li key={row.symbol} className="flex justify-between gap-2 text-[10px] font-mono py-0.5">
                            <span className="text-ink-400">{row.symbol}</span>
                            <span className="text-white tabular-nums">${formatUsdCompact(row.usd)}</span>
                          </li>
                        ))}
                        {exposedPositionRows.length === 0 && (
                          <li className="text-[10px] text-ink-600 py-1">포지션 없음</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="rounded-lg border border-white/[0.05] overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-white/[0.03]"
                      onClick={() => setExpandedExposedSection((cur) => (cur === 'wallets' ? null : 'wallets'))}
                    >
                      <span className="text-ink-300">전체 지갑{allWalletsOverview ? '' : ' (USD-M)'}</span>
                      <span className="text-accent tabular-nums">${formatUsdCompact(allWalletsUsdtForExposed)}</span>
                    </button>
                    {expandedExposedSection === 'wallets' && (
                      <ul className="px-2 pb-1.5 space-y-0.5 border-t border-white/[0.04]">
                        {(allWalletsOverview?.wallets || [])
                          .filter((w) => Math.abs(w.balanceUsdt) > 0.01)
                          .map((w) => (
                            <li key={w.name} className="flex justify-between gap-2 text-[10px] font-mono py-0.5">
                              <span className="text-ink-400 truncate">{w.name}</span>
                              <span className="text-white tabular-nums">${formatUsdCompact(w.balanceUsdt)}</span>
                            </li>
                          ))}
                        {!allWalletsOverview && (
                          <li className="text-[10px] text-ink-600 py-1">USD-M 담보만 반영 중</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="rounded-lg border border-white/[0.05] overflow-hidden">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-white/[0.03]"
                      onClick={() => setExpandedExposedSection((cur) => (cur === 'jupiter' ? null : 'jupiter'))}
                    >
                      <span className="text-ink-300">Jupiter</span>
                      <span className="text-accent tabular-nums">${formatUsdCompact(jupiterUsdForExposed)}</span>
                    </button>
                    {expandedExposedSection === 'jupiter' && (
                      <ul className="px-2 pb-1.5 space-y-0.5 border-t border-white/[0.04]">
                        {(jupiterPortfolio?.groups || []).map((group) => (
                          <li key={group.id} className="flex justify-between gap-2 text-[10px] font-mono py-0.5">
                            <span className="text-ink-400">{group.name}</span>
                            <span className="text-white tabular-nums">${formatUsdCompact(group.usd)}</span>
                          </li>
                        ))}
                        {!jupiterPortfolio && (
                          <li className="text-[10px] text-ink-600 py-1">불러오는 중…</li>
                        )}
                      </ul>
                    )}
                  </div>
                  <div className="rounded-lg border border-white/[0.05] px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                      <span className="text-ink-300">JLP 디파이</span>
                      <span className="text-accent tabular-nums">${formatUsdCompact(jupiterDefiExtraUsd)}</span>
                    </div>
                    <p className="mt-0.5 text-[10px] font-mono text-ink-500 tabular-nums">
                      {jupiterDefiJlpQty.toLocaleString(undefined, { maximumFractionDigits: 2 })} JLP × $
                      {jupiterDefiJlpPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                    </p>
                  </div>
                </div>
                <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] flex justify-between text-[10px] font-mono text-ink-400">
                  <span>합계</span>
                  <span className="text-white tabular-nums">${formatUsdCompact(totalValuationPlusWallet)}</span>
                </div>
              </div>
            </div>
            <div className="kpi-chip">
              <span className="metric-label">uPNL</span>
              <KpiDualMoney
                usd={totalUPNL}
                rate={usdKrwRate}
                signed
                valueClassName={totalUPNL >= 0 ? 'text-ok' : 'text-danger'}
              />
            </div>
            <div
              ref={allWalletsChipRef}
              className={`kpi-chip relative group cursor-pointer select-none min-w-[110px] ${allWalletsOpen ? 'border-accent/40' : ''}`}
              onClick={() => {
                setAllWalletsOpen((o) => {
                  const next = !o;
                  if (next) {
                    // 캐시 우선 — force는 새로고침 버튼만
                    void fetchAllWalletsOverview({ force: false });
                    void fetchAllWalletsDetails({ force: false });
                  }
                  return next;
                });
              }}
              title={allWalletsOpen ? '클릭하면 닫기' : 'Spot·Earn·Funding 등 전체 지갑'}
            >
              <span className="metric-label">All Wallets</span>
              {allWalletsOverview ? (
                <KpiDualMoney usd={allWalletsOverview.totalUsdt} rate={usdKrwRate} />
              ) : (
                <span className="text-[16.1px] font-mono text-white tabular-nums">
                  {allWalletsError ? '—' : '…'}
                </span>
              )}
              <div
                className={`absolute right-0 top-full z-[60] mt-1.5 w-[min(340px,calc(100vw-2rem))] rounded-xl border border-white/10 bg-ink-950/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md ${
                  allWalletsOpen ? 'block pointer-events-auto' : 'hidden pointer-events-none group-hover:block'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                    전체 지갑 (USDT)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-accent hover:underline disabled:opacity-40"
                      disabled={allWalletsLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        allWalletsOverviewAtRef.current = 0;
                        allWalletsDetailsAtRef.current = 0;
                        void fetchAllWalletsOverview({ force: true });
                        void fetchAllWalletsDetails({ force: true });
                      }}
                    >
                      {allWalletsLoading ? '로딩…' : '새로고침'}
                    </button>
                    {allWalletsOpen && (
                      <button
                        type="button"
                        className="text-[10px] text-ink-500 hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAllWalletsOpen(false);
                        }}
                      >
                        닫기
                      </button>
                    )}
                  </div>
                </div>

                {/* 바이낸스 wallet/balance 총액 목록 */}
                <ul className="space-y-1 max-h-[160px] overflow-y-auto custom-scrollbar overscroll-contain mb-2">
                  {(allWalletsOverview?.wallets || [])
                    .filter((w) => Math.abs(w.balanceUsdt) > 0.01)
                    .map((w) => (
                      <li
                        key={w.name}
                        className="flex items-center justify-between gap-2 text-[11px] font-mono border-b border-white/[0.04] last:border-0 py-1"
                      >
                        <span className="text-ink-300 truncate">{w.name}</span>
                        <span className="text-white tabular-nums">${formatUsdCompact(w.balanceUsdt)}</span>
                      </li>
                    ))}
                  {!allWalletsOverview && !allWalletsError && (
                    <li className="text-[11px] text-ink-500 py-2">불러오는 중…</li>
                  )}
                </ul>

                {/* Spot/Earn(API) + USD-M(로컬) 세부 */}
                {allWalletsDetailSections.length > 0 && (
                  <div className="border-t border-white/[0.06] pt-2 space-y-1.5 max-h-[min(280px,40vh)] overflow-y-auto custom-scrollbar overscroll-contain">
                    <div className="text-[9px] uppercase tracking-wider text-ink-600 mb-1">세부 자산</div>
                    {allWalletsDetailSections.map((sec) => {
                      const open = expandedWalletSection === sec.name;
                      return (
                        <div key={sec.name} className="rounded-lg border border-white/[0.05] overflow-hidden">
                          <button
                            type="button"
                            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-white/[0.03]"
                            onClick={() =>
                              setExpandedWalletSection((cur) => (cur === sec.name ? null : sec.name))
                            }
                          >
                            <span className="text-ink-300">{sec.name}</span>
                            <span className="text-accent tabular-nums">${formatUsdCompact(sec.usdt)}</span>
                          </button>
                          {open && (
                            <ul className="px-2 pb-1.5 space-y-0.5 border-t border-white/[0.04]">
                              {sec.assets.slice(0, 40).map((a) => (
                                <li
                                  key={`${sec.name}-${a.asset}`}
                                  className="grid grid-cols-[1fr_auto_auto] gap-x-2 text-[10px] font-mono py-0.5"
                                >
                                  <span className="text-ink-400">{a.asset}</span>
                                  <span className="text-ink-300 tabular-nums text-right">
                                    {Math.abs(a.qty) >= 1
                                      ? a.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })
                                      : a.qty.toPrecision(4)}
                                  </span>
                                  <span className="text-white tabular-nums text-right w-[64px]">
                                    ${formatUsdCompact(a.usdt)}
                                  </span>
                                </li>
                              ))}
                              {sec.assets.length === 0 && (
                                <li className="text-[10px] text-ink-600 py-1">자산 없음</li>
                              )}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                    {allWalletsDetails?.errors && allWalletsDetails.errors.length > 0 && (
                      <p className="text-[9px] text-warn/80 leading-snug pt-1">
                        일부 조회 실패: {allWalletsDetails.errors.slice(0, 2).join(' · ')}
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] flex justify-between text-[10px] font-mono text-ink-400">
                  <span>합계</span>
                  <span className="text-white tabular-nums">
                    ${formatUsdCompact(allWalletsOverview?.totalUsdt ?? allWalletsDetails?.sections.reduce((s, x) => s + x.usdt, 0) ?? 0)}
                  </span>
                </div>
                {allWalletsError && (
                  <p className="mt-1 text-[9px] text-danger leading-snug">{allWalletsError}</p>
                )}
              </div>
            </div>
            <div
              ref={jupiterChipRef}
              className={`kpi-chip relative group cursor-pointer select-none min-w-[110px] ${jupiterOpen ? 'border-accent/40' : ''}`}
              onClick={() => setJupiterOpen((open) => !open)}
              title="Jupiter API 순자산은 Exposed와 시나리오에 포함됩니다. 별도 JLP는 포지션이라 순자산에서 제외합니다."
            >
              <span className="metric-label">Jupiter</span>
              {jupiterPortfolio ? (
                <KpiDualMoney usd={jupiterPortfolio.totalUsd} rate={usdKrwRate} />
              ) : (
                <span className="text-[16.1px] font-mono text-white tabular-nums">
                  {jupiterError ? '—' : '…'}
                </span>
              )}
              <div
                className={`absolute right-0 top-full z-[60] mt-1.5 w-[min(380px,calc(100vw-2rem))] rounded-xl border border-white/10 bg-ink-950/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md ${
                  jupiterOpen ? 'block pointer-events-auto' : 'hidden pointer-events-none group-hover:block'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                    Jupiter (USD)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-accent hover:underline disabled:opacity-40"
                      disabled={jupiterLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        void fetchJupiterPortfolio({ force: true });
                      }}
                    >
                      {jupiterLoading ? '로딩…' : '새로고침'}
                    </button>
                    {jupiterOpen && (
                      <button
                        type="button"
                        className="text-[10px] text-ink-500 hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setJupiterOpen(false);
                        }}
                      >
                        닫기
                      </button>
                    )}
                  </div>
                </div>
                {jupiterPortfolio?.address && (
                  <a
                    href={`https://jup.ag/portfolio/${jupiterPortfolio.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mb-1.5 block text-[10px] font-mono text-ink-500 hover:text-accent truncate"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {jupiterPortfolio.address}
                  </a>
                )}
                <div className="space-y-1.5 max-h-[min(360px,50vh)] overflow-y-auto custom-scrollbar overscroll-contain">
                  {(jupiterPortfolio?.groups || []).map((group) => {
                    const open = expandedJupiterGroup === group.id;
                    return (
                      <div key={group.id} className="rounded-lg border border-white/[0.05] overflow-hidden">
                        <button
                          type="button"
                          className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-mono hover:bg-white/[0.03]"
                          onClick={() =>
                            setExpandedJupiterGroup((cur) => (cur === group.id ? null : group.id))
                          }
                        >
                          <span className="text-ink-300">{group.name}</span>
                          <span className="text-accent tabular-nums">${formatUsdCompact(group.usd)}</span>
                        </button>
                        {open && (
                          <ul className="px-2 pb-1.5 space-y-0.5 border-t border-white/[0.04]">
                            {group.rows.slice(0, 40).map((row, idx) => (
                              <li
                                key={`${group.id}-${row.side}-${row.symbol}-${idx}`}
                                className="grid grid-cols-[1fr_auto_auto] gap-x-2 text-[10px] font-mono py-0.5"
                              >
                                <span className="text-ink-400 truncate">
                                  {row.side === 'supply'
                                    ? '공급 '
                                    : row.side === 'borrow'
                                      ? '대출 '
                                      : row.side === 'reward'
                                        ? '보상 '
                                        : row.side === 'stake'
                                          ? '스테이크 '
                                          : ''}
                                  {row.symbol}
                                </span>
                                <span className="text-ink-300 tabular-nums text-right">
                                  {Math.abs(row.qty) >= 1
                                    ? row.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })
                                    : row.qty.toPrecision(4)}
                                </span>
                                <span className="text-white tabular-nums text-right w-[72px]">
                                  ${formatUsdCompact(row.usd)}
                                </span>
                              </li>
                            ))}
                            {group.rows.length === 0 && (
                              <li className="text-[10px] text-ink-600 py-1">세부 없음</li>
                            )}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  {!jupiterPortfolio && !jupiterError && (
                    <p className="text-[11px] text-ink-500 py-2">불러오는 중…</p>
                  )}
                </div>
                <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] flex justify-between text-[10px] font-mono text-ink-400">
                  <span>순자산</span>
                  <span className="text-white tabular-nums">
                    ${formatUsdCompact(jupiterPortfolio?.totalUsd ?? 0)}
                  </span>
                </div>
                <p className="mt-1 text-[9px] text-ink-600 leading-snug">
                  솔라나 순자산은 Exposed와 시나리오에 포함됩니다. 별도 JLP는 포지션이라 순자산에서 뺍니다. 스테이블은 고정, 그 외·대출은 Δ%로 재평가합니다.
                </p>
                {jupiterError && (
                  <p className="mt-1 text-[9px] text-danger leading-snug">{jupiterError}</p>
                )}
              </div>
            </div>
            <div className="kpi-chip">
              <span className="metric-label">Position</span>
              <KpiDualMoney usd={totalExposure} rate={usdKrwRate} />
            </div>
            <div
              ref={walletChipRef}
              className={`kpi-chip relative group cursor-pointer select-none ${walletAssetsOpen ? 'border-accent/40' : ''}`}
              onClick={() => setWalletAssetsOpen((o) => !o)}
              title={walletAssetsOpen ? '클릭하면 닫기' : '클릭하면 담보 내역 고정'}
            >
              <span className="metric-label">Collateral</span>
              <KpiDualMoney usd={parseFloat(accountBalance) || 0} rate={usdKrwRate} />
              <div
                className={`absolute left-0 top-full z-[60] mt-1.5 w-[280px] rounded-xl border border-white/10 bg-ink-950/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md ${
                  walletAssetsOpen
                    ? 'block pointer-events-auto'
                    : 'hidden pointer-events-none group-hover:block'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">담보 자산</span>
                  {walletAssetsOpen && (
                    <button
                      type="button"
                      className="text-[10px] text-ink-500 hover:text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWalletAssetsOpen(false);
                      }}
                    >
                      닫기
                    </button>
                  )}
                </div>
                {walletCollateralRows.length === 0 ? (
                  <div className="text-[11px] text-ink-500 py-2">자산 없음</div>
                ) : (
                  <>
                    <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-x-2 px-0.5 text-[9px] uppercase tracking-wider text-ink-600">
                      <span>Asset</span>
                      <span className="text-right">Qty</span>
                      <span className="text-right w-[72px]">USDT</span>
                    </div>
                    <ul className="space-y-1 max-h-[min(320px,50vh)] overflow-y-auto custom-scrollbar overscroll-contain">
                      {walletCollateralRows.map((row) => {
                        const qtyText = row.stable
                          ? formatUsdCompact(row.qty)
                          : Math.abs(row.qty) >= 1
                            ? row.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })
                            : row.qty.toPrecision(4);
                        return (
                          <li
                            key={row.asset}
                            className="grid grid-cols-[1fr_auto_auto] gap-x-2 items-center text-[11px] font-mono border-b border-white/[0.04] last:border-0 py-1"
                          >
                            <span className="text-ink-300 truncate">
                              {row.asset}
                              {row.stable && <span className="ml-1 text-[9px] text-ink-600">stable</span>}
                            </span>
                            <span className={`tabular-nums text-right ${row.qty >= 0 ? 'text-white' : 'text-danger'}`}>
                              {qtyText}
                            </span>
                            <span className={`tabular-nums text-right w-[72px] ${row.usdt >= 0 ? 'text-accent' : 'text-danger'}`}>
                              ${formatUsdCompact(row.usdt)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
                <div className="mt-1.5 pt-1.5 border-t border-white/[0.06] space-y-0.5 text-[10px] font-mono text-ink-400">
                  <div className="flex justify-between gap-2">
                    <span>시가평가 합</span>
                    <span className="text-accent tabular-nums">${formatUsdCompact(walletCollateralUsdtSum)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span>Wallet(바이낸스)</span>
                    <span className="text-white tabular-nums">${formatUsdCompact(accountBalance)}</span>
                  </div>
                  <p className="text-[9px] text-ink-600 leading-snug pt-0.5">
                    비Stable = 수량×마크. Wallet 합은 담보할인 반영값이라 시가합과 다를 수 있음.
                  </p>
                </div>
              </div>
            </div>
            <div className="kpi-chip">
              <span className="metric-label">Margin</span>
              <KpiDualMoney
                usd={parseFloat(accountInfo?.totalMarginBalance || '0') || 0}
                rate={usdKrwRate}
                valueClassName="text-accent"
              />
            </div>
            <div className="kpi-chip hidden sm:flex">
              <span className="metric-label">Pos / Ord</span>
              <span className="text-[16.1px] font-mono text-white tabular-nums">{positions.length} / {openOrders.length}</span>
            </div>
            <div
              ref={trades24hChipRef}
              className={`kpi-chip relative group cursor-pointer select-none min-w-[118px] ${trades24hOpen ? 'border-accent/40' : ''}`}
              onClick={() => {
                setTrades24hOpen((o) => {
                  const next = !o;
                  if (next) void fetchTrades24h({ force: false });
                  return next;
                });
              }}
              title={trades24hOpen ? '클릭하면 닫기' : '지난 24시간 매수/매도 합계'}
            >
              <span className="metric-label">24h 매수 / 매도</span>
              {trades24h ? (
                <span className="text-sm font-mono tabular-nums leading-tight">
                  <span className="text-ok">${formatUsdCompact(trades24h.buyUsd)}</span>
                  <span className="text-ink-600"> / </span>
                  <span className="text-danger">${formatUsdCompact(trades24h.sellUsd)}</span>
                </span>
              ) : (
                <span className="text-sm font-mono text-white tabular-nums">
                  {trades24hError ? '—' : trades24hLoading ? '…' : '…'}
                </span>
              )}
              <div
                className={`absolute right-0 top-full z-[60] mt-1.5 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-white/10 bg-ink-950/95 p-2.5 shadow-2xl shadow-black/50 backdrop-blur-md ${
                  trades24hOpen ? 'block pointer-events-auto' : 'hidden pointer-events-none group-hover:block'
                }`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                    지난 24시간 체결
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-[10px] text-accent hover:underline disabled:opacity-40"
                      disabled={trades24hLoading}
                      onClick={(e) => {
                        e.stopPropagation();
                        void fetchTrades24h({ force: true });
                      }}
                    >
                      {trades24hLoading ? '로딩…' : '새로고침'}
                    </button>
                    {trades24hOpen && (
                      <button
                        type="button"
                        className="text-[10px] text-ink-500 hover:text-white"
                        onClick={(e) => {
                          e.stopPropagation();
                          setTrades24hOpen(false);
                        }}
                      >
                        닫기
                      </button>
                    )}
                  </div>
                </div>
                {trades24hError && !trades24h && (
                  <div className="text-[11px] text-danger py-2 leading-snug">{trades24hError}</div>
                )}
                {(['BUY', 'SELL'] as const).map((side) => {
                  const rows = side === 'BUY' ? trades24h?.buy || [] : trades24h?.sell || [];
                  const usd = side === 'BUY' ? trades24h?.buyUsd || 0 : trades24h?.sellUsd || 0;
                  const open = trades24hSection === side;
                  return (
                    <div key={side} className="mb-1 last:mb-0">
                      <button
                        type="button"
                        className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left border ${
                          open ? 'border-white/15 bg-white/[0.04]' : 'border-transparent hover:bg-white/[0.03]'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTrades24hSection((cur) => (cur === side ? null : side));
                        }}
                      >
                        <span className={`text-[11px] font-semibold ${side === 'BUY' ? 'text-ok' : 'text-danger'}`}>
                          {side === 'BUY' ? '매수' : '매도'}
                          <span className="ml-1.5 text-[10px] font-normal text-ink-500">{rows.length}건</span>
                        </span>
                        <span className={`text-[12px] font-mono tabular-nums ${side === 'BUY' ? 'text-ok' : 'text-danger'}`}>
                          ${formatUsdCompact(usd)}
                          {usdKrwRate != null && Number.isFinite(usdKrwRate) ? (
                            <span className="ml-1.5 text-[10px] text-ink-500">₩{formatUsdCompact(usd * usdKrwRate)}</span>
                          ) : null}
                        </span>
                      </button>
                      {open && (
                        <div className="mt-1 mb-1.5 px-1">
                          {rows.length === 0 ? (
                            <div className="text-[11px] text-ink-500 py-2">체결 없음</div>
                          ) : (
                            <>
                              <div className="mb-1 grid grid-cols-[72px_1fr_auto] gap-x-2 px-0.5 text-[9px] uppercase tracking-wider text-ink-600">
                                <span>Time</span>
                                <span>Symbol</span>
                                <span className="text-right">USDT</span>
                              </div>
                              <ul className="space-y-1 max-h-[min(280px,40vh)] overflow-y-auto custom-scrollbar overscroll-contain">
                                {rows.map((row) => (
                                  <li
                                    key={`${row.symbol}-${row.id}`}
                                    className="grid grid-cols-[72px_1fr_auto] gap-x-2 items-start text-[11px] font-mono border-b border-white/[0.04] last:border-0 py-1"
                                  >
                                    <span className="text-ink-500 tabular-nums text-[10px] leading-snug">
                                      {formatSeoulTime(row.time).split(' ').slice(-1)[0] || formatSeoulTime(row.time)}
                                    </span>
                                    <span className="min-w-0">
                                      <span className="text-white truncate block">{row.symbol.replace(/USDT|USDC/g, '')}</span>
                                      <span className="text-[10px] text-ink-500 tabular-nums">
                                        {formatQty(row.qty)} @ {row.price >= 1 ? row.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : row.price}
                                      </span>
                                    </span>
                                    <span className={`tabular-nums text-right ${side === 'BUY' ? 'text-ok' : 'text-danger'}`}>
                                      ${formatUsdCompact(row.quoteQty)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <p className="mt-1.5 pt-1.5 border-t border-white/[0.06] text-[9px] text-ink-600 leading-snug">
                  선물 체결 기준. 포지션·주문·손익 심볼만 조회합니다.
                </p>
              </div>
            </div>
          </div>

          {error && positions.length > 0 && (
            <div className="mx-4 lg:mx-6 mb-3 flex items-start gap-3 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
              <ShieldAlert size={14} className="shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-warn mb-0.5">
                  {isRateLimitError(error) ? 'Binance 일시 요청 제한' : 'API 경고'}
                </div>
                <div className="text-ink-300 break-all leading-relaxed">{error}</div>
              </div>
              <button
                onClick={dismissError}
                className="shrink-0 p-1 rounded-md hover:bg-white/5 text-ink-400"
                title="닫기"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 p-5 lg:p-6 grid grid-cols-12 gap-4 overflow-y-auto custom-scrollbar content-start">
          {/* Portfolio */}
          <section className="col-span-12 xl:col-span-8 panel p-6 flex flex-col relative overflow-hidden">
            <div className="flex flex-wrap justify-between items-start gap-4 mb-5 relative z-10">
              <div>
                <div className="metric-label mb-1 flex items-center gap-2">
                  <PieChart size={12} className="text-accent" /> Portfolio
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">Allocation & Risk</h1>
              </div>
              {liquidationPriceEstimate && (
                <div className="kpi-chip border-danger/25 bg-danger/5">
                  <span className="metric-label text-danger">Est. Liq ({activeSymbol})</span>
                  <span className="text-[16.1px] font-mono text-danger tabular-nums">
                    ${liquidationPriceEstimate.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
            </div>

            <div className="flex-1 flex flex-col lg:flex-row gap-6 min-h-[260px]">
              <div className="w-full lg:w-[42%] min-h-[220px]">
                {positionAllocationData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <RePieChart>
                      <Pie
                        data={positionAllocationData}
                        cx="50%"
                        cy="50%"
                        outerRadius="80%"
                        innerRadius="48%"
                        paddingAngle={2}
                        minAngle={3}
                        dataKey="value"
                        nameKey="name"
                        stroke="#11151c"
                        strokeWidth={2}
                        isAnimationActive={false}
                      >
                        {positionAllocationData.map((entry) => (
                          <Cell key={`cell-${entry.symbol}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#11151c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', fontSize: '12px' }}
                        itemStyle={{ color: '#fff' }}
                        formatter={(value: number | string, name: string) => {
                          const numericValue = Number(value);
                          const percent = allocationTotal > 0 ? ((numericValue / allocationTotal) * 100).toFixed(1) : '0.0';
                          return [`$${numericValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${percent}%)`, name];
                        }}
                      />
                    </RePieChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full min-h-[220px] flex items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-ink-400">
                    No open position data
                  </div>
                )}
              </div>

              <div className="w-full lg:w-[58%] space-y-2">
                <div className="metric-label mb-2">Top constituents</div>
                <div className="grid grid-cols-2 gap-2 max-h-[280px] overflow-y-auto custom-scrollbar pr-1">
                  {positionAllocationData.filter(p => p.symbol !== 'OTHERS').slice(0, 8).map((p) => (
                    <div key={p.symbol} className="panel-soft p-3 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                        <span className="text-sm font-semibold text-white">{p.name}</span>
                      </div>
                      <div className="flex justify-between items-end font-mono">
                        <span className="text-xs text-ink-400">
                          ${p.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          <span className="opacity-50 ml-1">({allocationTotal > 0 ? ((p.value / allocationTotal) * 100).toFixed(1) : '0.0'}%)</span>
                        </span>
                        <span className={`text-xs ${p.pnl >= 0 ? 'text-ok' : 'text-danger'}`}>
                          {p.pnl >= 0 ? '+' : ''}{Math.round(p.pnl)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-5 pt-5 border-t border-white/[0.06]">
              <div className="metric-label mb-2">7D exposure / est. uPNL</div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={estimated7DPNL}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" fontSize={10} tick={{ fill: '#8b98ad' }} />
                  <YAxis yAxisId="left" hide />
                  <YAxis yAxisId="right" orientation="right" hide />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#11151c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px', fontSize: '11px' }}
                    labelStyle={{ color: '#8b98ad' }}
                    itemStyle={{ color: '#fff' }}
                    formatter={(value: number | string, name: string) => {
                      const n = Number(value);
                      if (!Number.isFinite(n)) return ['—', name];
                      if (name === 'Exposure') {
                        return [`$${Math.round(n).toLocaleString()}`, name];
                      }
                      const signed = `${n >= 0 ? '+' : ''}${n.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`;
                      return [`$${signed}`, name];
                    }}
                  />
                  <Line yAxisId="left" type="monotone" dataKey="exposure" stroke="#3ecfbf" strokeWidth={2} dot={false} name="Exposure" />
                  <Line yAxisId="right" type="monotone" dataKey="pnl" stroke="#e8b86d" strokeWidth={2} dot={false} name="Est. uPNL" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Merged Activity: Income + Realized History */}
          <section className="col-span-12 md:col-span-6 xl:col-span-4 panel p-5 flex flex-col min-h-[420px]">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2 text-accent">
                <DollarSign size={15} />
                <span className="text-sm font-semibold text-white">
                  {historyRangeLabel(historyDays)} Activity
                </span>
                <span className="text-[10px] text-ink-400 font-mono">
                  ({sevenDayIncome.length}{incomeListFilter !== 'ALL' ? `/${rangedIncome.length}` : ''})
                </span>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setShowCoinDetails(!showCoinDetails)}
                  className="seg-btn seg-btn-off"
                >
                  {showCoinDetails ? '목록' : '코인별'}
                </button>
                <button
                  onClick={() => fetchHistoryData()}
                  disabled={historyLoading}
                  className="p-1.5 rounded-lg hover:bg-white/5 text-ink-400"
                  title="새로고침"
                >
                  <RefreshCw size={12} className={historyLoading ? 'animate-spin' : ''} />
                </button>
              </div>
            </div>

            {historyLoading && (
              <div className="text-[10px] text-ink-400 mb-2">
                fetching{historyProgress.iter > 0 ? ` · step ${historyProgress.iter}` : ''} · {historyProgress.collected}
              </div>
            )}

            <div className="flex gap-1 mb-2 flex-wrap">
              {[
                { days: 7, label: '7D' },
                { days: 30, label: '30D' },
                { days: 90, label: '90D' },
                { days: 92, label: '3M' },
              ].map(r => (
                <button
                  key={r.label}
                  onClick={() => setHistoryDays(r.days)}
                  disabled={historyLoading}
                  className={`seg-btn ${historyDays === r.days ? 'seg-btn-on' : 'seg-btn-off'} disabled:opacity-50`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div className="flex gap-1 mb-3 flex-wrap">
              {([
                { id: 'REALIZED_PNL' as const, label: '실현' },
                { id: 'FUNDING_FEE' as const, label: '펀딩' },
                { id: 'COMMISSION' as const, label: '수수료' },
                { id: 'ALL' as const, label: '전체' },
              ]).map(f => (
                <button
                  key={f.id}
                  onClick={() => setIncomeListFilter(f.id)}
                  className={`seg-btn ${incomeListFilter === f.id ? 'seg-btn-on' : 'seg-btn-off'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {showCoinDetails ? (
              <div className="flex-1 overflow-y-auto space-y-4 custom-scrollbar max-h-[280px] pr-1">
                {Object.keys(aggregatedIncome.pnl).length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-accent mb-2">Realized</div>
                    <div className="space-y-1">
                      {Object.entries(aggregatedIncome.pnl).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([symbol, total]) => (
                        <div key={symbol} className="text-sm flex justify-between py-1.5 border-b border-white/[0.04] font-mono">
                          <span className="text-white">{symbol}</span>
                          <span className={(total as number) >= 0 ? 'text-ok' : 'text-danger'}>{formatIncomeAmount(total as number)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {Object.keys(aggregatedIncome.funding).length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-warn mb-2">Funding</div>
                    <div className="space-y-1">
                      {Object.entries(aggregatedIncome.funding).sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number)).slice(0, 12).map(([symbol, total]) => (
                        <div key={symbol} className="text-sm flex justify-between py-1.5 border-b border-white/[0.04] font-mono">
                          <span className="text-white">{symbol}</span>
                          <span className={(total as number) >= 0 ? 'text-ok' : 'text-danger'}>{formatIncomeAmount(total as number)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-0.5 custom-scrollbar max-h-[280px] pr-1">
                {sevenDayIncome
                  .slice(0, expandedIncome ? sevenDayIncome.length : 10)
                  .map((income, idx) => (
                    <div key={`${income.tranId}-${idx}`} className="text-sm flex justify-between items-center py-2.5 border-b border-white/[0.04] font-mono hover:bg-white/[0.02] px-1 rounded">
                      <div className="flex flex-col min-w-0">
                        <span className="text-white font-semibold truncate">{income.symbol || '—'}</span>
                        <span className="text-ink-400 text-[10px]">
                          {income.incomeType.replace('_', ' ')}
                          {income.asset && income.asset !== 'USDT' ? ` · ${income.asset}` : ''}
                        </span>
                      </div>
                      <div className="text-right flex flex-col shrink-0">
                        <span className={parseFloat(income.income) >= 0 ? 'text-ok' : 'text-danger'}>
                          {formatIncomeAmount(income.income)}
                        </span>
                        <span className="text-ink-400 text-[10px]">
                          {new Date(income.time).toLocaleDateString()} {new Date(income.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    </div>
                  ))}
                {historyLoading && sevenDayIncome.length === 0 && (
                  <div className="py-10 text-center text-ink-400 text-sm">{historyRangeLabel(historyDays)} 불러오는 중…</div>
                )}
                {!historyLoading && sevenDayIncome.length === 0 && (
                  <div className="py-8 text-center text-sm space-y-2">
                    <div className="text-ink-400/70 italic">기록이 없습니다 ({historyRangeLabel(historyDays)})</div>
                    {isRateLimitError(error) && (
                      <div className="text-[11px] text-warn px-3">요청 제한이 풀린 뒤 Sync 또는 새로고침을 눌러주세요.</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {sevenDayIncome.length > 10 && (
              <button onClick={() => setExpandedIncome(!expandedIncome)} className="mt-2 text-[11px] text-accent self-end hover:underline">
                {expandedIncome ? '접기' : '더보기'}
              </button>
            )}

            <div className="mt-3 pt-3 border-t border-white/[0.06] font-mono text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-ink-400">Realized</span>
                <span className={aggregatedIncome.realizedPnl >= 0 ? 'text-ok' : 'text-danger'}>{formatIncomeAmount(aggregatedIncome.realizedPnl)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-400">Funding</span>
                <span className={aggregatedIncome.fundingFees >= 0 ? 'text-ok' : 'text-danger'}>{formatIncomeAmount(aggregatedIncome.fundingFees)}</span>
              </div>
              <div className="flex justify-between pt-1 border-t border-white/[0.04]">
                <span className="text-ink-300 font-semibold">{historyRangeLabel(historyDays)} Net</span>
                <span className={`font-semibold ${aggregatedIncome.netIncome >= 0 ? 'text-ok' : 'text-danger'}`}>{formatIncomeAmount(aggregatedIncome.netIncome)}</span>
              </div>
            </div>
          </section>

          {/* Open Orders */}
          <section className="col-span-12 md:col-span-6 xl:col-span-4 panel p-5 flex flex-col min-h-[320px]">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <ListFilter size={15} className="text-warn" />
                <span className="text-sm font-semibold text-white">Open Orders</span>
                <span className="text-[10px] text-ink-400 font-mono">({openOrders.length})</span>
              </div>
              <div className="flex items-center gap-1">
                {selectedOpenOrder && (
                  <>
                    <button
                      onClick={handleLimitBuyFromSelectedOrder}
                      disabled={!!placingBuyOrderKey || !!cancellingOrderKey}
                      className="seg-btn border-ok/30 text-ok bg-ok/10"
                    >
                      매수
                    </button>
                    <button
                      onClick={handleCancelOpenOrder}
                      disabled={!!cancellingOrderKey || !!placingBuyOrderKey}
                      className="seg-btn border-danger/30 text-danger bg-danger/10"
                    >
                      취소
                    </button>
                  </>
                )}
                {openOrders.length > 5 && (
                  <button onClick={() => setExpandedOrders(!expandedOrders)} className="text-[11px] text-accent hover:underline">
                    {expandedOrders ? '접기' : '더보기'}
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mb-3 text-[10px] font-mono">
              <div className="panel-soft p-2">
                <div className="text-ink-400">Total</div>
                <div className="text-white">${Math.round(openOrderTotals.totalNotional).toLocaleString()}</div>
              </div>
              <div className="panel-soft p-2">
                <div className="text-ok">Buy</div>
                <div className="text-ok">${Math.round(openOrderTotals.buyNotional).toLocaleString()}</div>
              </div>
              <div className="panel-soft p-2">
                <div className="text-danger">Sell</div>
                <div className="text-danger">${Math.round(openOrderTotals.sellNotional).toLocaleString()}</div>
              </div>
            </div>

            <div className={`flex-1 overflow-y-auto custom-scrollbar space-y-1 max-h-[240px]`}>
              {[...openOrders]
                .sort((a, b) => b.time - a.time)
                .slice(0, expandedOrders ? openOrders.length : 6)
                .map(order => {
                  const key = `${order.symbol}-${order.orderId}`;
                  const selected = selectedOpenOrderKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedOpenOrderKey(selected ? null : key)}
                      className={`w-full text-left px-2.5 py-2 rounded-xl border font-mono text-xs transition-colors ${
                        selected ? 'border-accent/40 bg-accent-dim' : 'border-white/[0.04] hover:border-white/10'
                      }`}
                    >
                      <div className="flex justify-between mb-0.5">
                        <span className={order.side === 'BUY' ? 'text-ok font-semibold' : 'text-danger font-semibold'}>{order.side}</span>
                        <span className="text-white">{order.symbol}</span>
                      </div>
                      <div className="flex justify-between text-ink-400 text-[10px]">
                        <span>{order.type} @ ${Number(order.price).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                        <span>{formatQty(order.origQty)}</span>
                      </div>
                    </button>
                  );
                })}
              {openOrders.length === 0 && <div className="py-8 text-center text-ink-400/50 text-sm italic">No open orders</div>}
            </div>
          </section>

          {/* Scenario */}
          <section className="col-span-12 lg:col-span-6 xl:col-span-4 panel p-5 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BarChart3 size={15} className="text-accent" />
                <span className="text-sm font-semibold text-white">Scenario</span>
              </div>
              <button onClick={() => setShowScenarios(!showScenarios)} className="text-[11px] text-accent hover:underline">
                {showScenarios ? '간단히' : '표 펼치기'}
              </button>
            </div>
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-left text-[11px] font-mono">
                <thead>
                  <tr className="text-ink-400 border-b border-white/[0.06]">
                    <th className="py-2 font-medium">Δ%</th>
                    <th className="py-2 font-medium">순자산</th>
                    <th className="py-2 font-medium">Cushion</th>
                    <th className="py-2 font-medium">M.Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {(showScenarios ? scenarioResults : scenarioResults.filter((r) => r.pct % 10 === 0 || r.pct === 0)).map((row) => {
                    const liq = row.liquidated;
                    const mrText =
                      row.marginRatio >= 999 ? '≥999%' :
                      row.marginRatio >= 100 ? `${row.marginRatio.toFixed(0)}%` :
                      `${row.marginRatio.toFixed(1)}%`;
                    const cushionText = liq
                      ? '0%'
                      : `${row.cushionPercent.toFixed(1)}%`;
                    return (
                      <tr key={row.pct} className={`border-b border-white/[0.03] ${liq ? 'bg-danger/5' : ''}`}>
                        <td className="py-1.5 text-white">{row.pct > 0 ? '+' : ''}{row.pct}%</td>
                        <td className={`py-1.5 tabular-nums ${row.marginBalance < 0 ? 'text-danger' : 'text-ink-300'}`}>
                          {Math.round(row.marginBalance).toLocaleString()}
                          {liq && <span className="ml-1 text-[9px] text-danger font-semibold">LIQ</span>}
                        </td>
                        <td className={`py-1.5 tabular-nums ${liq || row.cushionPercent < 0 ? 'text-danger' : 'text-ink-300'}`}>
                          {cushionText}
                        </td>
                        <td className={`py-1.5 tabular-nums ${liq ? 'text-danger font-semibold' : 'text-ink-300'}`}>
                          {mrText}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="mt-3 text-[10px] text-ink-400 space-y-1 leading-relaxed">
              <li>Δ% 시 포지션 마크·uPnL·유지증거금 + 비스테이블 담보(Jupiter 포함)를 같이 반영</li>
              <li>순자산: (USD-M + Spot·Funding·Earn + Jupiter API 순자산) + 선물 uPnL. 별도 JLP 포지션은 제외</li>
              <li>Cushion: (순자산 − 유지증거금) ÷ |순노출| · 청산 시 0%</li>
              <li>청산(포트폴리오 관점): 순자산 ≤ 유지증거금 또는 M.Ratio ≥ 100%</li>
              <li>
                담보 합 $
                {scenarioCollateral.totalWallet.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                {' '}(USD-M $
                {scenarioCollateral.futuresWallet.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                {(() => {
                  const otherExtra = scenarioCollateral.extraWallet - (scenarioCollateral.jupiterUsd || 0);
                  const parts: string[] = [];
                  if (otherExtra > 0.5) {
                    parts.push(
                      ` + 기타 $${otherExtra.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    );
                  }
                  if (scenarioCollateral.jupiterUsd) {
                    parts.push(
                      ` + Jupiter $${scenarioCollateral.jupiterUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    );
                  } else if (!jupiterPortfolio) {
                    parts.push(' · Jupiter 대기');
                  }
                  if (!parts.length && !allWalletsDetails) parts.push(' · 기타지갑 로딩/권한 대기');
                  return parts.join('');
                })()}
                )
              </li>
              <li>
                스테이블 $
                {scenarioCollateral.stableUsdt.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                {scenarioCollateral.stableAssets.length > 0
                  ? ` (${scenarioCollateral.stableAssets.join(',')})`
                  : ''}{' '}
                고정 · 변동 $
                {scenarioCollateral.volatileUsdt.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                {scenarioCollateral.volatileAssets.length > 0
                  ? ` (${scenarioCollateral.volatileAssets.join(',')})`
                  : ''}{' '}
                × (1+Δ%)
              </li>
              {scenarioCollateral.extraByWallet.length > 0 && (
                <li>
                  기타지갑:{' '}
                  {scenarioCollateral.extraByWallet
                    .map(
                      (w) =>
                        `${w.name} $${(w.stable + w.volatile).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    )
                    .join(' · ')}
                </li>
              )}
            </ul>
          </section>

          {/* Manual + log */}
          <section className="col-span-12 lg:col-span-6 xl:col-span-4 panel p-5 flex flex-col gap-3">
            <div className="metric-label flex items-center gap-1.5"><Settings size={11} /> Manual order</div>
            <div className="flex flex-wrap gap-2">
              <select
                value={heldSymbols.includes(manualOrderSymbol) ? manualOrderSymbol : (heldSymbols[0] || '')}
                onChange={e => setManualOrderSymbol(e.target.value)}
                disabled={heldSymbols.length === 0}
                className="flex-1 min-w-[140px] bg-ink-950 border border-white/[0.08] rounded-lg px-2 py-2 text-sm font-mono text-white outline-none focus:border-accent/40 disabled:opacity-50"
              >
                {heldSymbols.length === 0 ? (
                  <option value="">보유 종목 없음</option>
                ) : heldSymbols.map(symbol => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
              <select
                value={manualOrderSide}
                onChange={e => setManualOrderSide(e.target.value as 'BUY' | 'SELL')}
                className="bg-ink-950 border border-white/[0.08] rounded-lg px-2 py-2 text-sm font-mono text-white"
              >
                <option value="BUY">BUY</option>
                <option value="SELL">SELL</option>
              </select>
              <input
                value={manualOrderQty}
                onChange={e => setManualOrderQty(e.target.value)}
                className="w-24 bg-ink-950 border border-white/[0.08] rounded-lg px-3 py-2 text-sm font-mono text-white outline-none focus:border-accent/40"
                placeholder="Qty"
              />
              <button
                onClick={executeManualOrder}
                disabled={submittingManualOrder || !heldSymbols.includes(manualOrderSymbol)}
                className="px-4 py-2 rounded-lg bg-accent text-ink-950 text-xs font-semibold disabled:opacity-50"
              >
                {submittingManualOrder ? '…' : 'Execute'}
              </button>
            </div>
            <div className="panel-soft p-3 max-h-[120px] overflow-y-auto custom-scrollbar font-mono text-[10px] text-ink-400 space-y-1">
              {debugLog.length === 0 ? (
                <span className="italic opacity-60">Log empty</span>
              ) : (
                debugLog.map((log, i) => (
                  <div key={i}><span className="text-ink-600">{log.time}</span> {log.msg}</div>
                ))
              )}
            </div>
          </section>
        </div>

        {/* AI chat — viewport bottom-right */}
        <div className="fixed bottom-4 right-4 z-50 w-[min(360px,calc(100vw-1.5rem))] panel shadow-2xl shadow-black/40 border-accent/20 overflow-hidden flex flex-col max-h-[min(520px,70vh)]">
          <div className="px-3.5 py-2.5 border-b border-white/[0.06] flex items-center justify-between gap-2 bg-ink-950/60">
            <p className="text-ink-400 text-xs leading-snug truncate">
              <span className="text-accent font-semibold">AI</span>
              <span className="text-ink-600"> · </span>
              <span className="text-ink-300">{aiProvider}</span>
              <span className="text-ink-600"> · </span>
              <span className="text-white font-mono">{activeSymbol}</span>
            </p>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={runAnalysis}
                disabled={isAnalysing}
                className="p-1.5 rounded-lg hover:bg-white/5 text-accent disabled:opacity-50"
                title={`Re-scan ${activeSymbol}`}
              >
                {isAnalysing ? <RefreshCw size={13} className="animate-spin" /> : <Zap size={13} />}
              </button>
              <button
                onClick={() => setAiChatOpen(o => !o)}
                className="px-2 py-1 rounded-lg text-[10px] text-ink-400 hover:text-white hover:bg-white/5"
              >
                {aiChatOpen ? '접기' : '펼치기'}
              </button>
            </div>
          </div>

          {aiChatOpen && (
            <>
              {activeInsight && (
                <div className="px-3.5 pt-2 text-[10px] text-ink-400 italic line-clamp-2 border-b border-white/[0.04] pb-2">
                  “{activeInsight.sentiment}”
                </div>
              )}
              <div
                ref={aiChatListRef}
                className="flex-1 min-h-[180px] max-h-[280px] overflow-y-auto custom-scrollbar px-3 py-2 space-y-2"
              >
                {aiChatMessages.length === 0 && (
                  <div className="text-[11px] text-ink-400 leading-relaxed py-6 text-center">
                    질문을 입력해 채팅하세요.
                    <br />
                    <span className="text-ink-600">예: 지금 포지션 리스크 요약해줘</span>
                  </div>
                )}
                {aiChatMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`text-[11px] leading-relaxed rounded-xl px-2.5 py-2 max-w-[92%] whitespace-pre-wrap break-words ${
                      m.role === 'user'
                        ? 'ml-auto bg-accent/15 text-ink-200 border border-accent/20'
                        : 'mr-auto bg-ink-950/80 text-ink-300 border border-white/[0.06]'
                    }`}
                  >
                    {m.content}
                  </div>
                ))}
                {aiChatBusy && (
                  <div className="text-[10px] text-ink-500 px-1">응답 생성 중…</div>
                )}
              </div>
              <form
                className="p-2.5 border-t border-white/[0.06] flex gap-2"
                onSubmit={e => {
                  e.preventDefault();
                  void sendAiChatMessage();
                }}
              >
                <input
                  value={aiChatInput}
                  onChange={e => setAiChatInput(e.target.value)}
                  disabled={aiChatBusy}
                  placeholder="메시지 입력…"
                  className="flex-1 min-w-0 bg-ink-950 border border-white/[0.08] focus:border-accent/40 outline-none rounded-xl px-3 py-2 text-xs text-white disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={aiChatBusy || !aiChatInput.trim()}
                  className="px-3 py-2 rounded-xl bg-accent text-ink-950 text-xs font-semibold disabled:opacity-40 shrink-0"
                >
                  전송
                </button>
              </form>
            </>
          )}
        </div>

        {bulkOrderResults && createPortal(
          (() => {
            const okCount = bulkOrderResults.filter(r => r.status === 'success').length;
            const failCount = bulkOrderResults.filter(r => r.status === 'fail').length;
            const headline = failCount === 0 ? '주문 성공' : okCount === 0 ? '주문 실패' : '일부 주문 실패';
            const rowAmount = (res: { quantity: string; price?: string }) => {
              const qty = parseFloat(res.quantity);
              const px = parseFloat(res.price || '');
              if (!(qty > 0) || !(px > 0)) return null;
              return qty * px;
            };
            const successAmount = bulkOrderResults.reduce((sum, res) => {
              if (res.status !== 'success') return sum;
              return sum + (rowAmount(res) || 0);
            }, 0);
            return (
              <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-ink-950/80 backdrop-blur-sm">
                <div className="panel max-w-3xl w-full p-6 overflow-hidden flex flex-col max-h-[80vh] shadow-2xl">
                  <div className="flex items-start justify-between mb-4 gap-3">
                    <div>
                      <h2 className={`text-xl font-semibold ${failCount === 0 ? 'text-ok' : 'text-danger'}`}>{headline}</h2>
                      <p className="mt-1 text-sm font-mono text-ink-300">
                        <span className="text-ok">성공 {okCount}건</span>
                        <span className="text-ink-600"> · </span>
                        <span className="text-danger">실패 {failCount}건</span>
                        <span className="text-ink-600"> · </span>
                        <span>총 {bulkOrderResults.length}건</span>
                        <span className="text-ink-600"> · </span>
                        <span className="text-white">성공 금액 ${formatUsdCompact(successAmount)}</span>
                        {usdKrwRate != null && Number.isFinite(usdKrwRate) ? (
                          <span className="text-ink-400"> (₩{formatUsdCompact(successAmount * usdKrwRate)})</span>
                        ) : null}
                      </p>
                    </div>
                    <button onClick={() => setBulkOrderResults(null)} className="p-2 hover:bg-white/5 rounded-lg text-ink-400">
                      <X size={18} />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto custom-scrollbar border border-white/[0.06] rounded-xl">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-ink-950/80 sticky top-0">
                        <tr>
                          <th className="px-4 py-3 text-ink-400 font-medium">종목</th>
                          <th className="px-4 py-3 text-ink-400 font-medium">방향</th>
                          <th className="px-4 py-3 text-ink-400 font-medium">수량</th>
                          <th className="px-4 py-3 text-ink-400 font-medium">결과</th>
                          <th className="px-4 py-3 text-ink-400 font-medium">내용</th>
                          <th className="px-4 py-3 text-ink-400 font-medium text-right">금액</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.04]">
                        {bulkOrderResults.map((res, i) => (
                          <tr key={i}>
                            <td className="px-4 py-2.5 text-white font-semibold">{res.symbol}</td>
                            <td className="px-4 py-2.5">
                              <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${res.side === 'BUY' ? 'bg-ok/10 text-ok' : 'bg-danger/10 text-danger'}`}>{res.side === 'BUY' ? '롱' : '숏'}</span>
                            </td>
                            <td className="px-4 py-2.5 font-mono">{res.quantity}</td>
                            <td className="px-4 py-2.5">
                              {res.status === 'success' ? (
                                <span className="text-ok font-semibold text-[10px]">성공</span>
                              ) : (
                                <span className="text-danger font-semibold text-[10px]">실패</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-ink-400 truncate max-w-[200px]" title={res.error}>{res.error || '—'}</td>
                            <td className="px-4 py-2.5 font-mono text-right text-white">
                              {(() => {
                                const amt = rowAmount(res);
                                if (amt == null) return '—';
                                return (
                                  <>
                                    ${formatUsdCompact(amt)}
                                    {usdKrwRate != null && Number.isFinite(usdKrwRate) ? (
                                      <span className="block text-[10px] text-ink-400">₩{formatUsdCompact(amt * usdKrwRate)}</span>
                                    ) : null}
                                  </>
                                );
                              })()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <button onClick={() => setBulkOrderResults(null)} className="px-6 py-2 bg-accent text-ink-950 text-xs font-semibold rounded-lg">닫기</button>
                  </div>
                </div>
              </div>
            );
          })(),
          document.body
        )}
        <AnimatePresence>
          {showLimitBuyForm && selectedOpenOrder && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink-950/80 backdrop-blur-sm"
            >
              <motion.div
                initial={{ scale: 0.96, y: 12 }}
                animate={{ scale: 1, y: 0 }}
                exit={{ scale: 0.96, y: 12 }}
                className="w-full max-w-md panel overflow-hidden"
              >
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
                  <div>
                    <div className="metric-label text-ok">Limit buy</div>
                    <div className="text-xl font-semibold text-white mt-1">{selectedOpenOrder.symbol}</div>
                  </div>
                  <button onClick={() => setShowLimitBuyForm(false)} disabled={!!placingBuyOrderKey} className="p-2 rounded-lg text-ink-400 hover:text-white hover:bg-white/5">
                    <X size={18} />
                  </button>
                </div>
                <div className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="space-y-2">
                      <span className="metric-label">Price</span>
                      <input autoFocus type="number" inputMode="decimal" value={limitBuyPrice} onChange={e => setLimitBuyPrice(e.target.value)}
                        className="w-full bg-ink-950 border border-white/[0.08] focus:border-ok/50 outline-none rounded-xl px-4 py-3 text-white font-mono text-sm" />
                    </label>
                    <label className="space-y-2">
                      <span className="metric-label">Qty</span>
                      <input type="number" inputMode="decimal" value={limitBuyQty} onChange={e => setLimitBuyQty(e.target.value)}
                        className="w-full bg-ink-950 border border-white/[0.08] focus:border-ok/50 outline-none rounded-xl px-4 py-3 text-white font-mono text-sm" />
                    </label>
                  </div>
                  <div className="panel-soft p-4 font-mono text-xs flex justify-between">
                    <span className="text-ink-400">Notional</span>
                    <span className="text-white font-semibold">${((parseFloat(limitBuyPrice) || 0) * (parseFloat(limitBuyQty) || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </div>
                  <div className="flex gap-3">
                    <button onClick={() => setShowLimitBuyForm(false)} disabled={!!placingBuyOrderKey} className="flex-1 py-3 rounded-xl border border-white/[0.08] text-ink-300 text-xs font-semibold">닫기</button>
                    <button onClick={submitLimitBuyOrder} disabled={!!placingBuyOrderKey} className="flex-1 py-3 rounded-xl bg-ok text-ink-950 text-xs font-semibold disabled:opacity-40">
                      {placingBuyOrderKey ? '주문중…' : '지정가 매수'}
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
          {error && positions.length === 0 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-ink-950/80 backdrop-blur-sm"
              onClick={dismissError}
            >
              <div
                className="panel border-danger/30 max-w-lg w-full p-6"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex items-center gap-3 text-danger">
                    <ShieldAlert size={24} />
                    <h2 className="text-lg font-semibold">
                      {isRateLimitError(error) ? '요청 제한 (일시)' : 'API 연결 오류'}
                    </h2>
                  </div>
                  <button
                    onClick={dismissError}
                    className="p-1.5 rounded-lg text-ink-400 hover:text-white hover:bg-white/5"
                  >
                    <X size={16} />
                  </button>
                </div>
                <code className="block bg-ink-950 p-3 rounded-xl border border-danger/20 text-xs text-danger/90 break-all mb-4 leading-relaxed">{error}</code>
                {isRateLimitError(error) ? (
                  <p className="text-sm text-ink-300 mb-4 leading-relaxed">
                    짧은 시간 요청이 많아 Binance가 일시 차단했습니다. 표시된 시각까지 기다린 뒤 재시도하세요.
                    (Trusted IP 문제와는 별개입니다.)
                  </p>
                ) : (
                  <>
                    <p className="text-sm text-ink-300 mb-2">Futures 권한 · Trusted IP에 서버 IP 등록을 확인하세요.</p>
                    <div className="flex items-center gap-2 panel-soft p-3 mb-4">
                      <code className="text-accent font-mono text-base flex-1 select-all">{serverIp || '—'}</code>
                      <button
                        onClick={() => {
                          const ip = serverIp || '';
                          if (ip) {
                            navigator.clipboard.writeText(ip);
                            alert(`${ip} 복사됨`);
                          }
                        }}
                        className="px-3 py-2 rounded-lg bg-accent text-ink-950 text-xs font-semibold"
                      >
                        IP 복사
                      </button>
                    </div>
                  </>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={dismissError}
                    className="flex-1 py-3 rounded-xl border border-white/[0.08] text-sm font-semibold text-ink-300"
                  >
                    닫기
                  </button>
                  <button
                    onClick={() => { refreshAll(); }}
                    className="flex-1 py-3 rounded-xl bg-accent text-ink-950 text-sm font-semibold flex items-center justify-center gap-2"
                  >
                    <RefreshCw size={14} className={isAnalysing ? 'animate-spin' : ''} /> 재시도
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
