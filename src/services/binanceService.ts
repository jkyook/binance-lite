import { AssetStats, FuturesPosition, FuturesOrder, FuturesTrade, FuturesIncome, FuturesTrades24h } from '../types';

export class BinanceService {
  /**
   * Subscribe to real-time ticker for a symbol.
   * Tries the Futures stream first; falls back to Spot if it fails to connect.
   * Auto-reconnects on disconnect.
   *
   * @returns cleanup function – call it to permanently close and stop reconnects.
   */
  static getLiveTicker(
    symbol: string,
    onUpdate: (data: AssetStats) => void,
    onConnected?: (connected: boolean) => void
  ): () => void {
    const FUTURES_URL = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@ticker`;
    const SPOT_URL    = `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@ticker`;

    let ws: WebSocket | null = null;
    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentUrl = FUTURES_URL;
    let futuresFailed = false;

    const connect = () => {
      if (destroyed) return;

      ws = new WebSocket(currentUrl);
      let didOpen = false;

      ws.onopen = () => {
        didOpen = true;
        onConnected?.(true);
        console.log(`[WS] Connected: ${symbol} via ${currentUrl}`);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data.c) return;
          onUpdate({
            symbol: data.s,
            price: parseFloat(data.c).toString(),
            change24h: data.P || '0',
            high24h:   data.h || '0',
            low24h:    data.l || '0',
            volume:    data.v || '0',
          });
        } catch (e) {
          console.error('[WS] Parse error:', e);
        }
      };

      ws.onerror = () => {
        console.warn(`[WS] Error: ${symbol} @ ${currentUrl}`);
      };

      ws.onclose = () => {
        if (destroyed) return;
        onConnected?.(false);

        if (!didOpen && currentUrl === FUTURES_URL && !futuresFailed) {
          // Futures stream unreachable – switch to spot stream
          futuresFailed = true;
          currentUrl = SPOT_URL;
          console.log(`[WS] Futures unavailable for ${symbol}, switching to spot stream`);
          reconnectTimer = setTimeout(connect, 500);
        } else {
          // Reconnect to current URL after a brief delay
          console.log(`[WS] Reconnecting ${symbol} in 3 s...`);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    // Return cleanup: stops reconnects and closes the socket
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null; // suppress the reconnect handler on manual close
        ws.close();
      }
      onConnected?.(false);
    };
  }

  static async getKlines(symbol: string, interval: string = '1h', limit: number = 24) {
    try {
      const response = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
      );
      if (!response.ok) {
        const spotResponse = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
        );
        if (!spotResponse.ok) return [];
        return spotResponse.json();
      }
      return response.json();
    } catch (e) {
      console.warn(`Could not reach Binance API for ${symbol}:`, e);
      return [];
    }
  }

  static async getPrice(symbol: string): Promise<string> {
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol.toUpperCase()}`);
      if (!response.ok) {
        const spotResponse = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`);
        if (!spotResponse.ok) return '0';
        const data = await spotResponse.json();
        return data.price;
      }
      const data = await response.json();
      return data.price;
    } catch (e) {
      return '0';
    }
  }

  static async get24hTicker(symbol: string): Promise<AssetStats | null> {
    try {
      const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol.toUpperCase()}`);
      if (!response.ok) {
        const spotResponse = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`);
        if (!spotResponse.ok) return null;
        const data = await spotResponse.json();
        return {
          symbol: data.symbol,
          price: data.lastPrice,
          change24h: data.priceChangePercent,
          high24h: data.highPrice,
          low24h: data.lowPrice,
          volume: data.volume
        };
      }
      const data = await response.json();
      return {
        symbol: data.symbol,
        price: data.lastPrice,
        change24h: data.priceChangePercent,
        high24h: data.highPrice,
        low24h: data.lowPrice,
        volume: data.volume
      };
    } catch (e) {
      return null;
    }
  }

  static orderHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  static forgetOrderPin() {
    try {
      sessionStorage.removeItem('binance-lite-order-pin');
    } catch {
      /* ignore */
    }
  }

  static async authorizedOrder(url: string, body: unknown): Promise<Response> {
    const response = await fetch(url, {
      method: 'POST',
      headers: BinanceService.orderHeaders(),
      body: JSON.stringify(body),
    });
    if (response.status === 401) BinanceService.forgetOrderPin();
    return response;
  }

  // Futures Private Data via our server proxy
  static async getFuturesPositions(): Promise<FuturesPosition[]> {
    const response = await fetch('/api/futures/positions');
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch positions';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    const data = await response.json();
    return data.filter((p: any) => parseFloat(p.positionAmt) !== 0);
  }

  static async getFuturesOpenOrders(): Promise<FuturesOrder[]> {
    const response = await fetch('/api/futures/open-orders');
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch open orders';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getTradingStatus(): Promise<{
    restricted: boolean;
    restrictedUntil: number;
    binance: any;
    binanceLocked?: boolean;
    binanceError?: string;
  }> {
    const response = await fetch('/api/futures/trading-status');
    if (!response.ok) throw new Error('Failed to fetch trading status');
    return response.json();
  }

  static async cancelFuturesOrder(symbol: string, orderId: number): Promise<any> {
    const response = await fetch('/api/futures/cancel-order', {
      method: 'POST',
      headers: BinanceService.orderHeaders(),
      body: JSON.stringify({ symbol, orderId }),
    });
    if (response.status === 401) BinanceService.forgetOrderPin();
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to cancel order';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getFuturesTrades(symbol?: string, params?: {
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<FuturesTrade[]> {
    const query = new URLSearchParams();
    if (symbol) query.append('symbol', symbol);
    if (params?.startTime) query.append('startTime', params.startTime.toString());
    if (params?.endTime) query.append('endTime', params.endTime.toString());
    if (params?.limit) query.append('limit', params.limit.toString());
    const queryString = query.toString();
    const url = queryString ? `/api/futures/trades?${queryString}` : '/api/futures/trades';
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch trades';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getFuturesTrades24h(refresh = false): Promise<FuturesTrades24h> {
    const response = await fetch(`/api/futures/trades-24h${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch 24h trades';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getFuturesAccount() {
    const response = await fetch('/api/futures/account');
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch account info';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getWalletsOverview(refresh = false): Promise<{
    quoteAsset: string;
    totalUsdt: number;
    wallets: Array<{ name: string; balanceUsdt: number; activate: boolean }>;
    updatedAt: number;
  }> {
    const response = await fetch(`/api/wallets/overview${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch wallets overview';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getWalletsDetails(refresh = false): Promise<{
    quoteAsset: string;
    totalUsdt: number;
    sections: Array<{
      name: string;
      usdt: number;
      assets: Array<{ asset: string; qty: number; usdt: number }>;
    }>;
    errors?: string[];
    updatedAt: number;
  }> {
    const response = await fetch(`/api/wallets/details${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch wallets details';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getJupiterPortfolio(refresh = false): Promise<{
    address: string;
    quote: string;
    totalUsd: number;
    groups: Array<{
      id: string;
      name: string;
      usd: number;
      rows: Array<{ symbol: string; qty: number; usd: number; side: string }>;
    }>;
    updatedAt: number;
    staleError?: string;
  }> {
    const response = await fetch(`/api/jupiter/portfolio${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch Jupiter portfolio';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async getFuturesIncome(params?: {
    symbol?: string;
    incomeType?: string;
    startTime?: number;
    endTime?: number;
    page?: number;
    limit?: number;
  }): Promise<FuturesIncome[]> {
    const query = new URLSearchParams();
    if (params) {
      if (params.symbol) query.append('symbol', params.symbol);
      if (params.incomeType) query.append('incomeType', params.incomeType);
      if (params.startTime) query.append('startTime', params.startTime.toString());
      if (params.endTime) query.append('endTime', params.endTime.toString());
      if (params.page) query.append('page', params.page.toString());
      if (params.limit) query.append('limit', params.limit.toString());
    }
    const response = await fetch(`/api/futures/income?${query.toString()}`);
    if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = 'Failed to fetch income data';
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson.error || errorJson.msg || errorMsg;
        } catch (e) {
          errorMsg = errorText || errorMsg;
        }
        throw new Error(errorMsg);
    }
    return response.json();
  }

  // Binance /fapi/v1/income: limit max 1000, page로 추가 조회.
  // FUNDING_FEE가 포지션 수만큼 쌓여 untyped 조회는 페이지당 ~1일분만 채워지므로
  // incomeType별로 나누고, 긴 기간은 7일 윈도우로 청크한다.
  static readonly INCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  static readonly INCOME_TYPES_DEFAULT = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'] as const;

  private static incomeDedupKey(item: FuturesIncome): string {
    return `${String(item.tranId)}_${item.incomeType}_${item.time}_${item.income}_${item.symbol || ''}`;
  }

  static async fetchIncomeRange(
    startMs: number,
    endMs: number,
    onProgress?: (info: { iter: number; collected: number; cursor: number }) => void,
    options?: {
      pageLimit?: number;
      maxPages?: number;
      delayMs?: number;
      incomeType?: string;
    }
  ): Promise<FuturesIncome[]> {
    const pageLimit = options?.pageLimit ?? 1000;
    const maxPages = options?.maxPages ?? 30;
    const delayMs = options?.delayMs ?? 200;
    const incomeType = options?.incomeType;

    if (!(endMs > startMs)) return [];

    const results: FuturesIncome[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      onProgress?.({ iter: page - 1, collected: results.length, cursor: startMs });

      const batch = await this.getFuturesIncome({
        startTime: startMs,
        endTime: endMs,
        page,
        limit: pageLimit,
        ...(incomeType ? { incomeType } : {}),
      });

      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const item of batch) {
        if (typeof item.time === 'number' && (item.time < startMs || item.time > endMs)) continue;
        const key = this.incomeDedupKey(item);
        if (!seen.has(key)) {
          seen.add(key);
          results.push(item);
        }
      }

      if (batch.length < pageLimit) break;
      if (page < maxPages) await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    onProgress?.({ iter: -1, collected: results.length, cursor: startMs });
    return results;
  }

  // React StrictMode 이중 mount 등으로 동일 조회가 겹칠 때 네트워크를 공유한다.
  private static incomeHistoryInflight = new Map<string, Promise<FuturesIncome[]>>();

  /** 기간 전체 income — 타입별 + 7일 청크로 rate-limit·1000건 캡을 피한다. */
  static async fetchIncomeHistory(
    startMs: number,
    endMs: number,
    onProgress?: (info: { iter: number; collected: number; cursor: number }) => void,
    options?: {
      incomeTypes?: readonly string[];
      pageLimit?: number;
      maxPagesPerWindow?: number;
      delayMs?: number;
      /** StrictMode 중복 방지용. 없으면 start/end/types로 키 생성 */
      dedupeKey?: string;
    }
  ): Promise<FuturesIncome[]> {
    if (!(endMs > startMs)) return [];

    const incomeTypes = options?.incomeTypes ?? this.INCOME_TYPES_DEFAULT;
    // 초 단위로 묶어 동일 시점 중복 요청을 합친다.
    const bucketStart = Math.floor(startMs / 1000);
    const bucketEnd = Math.floor(endMs / 1000);
    const dedupeKey =
      options?.dedupeKey ??
      `${bucketStart}:${bucketEnd}:${incomeTypes.join(',')}`;

    const existing = this.incomeHistoryInflight.get(dedupeKey);
    if (existing) {
      const shared = await existing;
      onProgress?.({ iter: -1, collected: shared.length, cursor: startMs });
      return shared;
    }

    const delayMs = options?.delayMs ?? 200;
    const windowMs = this.INCOME_WINDOW_MS;

    const run = (async () => {
      const results: FuturesIncome[] = [];
      const seen = new Set<string>();
      let step = 0;

      // 최신 구간부터 역순으로 가져와 UI에 빨리 의미 있는 데이터가 쌓이게 한다.
      for (let windowEnd = endMs; windowEnd > startMs; windowEnd -= windowMs) {
        const windowStart = Math.max(startMs, windowEnd - windowMs);

        for (const incomeType of incomeTypes) {
          const batch = await this.fetchIncomeRange(
            windowStart,
            windowEnd,
            (p) => {
              onProgress?.({
                iter: step + Math.max(0, p.iter),
                collected: results.length + p.collected,
                cursor: windowStart,
              });
            },
            {
              incomeType,
              pageLimit: options?.pageLimit,
              maxPages: options?.maxPagesPerWindow ?? (incomeType === 'FUNDING_FEE' ? 30 : 5),
              delayMs,
            }
          );

          for (const item of batch) {
            const key = this.incomeDedupKey(item);
            if (!seen.has(key)) {
              seen.add(key);
              results.push(item);
            }
          }

          step += 1;
          onProgress?.({ iter: step, collected: results.length, cursor: windowStart });
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      onProgress?.({ iter: -1, collected: results.length, cursor: startMs });
      return results;
    })();

    this.incomeHistoryInflight.set(dedupeKey, run);
    try {
      return await run;
    } finally {
      this.incomeHistoryInflight.delete(dedupeKey);
    }
  }

  static async getFuturesFunding(symbol?: string): Promise<any> {
    const url = symbol ? `/api/futures/funding?symbol=${symbol}` : '/api/futures/funding';
    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to fetch funding data';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }
    return response.json();
  }

  static async sendTelegramMessage(text: string): Promise<{ ok: boolean; messageId?: number }> {
    const response = await fetch('/api/telegram/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = 'Failed to send Telegram message';
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error || errorJson.description || errorJson.msg || errorMsg;
      } catch (e) {
        errorMsg = errorText || errorMsg;
      }
      throw new Error(errorMsg);
    }

    return response.json();
  }
}
