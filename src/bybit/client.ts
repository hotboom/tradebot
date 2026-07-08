import { RestClientV5 } from "bybit-api";
import type { OrderSide } from "../types";

export interface InstrumentInfo {
  qtyStep: number;
  minOrderQty: number;
  tickSize: number;
}

export interface MarketOrderParams {
  symbol: string;
  side: OrderSide;
  qty: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export class BybitClient {
  private readonly rest: RestClientV5;
  private readonly instrumentCache = new Map<string, InstrumentInfo>();

  constructor(testnet: boolean) {
    const key = process.env.BYBIT_API_KEY;
    const secret = process.env.BYBIT_API_SECRET;
    if (!key || !secret) {
      throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET must be set in environment");
    }
    // Защита от рассинхрона локальных часов с сервером Bybit (ошибки 10002/10003):
    // syncTimeBeforePrivateRequests синхронизирует время перед каждым приватным запросом
    this.rest = new RestClientV5({
      key,
      secret,
      testnet,
      enable_time_sync: true,
      syncTimeBeforePrivateRequests: true,
      recv_window: 10000,
    });
  }

  /** Шаг лота, минимальный объём и шаг цены инструмента (с кэшированием). */
  async getInstrumentInfo(symbol: string): Promise<InstrumentInfo> {
    const cached = this.instrumentCache.get(symbol);
    if (cached) return cached;

    const res = await this.rest.getInstrumentsInfo({ category: "linear", symbol });
    if (res.retCode !== 0) {
      throw new Error(`getInstrumentsInfo failed: ${res.retCode} ${res.retMsg}`);
    }
    const item = res.result.list?.[0];
    if (!item) {
      throw new Error(`Instrument not found on Bybit: ${symbol}`);
    }
    const info: InstrumentInfo = {
      qtyStep: Number(item.lotSizeFilter.qtyStep),
      minOrderQty: Number(item.lotSizeFilter.minOrderQty),
      tickSize: Number(item.priceFilter.tickSize),
    };
    this.instrumentCache.set(symbol, info);
    return info;
  }

  /** Последняя цена тикера. */
  async getLastPrice(symbol: string): Promise<number> {
    const res = await this.rest.getTickers({ category: "linear", symbol });
    if (res.retCode !== 0) {
      throw new Error(`getTickers failed: ${res.retCode} ${res.retMsg}`);
    }
    const price = Number(res.result.list?.[0]?.lastPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`No valid last price for ${symbol}`);
    }
    return price;
  }

  /** Отправка маркет-ордера. Возвращает orderId. */
  async submitMarketOrder(params: MarketOrderParams): Promise<string> {
    const order: Record<string, string> = {
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: "Market",
      qty: String(params.qty),
    };
    if (params.stopLoss !== null) order.stopLoss = String(params.stopLoss);
    if (params.takeProfit !== null) order.takeProfit = String(params.takeProfit);

    const res = await this.rest.submitOrder(order as never);
    if (res.retCode !== 0) {
      throw new Error(`submitOrder failed: ${res.retCode} ${res.retMsg}`);
    }
    return res.result.orderId;
  }
}
