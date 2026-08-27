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

export interface OrderbookTop {
  bestBid: number;
  bestAsk: number;
}

export interface LimitOrderParams {
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
}

export interface AmendOrderParams {
  symbol: string;
  orderId: string;
  price: number;
}

export interface OrderState {
  orderStatus: string;
  cumExecQty: number;
  avgPrice: number;
  rejectReason: string | null;
}

export interface OpenPositionSummary {
  symbol: string;
  side: OrderSide;
  avgPrice: number;
  size: number;
  markPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface FeeRate {
  takerFeeRate: number;
  makerFeeRate: number;
}

export interface OpenStopOrder {
  orderId: string;
  /** "PartialStopLoss" / "PartialTakeProfit" — часть SL/TP позиции (setTradingStop, tpslMode
   * "Partial"); "Stop" — независимый резервный market-ордер (submitStopMarketOrder). */
  stopOrderType: string;
  /** Триггерная цена ордера — для PartialStopLoss/PartialTakeProfit совпадает с ценой,
   * переданной в setTradingStop (slLimitPrice/tpLimitPrice ставятся туда же). */
  triggerPrice: number;
}

/** Bybit не всегда возвращает один и тот же retCode для "ордера больше не существует"
 * (уже исполнен/отменён/неверный orderId) — это ожидаемая гонка при чейзинге лимитника,
 * а не ошибка, поэтому распознаём и по коду, и по тексту сообщения на всякий случай. */
function isOrderGoneRetCode(retCode: number, retMsg: string): boolean {
  if (retCode === 110001) return true;
  return /order not exists|not exist|has been filled|has been (cancell?ed)|too late to cancel/i.test(retMsg);
}

export class BybitClient {
  private readonly rest: RestClientV5;
  private readonly instrumentCache = new Map<string, InstrumentInfo>();
  private readonly feeRateCache = new Map<string, FeeRate>();

  constructor(testnet: boolean) {
    const key = process.env.BYBIT_API_KEY;
    const secret = process.env.BYBIT_API_SECRET;
    if (!key || !secret) {
      throw new Error("BYBIT_API_KEY / BYBIT_API_SECRET must be set in environment");
    }
    // Время НЕ синхронизируем средствами bybit-api: системные часы VPS держит ntpd (offset ~1мс,
    // сверено с api.bybit.com — расхождение <100мс). Встроенный time-sync bybit-api добавляет
    // собственный self-computed offset к Date.now() и периодически промахивался на 1–2.5с из-за
    // джиттера на своём getServerTime-пробе, что давало интермиттентные 10002 ("req_timestamp >
    // server_time + 1000") на приватных запросах. recv_window 10000 оставляем как запас на
    // сетевую задержку. Если ntpd на сервере ляжет и часы поплывут — приватные запросы начнут
    // падать, это надо мониторить отдельно.
    this.rest = new RestClientV5({
      key,
      secret,
      testnet,
      enable_time_sync: false,
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

  /** Средняя цена входа и полный текущий объём открытой позиции (после исполнения входа) —
   * нужны, чтобы считать/сайзить SL/TP на весь объём позиции, а не только на последний вход
   * (при повторных входах по символу Bybit сам блендит avgPrice по всем филам). Возвращает
   * null, если позиции нет / данные невалидны — вызывающий код в этом случае откатывается на
   * цену/объём собственно этого входа. */
  async getOpenPosition(symbol: string): Promise<{ avgPrice: number; size: number } | null> {
    const res = await this.rest.getPositionInfo({ category: "linear", symbol });
    if (res.retCode !== 0) {
      throw new Error(`getPositionInfo failed: ${res.retCode} ${res.retMsg}`);
    }
    const avgPrice = Number(res.result.list?.[0]?.avgPrice);
    const size = Number(res.result.list?.[0]?.size);
    if (!Number.isFinite(avgPrice) || avgPrice <= 0 || !Number.isFinite(size) || size <= 0) {
      return null;
    }
    return { avgPrice, size };
  }

  /** Сводка по всем открытым позициям аккаунта (category linear, settleCoin USDT) — для
   * периодического монитора переноса стопа в безубыток, которому нужны сразу все позиции,
   * а не одна по символу. Позиции с нулевым размером (settleCoin-запрос возвращает по одной
   * записи на каждый когда-либо торговавшийся символ) отфильтровываются. */
  async getOpenPositions(): Promise<OpenPositionSummary[]> {
    const res = await this.rest.getPositionInfo({ category: "linear", settleCoin: "USDT" });
    if (res.retCode !== 0) {
      throw new Error(`getPositionInfo (list) failed: ${res.retCode} ${res.retMsg}`);
    }
    return (res.result.list ?? [])
      .filter((p) => Number(p.size) > 0)
      .map((p) => ({
        symbol: p.symbol,
        side: p.side === "Sell" ? "Sell" : "Buy",
        avgPrice: Number(p.avgPrice),
        size: Number(p.size),
        markPrice: Number(p.markPrice),
        stopLoss: p.stopLoss && Number(p.stopLoss) > 0 ? Number(p.stopLoss) : null,
        takeProfit: p.takeProfit && Number(p.takeProfit) > 0 ? Number(p.takeProfit) : null,
      }));
  }

  /** Taker/maker комиссия аккаунта по символу (с кэшированием — тариф не меняется в рамках
   * жизни процесса). Нужна монитору безубытка, чтобы перенести стоп на цену, где закрытие
   * позиции (даже по тейкеру) не уходит в минус с учётом уже уплаченной комиссии на входе. */
  async getFeeRate(symbol: string): Promise<FeeRate> {
    const cached = this.feeRateCache.get(symbol);
    if (cached) return cached;

    const res = await this.rest.getFeeRate({ category: "linear", symbol });
    if (res.retCode !== 0) {
      throw new Error(`getFeeRate failed: ${res.retCode} ${res.retMsg}`);
    }
    const item = res.result.list?.[0];
    if (!item) {
      throw new Error(`No fee rate returned for ${symbol}`);
    }
    const info: FeeRate = {
      takerFeeRate: Number(item.takerFeeRate),
      makerFeeRate: Number(item.makerFeeRate),
    };
    this.feeRateCache.set(symbol, info);
    return info;
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

  /** Лучшие bid/ask текущего стакана (глубина 1 — минимальная, достаточно для чейза лимитника). */
  async getOrderbook(symbol: string): Promise<OrderbookTop> {
    const res = await this.rest.getOrderbook({ category: "linear", symbol, limit: 1 });
    if (res.retCode !== 0) {
      throw new Error(`getOrderbook failed: ${res.retCode} ${res.retMsg}`);
    }
    const bestBid = Number(res.result.b?.[0]?.[0]);
    const bestAsk = Number(res.result.a?.[0]?.[0]);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      throw new Error(`No valid orderbook top for ${symbol}`);
    }
    return { bestBid, bestAsk };
  }

  /** Пассивный лимитный ордер (PostOnly — гарантирует maker-комиссию). Важно: retCode 0 здесь
   * означает только то, что запрос принят биржей, а не то, что ордер встал в стакан — если цена
   * уже пересеклась, PostOnly асинхронно отклоняется движком матчинга, и это видно только по
   * последующему опросу статуса (getOrderState), а не по ответу на этот вызов. */
  async submitLimitOrder(params: LimitOrderParams): Promise<string> {
    const res = await this.rest.submitOrder({
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: "Limit",
      qty: String(params.qty),
      price: String(params.price),
      timeInForce: "PostOnly",
    });
    if (res.retCode !== 0) {
      throw new Error(`submitOrder (limit) failed: ${res.retCode} ${res.retMsg}`);
    }
    return res.result.orderId;
  }

  /** Репрайс резидентного лимитного ордера при чейзинге. Возвращает "gone" вместо throw, если
   * ордер уже исполнился/пропал между опросом статуса и этим вызовом — ожидаемая гонка, не ошибка. */
  async amendOrder(params: AmendOrderParams): Promise<"amended" | "gone"> {
    const res = await this.rest.amendOrder({
      category: "linear",
      symbol: params.symbol,
      orderId: params.orderId,
      price: String(params.price),
    });
    if (res.retCode === 0) return "amended";
    if (isOrderGoneRetCode(res.retCode, res.retMsg)) return "gone";
    throw new Error(`amendOrder failed: ${res.retCode} ${res.retMsg}`);
  }

  /** Отмена ордера. Возвращает тихо (без throw), если ордер уже исполнился/пропал между
   * запросом списка и отменой — ожидаемая гонка, не ошибка (см. isOrderGoneRetCode). */
  async cancelOrder(params: { symbol: string; orderId: string }): Promise<void> {
    const res = await this.rest.cancelOrder({
      category: "linear",
      symbol: params.symbol,
      orderId: params.orderId,
    });
    if (res.retCode === 0) return;
    if (isOrderGoneRetCode(res.retCode, res.retMsg)) return;
    throw new Error(`cancelOrder failed: ${res.retCode} ${res.retMsg}`);
  }

  /** Все наши условные ордера риск-менеджмента позиции, резидентные на бирже для символа:
   * и независимый backup-SL (submitStopMarketOrder, stopOrderType "Stop"), и Partial SL/TP
   * самой позиции (созданные через setTradingStop, stopOrderType "PartialStopLoss"/
   * "PartialTakeProfit"). Важно (проверено на боевом аккаунте, живая позиция BTCUSDT):
   * повторный вызов setTradingStop в tpslMode: "Partial" НЕ заменяет предыдущие partial-ордера,
   * а создаёт новую пару поверх — без явной отмены старых на бирже копятся дублирующиеся SL/TP
   * с устаревшими qty/ценой. Поэтому перед каждым пересозданием чистим здесь всё разом.
   *
   * Возвращает не только orderId, но и stopOrderType/triggerPrice каждого ордера: в tpslMode
   * "Partial" SL/TP самой позиции НЕ отражаются в полях stopLoss/takeProfit объекта позиции
   * (getPositionInfo) — это независимые резидентные ордера, поэтому единственный надёжный
   * способ узнать, что уже стоит на бирже (и не переставлять его без необходимости) —
   * посмотреть на сами эти ордера. */
  async getOpenStopOrders(symbol: string): Promise<OpenStopOrder[]> {
    const res = await this.rest.getActiveOrders({ category: "linear", symbol, orderFilter: "StopOrder" });
    if (res.retCode !== 0) {
      throw new Error(`getActiveOrders (StopOrder) failed: ${res.retCode} ${res.retMsg}`);
    }
    return (res.result.list ?? []).map((order) => ({
      orderId: order.orderId,
      stopOrderType: order.stopOrderType,
      triggerPrice: Number(order.triggerPrice),
    }));
  }

  /** Текущее состояние ордера. getActiveOrders покрывает резидентные/частично исполненные ордера;
   * если ордер уже пропал из активных (обычно вскоре после полного исполнения или отмены) —
   * финальное состояние (cumExecQty/avgPrice/orderStatus) читаем из истории ордеров. */
  async getOrderState(symbol: string, orderId: string): Promise<OrderState | null> {
    const active = await this.rest.getActiveOrders({ category: "linear", symbol, orderId });
    if (active.retCode !== 0) {
      throw new Error(`getActiveOrders failed: ${active.retCode} ${active.retMsg}`);
    }
    let order = active.result.list?.[0];

    if (!order) {
      const hist = await this.rest.getHistoricOrders({ category: "linear", symbol, orderId });
      if (hist.retCode !== 0) {
        throw new Error(`getHistoricOrders failed: ${hist.retCode} ${hist.retMsg}`);
      }
      order = hist.result.list?.[0];
    }
    if (!order) return null;

    return {
      orderStatus: order.orderStatus,
      cumExecQty: Number(order.cumExecQty),
      avgPrice: Number(order.avgPrice) || 0,
      rejectReason: order.rejectReason && order.rejectReason !== "EC_NoError" ? order.rejectReason : null,
    };
  }
}
