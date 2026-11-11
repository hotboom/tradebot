import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OffsetLimitEntries, offsetPrice } from "../src/bybit/offsetLimitEntry";
import { SymbolQueue } from "../src/util/symbolQueue";
import { OrderExecutor } from "../src/executor";
import { loadConfig } from "../src/config";
import { chaseLimitEntry } from "../src/bybit/limitChaseEntry";

const signal = { symbol: "TESTUSDT", direction: "LONG" as const, totalVolumeUsdt: 100, orderCount: 1,
  lastBankruptcyPrice: 90, windowMs: 20000, timestamp: 1000 };
const flush = () => new Promise<void>(r => setImmediate(r));
async function tick(t: any, ms = 1000) { t.mock.timers.tick(ms); await flush(); }
function setup(t: any, overrides: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "offset-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config: any = { trading: { positionSizeUsdt: 500, entryOffsetPercent: .5, stopLossPercent: 15 },
    logging: { ordersLogPath: path.join(dir, "orders.log") } };
  const logs: any[] = [], fills: any[] = [], submits: any[] = [];
  let state: any = { orderId: "order1", orderStatus: "New", cumExecQty: 0, avgPrice: 0, rejectReason: null };
  let lastCalls = 0;
  const client: any = { getInstrumentInfo: async () => ({ qtyStep: .01, minOrderQty: .01, tickSize: .01 }),
    getLastPrice: async () => { lastCalls++; return 100; }, getOpenPositions: async () => [], getOpenPosition: async () => null,
    submitLimitOrder: async (p: any) => { submits.push(p); return "order1"; },
    getOrderState: async () => state, ...overrides };
  const queue = new SymbolQueue();
  const manager = new OffsetLimitEntries(config, client, queue, { log: (v: any) => logs.push(v) } as any,
    async f => { fills.push(f); });
  return { dir, config, client, queue, manager, logs, fills, submits, setState: (s: any) => {state=s;}, lastCalls: () => lastCalls };
}

test("offset rounds away from market, including tiny ticks", () => {
  assert.equal(offsetPrice(100, "Buy", .5, .01), 99.5);
  assert.equal(offsetPrice(100, "Sell", .5, .03), 100.5);
  assert.ok(offsetPrice(100.01, "Sell", .5, .03) >= 100.01 * 1.005);
  assert.ok(offsetPrice(.00000123, "Buy", .5, 1e-8) > 0);
  assert.throws(() => offsetPrice(100, "Buy", 100, .01));
});

test("fixed price waits beyond five minutes; partial fill protects on exchange and frees symbol queue", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s=setup(t); const done=s.manager.execute(signal); await flush();
  assert.equal(s.submits.length,1); assert.equal(s.submits[0].price,99.5);
  assert.ok(s.submits[0].stopLoss > 0); assert.ok(s.manager.hasPending(signal.symbol));
  assert.ok(fs.existsSync(path.join(s.dir,"offset-entries.json")));
  assert.equal(await s.queue.run(signal.symbol, async()=>"unblocked"),"unblocked");
  s.setState({orderStatus:"PartiallyFilled",cumExecQty:1,avgPrice:99.5});
  await tick(t,301000); assert.equal(s.fills.length,0); assert.equal(s.submits.length,1);
  s.setState({orderStatus:"Filled",cumExecQty:5.02,avgPrice:99.49});
  await tick(t); await done;
  assert.equal(s.fills.length,1); assert.equal(s.fills[0].avgPrice,99.49);
  assert.equal(s.lastCalls(),1); assert.equal(s.manager.hasPending(signal.symbol),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir,"offset-entries.json"),"utf8")),[]);
});

test("manual cancellation never resubmits and partial cancellation finalizes only executed qty", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=setup(t);const done=s.manager.execute(signal);await flush();
  s.setState({orderStatus:"Cancelled",cumExecQty:1.2,avgPrice:99.5});
  await tick(t); await done;
  assert.equal(s.submits.length,1);assert.equal(s.fills[0].qty,1.2);
});

test("unfilled cancellation records cancellation and no fill", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=setup(t);const done=s.manager.execute(signal);await flush();
  s.setState({orderStatus:"Cancelled",cumExecQty:0,avgPrice:0});await tick(t);await done;
  assert.equal(s.fills.length,0);assert.equal(s.logs.at(-1).status,"cancelled");
});

test("ambiguous submission and restart use link ID without resubmission", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=setup(t,{submitLimitOrder:async()=>{throw new Error("response lost");}});
  const done=s.manager.execute(signal); await flush();
  const saved=JSON.parse(fs.readFileSync(path.join(s.dir,"offset-entries.json"),"utf8"));
  assert.equal(saved.length,1);assert.equal(saved[0].orderId,null);
  let lookup:any;let released=false;let recoveredFill:any;
  const recovered=new OffsetLimitEntries(s.config, {...s.client,
    submitLimitOrder:async()=>{assert.fail("must not resubmit");},
    getOrderState:async (...args:any[])=>{lookup=args;return {orderId:"recovered",orderStatus:"Filled",cumExecQty:2,avgPrice:99.5};}
  },s.queue,{log:()=>{}} as any, async f=>{recoveredFill=f;});
  assert.ok(recovered.hasPending(signal.symbol));recovered.resume(()=>{released=true;});
  s.setState({orderStatus:"Cancelled",cumExecQty:0,avgPrice:0});
  await tick(t);await done;await flush();
  assert.equal(lookup[1],undefined);assert.equal(lookup[2],saved[0].orderLinkId);
  assert.equal(recoveredFill.entry.orderId,"recovered");assert.ok(released);
});

test("definitive rejection releases reservation and persists no pending order", async t => {
  const s=setup(t,{submitLimitOrder:async()=>{throw Object.assign(new Error("insufficient margin"),{definitiveRejection:true});}});
  await s.manager.execute(signal);assert.equal(s.manager.hasPending(signal.symbol),false);
  assert.equal(s.logs.length,1);assert.equal(s.logs[0].status,"failed");
});

test("executor logs one fill with real position average, separate order fill and risk failure", async t => {
  const s=setup(t);
  const base=JSON.parse(fs.readFileSync(path.join(__dirname,"../config.example.json"),"utf8"));
  base.trading.positionSizeUsdt=500;base.trading.entryOrderType="limit";base.trading.stopLossPercent=15;base.trading.takeProfitPercent=null;
  base.trading.partialTpEnabled=false;base.logging.ordersLogPath=path.join(s.dir,"executor.log");
  const cf=path.join(s.dir,"config.json");fs.writeFileSync(cf,JSON.stringify(base));const config=loadConfig(cf);
  const client:any={...s.client,getOrderbook:async()=>({bestBid:100,bestAsk:101}),getOrderState:async()=>({orderStatus:"Filled",cumExecQty:5.55,avgPrice:100}),
    getOpenPosition:async()=>({avgPrice:105,size:10}),getOpenStopOrders:async()=>[],getOpenReduceOnlyLimitOrders:async()=>[],
    setTradingStop:async()=>{throw new Error("stop failed");}};
  const logs:any[]=[];const monitor:any={start:()=>{}};
  t.mock.timers.enable({apis:["setTimeout"]});
  const executor=new OrderExecutor(config,client,{log:(v:any)=>logs.push(v)} as any,monitor,monitor,monitor,new SymbolQueue());
  const done=executor.execute(signal);await flush();await tick(t,400);await done;
  assert.equal(logs.length,1);assert.equal(logs[0].status,"filled");assert.equal(logs[0].entryPriceRef,105);
  assert.equal(logs[0].orderFillPrice,100);assert.equal(logs[0].positionAvgPrice,105);
  assert.match(logs[0].error,/SL not set/);assert.equal(logs[0].signalTs,signal.timestamp);
});

test("chase calculates cumulative weighted average correctly across partial fills", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let calls=0;
  const client:any={getOrderbook:async()=>({bestBid:100,bestAsk:101}),submitLimitOrder:async()=>"x",
    getOrderState:async()=>++calls===1?{orderStatus:"PartiallyFilled",cumExecQty:1,avgPrice:100}:
      {orderStatus:"Filled",cumExecQty:2,avgPrice:101}};
  const done=chaseLimitEntry(client,{symbol:"TESTUSDT",side:"Buy",qty:2});
  await flush();await tick(t,400);await tick(t,400);
  assert.equal((await done).avgPrice,101);
});

test("recovery does not duplicate already journaled offset fill", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=setup(t); const entry={signal,side:"Buy",qty:1,refPrice:100,price:99.5,offsetPercent:.5,orderLinkId:"known",orderId:"known"};
  fs.writeFileSync(path.join(s.dir,"offset-entries.json"),JSON.stringify([entry]));
  fs.writeFileSync(s.config.logging.ordersLogPath,JSON.stringify({entryOrderType:"offset_limit",status:"filled",bybitOrderId:"known"})+'\n');
  let release=false;
  const manager=new OffsetLimitEntries(s.config,{...s.client,getOrderState:async()=>({orderStatus:"Filled",cumExecQty:1,avgPrice:99.5})},s.queue,{log:()=>{assert.fail("duplicate log");}} as any,async()=>{assert.fail("duplicate finalization");});
  manager.resume(()=>{release=true;});await tick(t);await flush();assert.ok(release);
});

for (const risk of [false,true]) test(`one final filled record when risk orders ${risk?'succeed':'are disabled'}`,async t=>{
  const s=setup(t);const base=JSON.parse(fs.readFileSync(path.join(__dirname,"../config.example.json"),"utf8"));
  base.trading.entryOrderType="offset_limit";base.trading.stopLossPercent=risk?15:null;
  base.trading.takeProfitPercent=risk?10:null;base.trading.partialTpEnabled=false;
  base.logging.ordersLogPath=path.join(s.dir,"executor.log");
  const cf=path.join(s.dir,"config.json");fs.writeFileSync(cf,JSON.stringify(base));const config=loadConfig(cf);
  const logs:any[]=[];const monitor:any={start:()=>{}};
  const client:any={...s.client,getOpenPosition:async()=>({avgPrice:99.4,size:1,side:"Buy"}),
    getOpenStopOrders:async()=>[],getOpenReduceOnlyLimitOrders:async()=>[],setTradingStop:async()=>{},submitTakeProfitLimitOrder:async()=>"tp"};
  const executor=new OrderExecutor(config,client,{log:(v:any)=>logs.push(v)} as any,monitor,monitor,monitor,new SymbolQueue());
  await (executor as any).run(signal,{entry:{signal,side:"Buy",qty:1,refPrice:100,price:99.5,offsetPercent:.5,orderLinkId:"test",orderId:"test"},qty:1,avgPrice:99.5,filledAt:1234,outcome:"Filled"});
  assert.equal(logs.length,1);assert.equal(logs[0].status,"filled");assert.equal(logs[0].entryPriceRef,99.4);
  assert.equal(logs[0].orderFillPrice,99.5);assert.equal(logs[0].error,null);
});

test("Bybit request attaches partial market SL and stable orderLinkId to offset order", async()=>{
  const {BybitClient}=await import("../src/bybit/client");
  const client:any=Object.create(BybitClient.prototype);let body:any;
  client.rest={submitOrder:async(p:any)=>{body=p;return {retCode:0,result:{orderId:"id"}};}};
  await client.submitLimitOrder({symbol:"TESTUSDT",side:"Buy",qty:1,price:99.5,orderLinkId:"known",stopLoss:90});
  assert.equal(body.timeInForce,"PostOnly");assert.equal(body.orderLinkId,"known");
  assert.equal(body.slOrderType,"Market");assert.equal(body.tpslMode,"Partial");assert.equal(body.stopLoss,"90");
});

test("2% distance uses directional price improvement and inclusive boundary",async()=>{
  const {entryDistancePercent,meetsEntryDistance}=await import("../src/bybit/offsetLimitEntry");
  assert.ok(meetsEntryDistance(100,98,"Buy",2));assert.ok(!meetsEntryDistance(100,98.01,"Buy",2));
  assert.ok(meetsEntryDistance(100,102,"Sell",2));assert.ok(!meetsEntryDistance(100,101.99,"Sell",2));
  assert.ok(!meetsEntryDistance(100,102,"Buy",2));assert.ok(!meetsEntryDistance(100,98,"Sell",2));
  assert.ok(Math.abs(entryDistancePercent(.07727,.07505,"Buy")-2.87304257797)<1e-8);
});

async function spacingSetup(t:any, position:any, side:"Buy"|"Sell"="Buy", previous=100, last=100) {
  const s=setup(t);s.config.trading.minEntryDistancePercent=2;
  fs.writeFileSync(s.config.logging.ordersLogPath,JSON.stringify({symbol:signal.symbol,side,status:"filled",
    orderFillPrice:previous,positionAvgPrice:105,ts:10})+'\n');
  let positionCalls=0,lastCalls=0,submitted=0;
  const client={...s.client,getOpenPositions:async()=>assert.fail("must not query all positions"),
    getOpenPosition:async(symbol:string)=>{assert.equal(symbol,signal.symbol);positionCalls++;if(position instanceof Error)throw position;return position;},
    getLastPrice:async()=>{lastCalls++;return last;},submitLimitOrder:async(p:any)=>{submitted++;s.submits.push(p);return 'spaced';}};
  const manager=new OffsetLimitEntries(s.config,client,s.queue,{log:(v:any)=>s.logs.push(v)} as any,async f=>{s.fills.push(f);});
  return {...s,manager,positionCalls:()=>positionCalls,lastCalls:()=>lastCalls,submitted:()=>submitted};
}

test("too-close add-on is skipped using last order fill, with no submission or additional REST calls",async t=>{
  const s=await spacingSetup(t,{side:"Buy",avgPrice:105,size:2});
  await s.manager.execute(signal);
  assert.equal(s.submitted(),0);assert.equal(s.positionCalls(),1);assert.equal(s.lastCalls(),1);
  assert.equal(s.logs.length,1);assert.equal(s.logs[0].status,"skipped");
  assert.equal(s.logs[0].entryOutcome,"min_entry_distance");assert.equal(s.logs[0].previousEntryPrice,100);
  assert.equal(s.manager.hasPending(signal.symbol),false);
});

test("after manual full close stale historical fill cannot block fresh initial entry",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const s=await spacingSetup(t,null);
  const done=s.manager.execute(signal);await flush();assert.equal(s.submitted(),1);
  s.setState({orderStatus:"Filled",cumExecQty:1,avgPrice:99.5});await tick(t);await done;
  assert.equal(s.fills.length,1);assert.equal(s.fills[0].entry.previousEntryPrice,null);
});

test("partial close retains reference and still enforces spacing",async t=>{
  const s=await spacingSetup(t,{side:"Buy",avgPrice:100,size:.1});
  await s.manager.execute(signal);assert.equal(s.submitted(),0);assert.equal(s.logs[0].status,"skipped");
});

test("position-query error blocks entry rather than pretending position was closed",async t=>{
  const s=await spacingSetup(t,new Error("position API unavailable"));await s.manager.execute(signal);
  assert.equal(s.submitted(),0);assert.equal(s.logs[0].status,"failed");assert.match(s.logs[0].error,/position API unavailable/);
});

test("XPL second entry passes 2% filter and restored history survives restart",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=await spacingSetup(t,{side:"Buy",avgPrice:.07727,size:1294},"Buy",.07727,.07543);
  // Use XPL's actual tick size.
  s.client.getInstrumentInfo=async()=>({qtyStep:1,minOrderQty:1,tickSize:.00001});
  // spacingSetup captured its own client; use an explicit restart with updated instrument data.
  const client={...s.client,getOpenPosition:async()=>({side:"Buy",avgPrice:.07727,size:1294}),getLastPrice:async()=>.07543};
  const manager=new OffsetLimitEntries(s.config,client,s.queue,{log:(v:any)=>s.logs.push(v)} as any,async f=>{s.fills.push(f);});
  const done=manager.execute(signal);await flush();assert.equal(s.submits.length,1);assert.equal(s.submits[0].price,.07505);
  s.setState({orderStatus:"Filled",cumExecQty:1332,avgPrice:.07505});await tick(t);await done;
  assert.equal(s.fills[0].entry.previousEntryPrice,.07727);assert.ok(s.fills[0].entry.actualEntryDistancePercent>2);
});

test("short add-on must be at least 2% above last sell",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});const s=await spacingSetup(t,{side:"Sell",avgPrice:100,size:1},"Sell",100,102);
  const done=s.manager.execute({...signal,direction:"SHORT"});await flush();assert.equal(s.submitted(),1);
  assert.ok(s.submits[0].price>=102);s.setState({orderStatus:"Filled",cumExecQty:1,avgPrice:102.51});await tick(t);await done;
});


test("spacing skip refunds its provisional rate-limit slot immediately",async t=>{
  const {PositionRateLimiter}=await import("../src/positionRateLimiter");
  const limiter=new PositionRateLimiter(2,300000);limiter.recordOpen(100);
  const refund=limiter.recordOpen(101);assert.equal(limiter.canOpen(102),false);
  const s=await spacingSetup(t,{side:"Buy",avgPrice:100,size:2});
  await s.manager.execute(signal,refund);assert.equal(limiter.canOpen(103),true);
  refund();limiter.recordOpen(104);assert.equal(limiter.canOpen(105),false);
});


test("invalid exchange position snapshot is not treated as a closed position",async()=>{
  const {BybitClient}=await import("../src/bybit/client");const client:any=Object.create(BybitClient.prototype);
  client.rest={getPositionInfo:async()=>({retCode:0,result:{list:[{size:"1",avgPrice:"",side:"Buy"}]}})};
  await assert.rejects(()=>client.getOpenPosition("TESTUSDT"),/Invalid open position snapshot/);
  client.rest={getPositionInfo:async()=>({retCode:0,result:{list:[{size:"0",avgPrice:"",side:""}]}})};
  assert.equal(await client.getOpenPosition("TESTUSDT"),null);
});

test("opposite signal submits normal-sized offset order without add-on spacing or attached opposite stop", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const s=await spacingSetup(t,{side:"Buy",avgPrice:100,size:10});
  const done=s.manager.execute({...signal,direction:"SHORT"});await flush();
  assert.equal(s.submitted(),1);assert.equal(s.submits[0].side,"Sell");
  assert.equal(s.submits[0].price,100.5);assert.equal(s.submits[0].stopLoss,null);
  assert.equal(s.logs[0].previousEntryPrice,null);
  s.setState({orderStatus:"Filled",cumExecQty:4.97,avgPrice:100.5});await tick(t);await done;
  // A reducing sale must not replace the last buy used by the next buy add-on, even after restart.
  fs.appendFileSync(s.config.logging.ordersLogPath,JSON.stringify({symbol:signal.symbol,side:"Sell",status:"filled",orderFillPrice:100.5,ts:20})+'\n');
  const restarted=new OffsetLimitEntries(s.config,{...s.client,getOpenPosition:async()=>({side:"Buy",avgPrice:100,size:5})},s.queue,{log:(v:any)=>s.logs.push(v)} as any,async()=>{});
  await restarted.execute(signal);
  assert.equal(s.submitted(),1);assert.equal(s.logs.at(-1).entryOutcome,"min_entry_distance");
  assert.equal(s.logs.at(-1).previousEntryPrice,100);
});

for (const remaining of [null,{side:"Buy",avgPrice:100,size:5}]) test(`opposite fill leaves existing risk orders alone when ${remaining?'long remains':'position is closed'}`,async t=>{
  const s=setup(t);const base=JSON.parse(fs.readFileSync(path.join(__dirname,"../config.example.json"),"utf8"));
  base.trading.entryOrderType="offset_limit";base.logging.ordersLogPath=path.join(s.dir,"executor.log");
  const cf=path.join(s.dir,"config.json");fs.writeFileSync(cf,JSON.stringify(base));
  const logs:any[]=[];const monitor:any={start:()=>{}};
  const executor=new OrderExecutor(loadConfig(cf),{...s.client,getOpenPosition:async()=>remaining,
    setTradingStop:async()=>assert.fail("must not create sell-position stops"),
    getOpenStopOrders:async()=>assert.fail("must not cancel existing protection")},
    {log:(v:any)=>logs.push(v)} as any,monitor,monitor,monitor,new SymbolQueue());
  const sell={...signal,direction:"SHORT" as const};
  await (executor as any).run(sell,{entry:{signal:sell,side:"Sell",qty:5,refPrice:100,price:100.5,orderId:"sell"},qty:5,avgPrice:100.5,filledAt:1234,outcome:"Filled"});
  assert.equal(logs.length,1);assert.equal(logs[0].status,"filled");
  assert.equal(logs[0].sl,null);
});
