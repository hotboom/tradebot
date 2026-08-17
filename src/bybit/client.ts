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
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface TradingStopParams {
  symbol: string;
  qty: number;
  stopLoss?: number | null;
  stopLossOrderType?: "Market" | "Limit";
  takeProfit?: number | null;
}

export interface StopMarketOrderParams {
  symbol: string;
  /** Сторона закрывающего ордера (противоположна стороне позиции). */
  side: OrderSide;
  qty: number;
  triggerPrice: number;
  /** 1 = триггер при росте цены до triggerPrice, 2 = триггер при падении цены до triggerPrice. */
  triggerDirection: 1 | 2;
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

  /** Фактическая средняя цена входа по открытой позиции (после исполнения маркет-ордера). */
  async getPositionAvgPrice(symbol: string): Promise<number> {
    const res = await this.rest.getPositionInfo({ category: "linear", symbol });
    if (res.retCode !== 0) {
      throw new Error(`getPositionInfo failed: ${res.retCode} ${res.retMsg}`);
    }
    const price = Number(res.result.list?.[0]?.avgPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`No valid avgPrice for ${symbol}`);
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
    if (params.stopLoss != null) order.stopLoss = String(params.stopLoss);
    if (params.takeProfit != null) order.takeProfit = String(params.takeProfit);

    const res = await this.rest.submitOrder(order as never);
    if (res.retCode !== 0) {
      throw new Error(`submitOrder failed: ${res.retCode} ${res.retMsg}`);
    }
    return res.result.orderId;
  }

  /** Выставление SL/TP на уже открытую позицию (отдельным запросом после входа).
   * SL по умолчанию — Market (гарантированное исполнение при резком движении), может быть
   * переключён на Limit (меньше комиссия, ценой риска не исполниться на резком движении).
   * TP — Limit (меньше комиссия и без проскальзывания, ценой риска не исполниться на "фитиле"). */
  async setTradingStop(params: TradingStopParams): Promise<void> {
    const body: Record<string, string | number> = {
      category: "linear",
      symbol: params.symbol,
      // one-way mode: единственная позиция по символу
      positionIdx: 0,
      tpslMode: "Partial",
    };
    if (params.stopLoss != null) {
      body.stopLoss = String(params.stopLoss);
      body.slSize = String(params.qty);
      const slOrderType = params.stopLossOrderType ?? "Market";
      body.slOrderType = slOrderType;
      if (slOrderType === "Limit") {
        body.slLimitPrice = String(params.stopLoss);
      }
    }
    if (params.takeProfit != null) {
      body.takeProfit = String(params.takeProfit);
      body.tpSize = String(params.qty);
      body.tpOrderType = "Limit";
      body.tpLimitPrice = String(params.takeProfit);
    }

    const res = await this.rest.setTradingStop(body as never);
    if (res.retCode !== 0) {
      throw new Error(`setTradingStop failed: ${res.retCode} ${res.retMsg}`);
    }
  }

  /** Независимый reduce-only условный маркет-ордер (страховочный SL "на всякий случай",
   * не привязан к TP/SL-слоту позиции — работает как отдельный ордер на бирже). */
  async submitStopMarketOrder(params: StopMarketOrderParams): Promise<string> {
    const order: Record<string, string | number | boolean> = {
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: "Market",
      qty: String(params.qty),
      triggerPrice: String(params.triggerPrice),
      triggerDirection: params.triggerDirection,
      triggerBy: "LastPrice",
      reduceOnly: true,
      timeInForce: "IOC",
      positionIdx: 0,
    };

    const res = await this.rest.submitOrder(order as never);
    if (res.retCode !== 0) {
      throw new Error(`submitOrder (stop-market backup) failed: ${res.retCode} ${res.retMsg}`);
    }
    return res.result.orderId;
  }
}
