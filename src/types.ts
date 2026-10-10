export interface AssetStats {
  symbol: string;
  price: string;
  change24h: string;
  high24h: string;
  low24h: string;
  volume: string;
}

export interface MarketInsight {
  trend: 'bullish' | 'bearish' | 'neutral';
  sentiment: string;
  keyLevels: {
    support: string[];
    resistance: string[];
  };
  summary: string;
  timestamp: number;
}

export interface FundingRate {
  symbol: string;
  fundingRate: string;
  lastFundingTime: number;
}

export interface HistoricalSnapshot {
  timestamp: number;
  totalBalance: number;
  totalUPNL: number;
  exposure: number;
  fundingValue: number;
}

export interface FuturesPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
}

export interface FuturesOrder {
  symbol: string;
  orderId: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  time: number;
}

export interface FuturesTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  realizedPnl: string;
  side: string;
  time: number;
}

export interface FuturesIncome {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  info: string;
  tranId: string;
  tradeId: string;
}
