// Диагностика: в какой среде Bybit валиден API-ключ из .env
require("dotenv").config();
const { RestClientV5 } = require("bybit-api");

const key = process.env.BYBIT_API_KEY;
const secret = process.env.BYBIT_API_SECRET;

const base = { key, secret, enable_time_sync: true };
const envs = [
  { name: "mainnet (api.bybit.com)", opts: { ...base } },
  { name: "mainnet-alt (api.bytick.com)", opts: { ...base, apiRegion: "bytick" } },
  { name: "demo (api-demo.bybit.com)", opts: { ...base, demoTrading: true } },
  { name: "testnet (api-testnet.bybit.com)", opts: { ...base, testnet: true } },
];

(async () => {
  console.log(`API key: ${key.slice(0, 4)}...${key.slice(-4)} (length ${key.length})`);
  for (const env of envs) {
    try {
      const client = new RestClientV5(env.opts);
      const res = await client.getQueryApiKey();
      if (res.retCode === 0) {
        const r = res.result;
        console.log(`[OK]   ${env.name}: key VALID. readOnly=${r.readOnly}, permissions=${JSON.stringify(r.permissions?.ContractTrade ?? r.permissions)}, expiredAt=${r.expiredAt ?? "-"}, ips=${JSON.stringify(r.ips)}`);
      } else {
        console.log(`[FAIL] ${env.name}: retCode=${res.retCode} ${res.retMsg}`);
      }
    } catch (e) {
      console.log(`[ERR]  ${env.name}: ${e.message ?? e}`);
    }
  }
})();
