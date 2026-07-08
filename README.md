# Executor-сервис (MVP)

Принимает сигналы о каскадах ликвидаций по HTTP и открывает рыночные позиции
на Bybit Futures (`category: linear`) при превышении порога объёма.

## Установка

```bash
npm install
cp .env.example .env      # прописать BYBIT_API_KEY / BYBIT_API_SECRET
cp config.example.json config.json   # порт, testnet, порог, размер позиции, SL/TP
```

Настройки — в `config.json` (не в git; шаблон — `config.example.json`).
Плечо сервис не выставляет — используется то, что уже задано на аккаунте Bybit для символа.

## Запуск

```bash
# режим разработки
npm run dev

# сборка + запуск
npm run build
npm start
```

На проде одного `npm install` недостаточно — нужна сборка (`dist/` не хранится в git) и
запуск через **PM2**, чтобы процесс жил в фоне и перезапускался при падении.

## Деплой на VPS (прод)

### Первый раз на сервере

```bash
# Node.js 20+
node -v

git clone <ваш-репо> tradebot
cd tradebot

npm install

# .env в git нет — создать вручную на сервере
cp .env.example .env
# прописать BYBIT_API_KEY / BYBIT_API_SECRET

# порт, testnet: false, пороги, размер позиции, SL/TP
cp config.example.json config.json
nano config.json

npm run build

npm install -g pm2
pm2 start ecosystem.config.js

# автозапуск после перезагрузки VPS
pm2 save
pm2 startup   # выполнить команду, которую выведет pm2
```

Сервис слушает `127.0.0.1:4001` — снаружи не виден. Сигналы шлёт другой процесс
на том же VPS (сканер ликвидаций и т.п.) через HTTP на localhost.

### После каждого `git pull`

```bash
cd tradebot
git pull
npm install          # если менялись зависимости
npm run build        # обязательно — dist/ не в репозитории
pm2 restart executor-service
```

`.env` и `config.json` pull не трогает (не в git). После pull достаточно `npm install` + `npm run build` + `pm2 restart`.
Если в репозитории появились новые поля конфига — сверить с `config.example.json` и дописать в локальный `config.json` вручную.


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
