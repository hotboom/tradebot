# Executor-сервис (MVP)

Принимает сигналы о каскадах ликвидаций по HTTP и открывает рыночные позиции
на Bybit Futures (`category: linear`) при превышении порога объёма.

## Установка

```bash
npm install
cp .env.example .env   # прописать BYBIT_API_KEY / BYBIT_API_SECRET
```

Настройки — в `config.json` (порт, testnet, порог, размер позиции, SL/TP, пути логов).
Плечо сервис не выставляет — используется то, что уже задано на аккаунте Bybit для символа.

## Запуск

```bash
# режим разработки
npm run dev

# сборка + запуск
npm run build
npm start

# через PM2 (на VPS)
npm run build
pm2 start ecosystem.config.js
```

## API

`POST http://127.0.0.1:4001/signal/liquidation`

```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "totalVolumeUsdt": 4200000,
  "orderCount": 12,
  "lastBankruptcyPrice": 63500,
  "windowMs": 5000,
  "timestamp": 1720000000000
}
```

- Некорректная схема — `400`, запись в `signals.log` (`rejected` / `invalid_schema`).
- Объём ниже `trading.minLiquidationUsdt` — `200`, запись `rejected` / `below_threshold`, ордер не создаётся.
- Валидный сигнал выше порога — `200`, ордер Market Buy (сигнал `LONG`) или Market Sell (`SHORT`)
  с SL/TP из конфига; результат — в `orders.log`.
- Повторный сигнал (тот же `symbol` + `timestamp`) не создаёт дубликат ордера.

## Логи

JSON Lines, append-only:

- `logs/signals.log` — каждый входящий сигнал с решением (`accepted` / `rejected` + причина);
- `logs/orders.log` — каждая попытка отправки ордера (`filled` / `failed` + ошибка);
- `logs/processed_signals.log` — ключи обработанных сигналов (идемпотентность).

## Тестирование

Перед боевым режимом проверять на `"testnet": true` (ключи API — от testnet.bybit.com).
