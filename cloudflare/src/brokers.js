/** 交易通道层（Workers 版）：OkxBroker / PaperBroker / WalkBroker。
 *
 * 与 Python 版同一套资金冻结模型：
 *   下单即冻结（买扣 USDT、卖扣 BTC），成交结算（费用按 OKX 口径记负数），
 *   撤单返还；订单号带进程级唯一前缀，防止与持久化状态里的旧单号冲突。
 * 所有方法统一 async：Workers 下网络调用天然异步，纸面通道返回立即完成的 Promise。
 */
import { createOkxClient } from "./okx.js";
import { createWalkPriceFn } from "./walk.js";

const decOf = (unit) => Math.max(0, Math.round(-Math.log10(unit)));

function quantize(value, unit) {
  const d = decOf(unit);
  const q = Math.floor(value / unit + 1e-9) * unit;
  return parseFloat(q.toFixed(d));
}

const qStr = (v, unit) => String(quantize(v, unit));

export const MAKER_FEE = 0.0008;
export const TAKER_FEE = 0.001;

/** 通用基类：balances()/equity() 由 snapshot() 派生。 */
export class Broker {
  balances() {
    const out = {};
    for (const [ccy, v] of Object.entries(this.snapshot())) out[ccy] = v.avail;
    return out;
  }
  equity(px) {
    const s = this.snapshot();
    return (s[this.quoteCcy]?.total ?? 0) + (s[this.baseCcy]?.total ?? 0) * px;
  }
}

export class OkxBroker extends Broker {
  /** 模拟盘/实盘通道。先 new 再 await init() 拉取交易规则。 */
  constructor({ client, instId, log = () => {} }) {
    super();
    this.c = client;
    this.instId = instId;
    this.log = log;
    [this.baseCcy, this.quoteCcy] = instId.split("-");
  }

  async init() {
    const meta = (await this.c.instruments("SPOT", this.instId))[0];
    this.lotSz = parseFloat(meta.lotSz);
    this.minSz = parseFloat(meta.minSz);
    this.tickSz = parseFloat(meta.tickSz);
    this.log("info", `交易规则 ${this.instId}: minSz=${this.minSz} lotSz=${this.lotSz} tickSz=${this.tickSz}`);
    return this;
  }

  async price() {
    return parseFloat((await this.c.tickers(this.instId)).last);
  }

  async snapshot() {
    try {
      const out = {};
      const data = await this.c.balance();
      for (const d of data[0]?.details ?? []) {
        const avail = parseFloat(d.availBal || d.availEq || 0);
        out[d.ccy] = { avail, total: avail + parseFloat(d.frozenBal || 0) };
      }
      this._lastSnap = out;
      return out;
    } catch (e) {
      // WAF/限流拦截时回退到最近一次成功快照（面板显示用；下单路径不受影响）
      this.log("warning", `余额查询失败，使用最近成功快照: ${e.message}`);
      return this._lastSnap ?? {};
    }
  }

  async placeLimit(side, px, sz) {
    const pxS = qStr(px, this.tickSz);
    const szS = qStr(sz, this.lotSz);
    if (parseFloat(szS) < this.minSz || parseFloat(pxS) <= 0) {
      this.log("warning", `跳过过小订单 ${side} ${szS}@${pxS} (minSz=${this.minSz})`);
      return null;
    }
    let r;
    try {
      r = await this.c.placeOrder(this.instId, side, "limit", szS, pxS);
    } catch (e) {
      this.log("error", `下单失败 ${side} ${szS}@${pxS}: ${e.message}`);
      return null;
    }
    if (r.sCode !== "0") {
      this.log("error", `下单被拒 ${side} ${szS}@${pxS}: sCode=${r.sCode} sMsg=${r.sMsg}`);
      return null;
    }
    this.log("info", `[实盘] 限价单 ${side} ${szS} ${this.instId} @ ${pxS} ordId=${r.ordId}`);
    return r.ordId;
  }

  async placeMarket(side, sz) {
    const szS = qStr(sz, this.lotSz);
    if (parseFloat(szS) < this.minSz) {
      this.log("warning", `市价单数量过小，跳过: ${szS}`);
      return null;
    }
    let r;
    try {
      r = await this.c.placeOrder(this.instId, side, "market", szS);
    } catch (e) {
      this.log("error", `市价单失败 ${side} ${szS}: ${e.message}`);
      return null;
    }
    if (r.sCode !== "0") {
      this.log("error", `市价单被拒: sCode=${r.sCode} sMsg=${r.sMsg}`);
      return null;
    }
    this.log("info", `[实盘] 市价单 ${side} ${szS} ${this.instId}`);
    return r.ordId;
  }

  async cancelAll() {
    let orders = [];
    try { orders = await this.c.pendingOrders(this.instId); }
    catch (e) { this.log("error", `查询挂单失败: ${e.message}`); return; }
    for (const o of orders) {
      try {
        const r = await this.c.cancelOrder(this.instId, o.ordId);
        if (r.sCode && r.sCode !== "0") {
          this.log("warning", `[实盘] 撤单未成功 ordId=${o.ordId} sCode=${r.sCode} sMsg=${r.sMsg}`);
        } else {
          this.log("info", `[实盘] 已撤单 ordId=${o.ordId}`);
        }
      } catch (e) {
        this.log("warning", `撤单失败 ordId=${o.ordId}: ${e.message}`);
      }
    }
  }

  async pending() {
    const orders = await this.c.pendingOrders(this.instId);
    return orders.map((o) => ({
      ord_id: o.ordId,
      side: o.side,
      px: o.px ? parseFloat(o.px) : 0,
      sz: parseFloat(o.accFillSz || o.sz),
      ord_type: o.ordType,
    }));
  }

  async fills(seenIds) {
    const res = [];
    let hist = [];
    try { hist = await this.c.ordersHistory(this.instId, 100); }
    catch (e) { this.log("error", `查询历史订单失败: ${e.message}`); return res; }
    for (const o of hist) {
      const oid = o.ordId;
      if (seenIds.has(oid)) continue;
      seenIds.add(oid);
      const acc = parseFloat(o.accFillSz || 0);
      if (o.state === "filled" || (o.state === "canceled" && acc > 0)) {
        const px = parseFloat(o.avgPx || o.px || 0);
        const fee = parseFloat(o.fee || 0);
        res.push({ ord_id: oid, side: o.side, px, sz: acc, fee });
        this.log("info", `[实盘] 成交(${o.state}) ${o.side} ${acc} @ ${px} fee=${fee}`);
      }
    }
    return res;
  }
}

export class PaperBroker extends Broker {
  /** 纸面模拟：行情驱动，钱包在本地模拟。可序列化以在 DO 休眠后恢复。 */
  constructor({ instId = "BTC-USDT", startUsdt = 14, priceFn = async () => 65000,
                lotSz = 1e-8, minSz = 1e-5, tickSz = 0.1, log = () => {} } = {}) {
    super();
    this.instId = instId;
    [this.baseCcy, this.quoteCcy] = instId.split("-");
    this.priceFn = priceFn;
    this.lotSz = lotSz; this.minSz = minSz; this.tickSz = tickSz;
    this.log = log;
    this.usdt = startUsdt;
    this.base = 0;
    this.feesPaid = 0;
    this.orders = new Map();      // oid -> {side, px, sz}
    this.pendingFills = [];
    this.idPrefix = crypto.randomUUID().slice(0, 8) + "-";
    this.idCounter = 1;
    this.log("info", `纸面模拟钱包: ${this.quoteCcy}=${this.usdt.toFixed(4)} (仅本地模拟)`);
  }

  async price() { return this.priceFn(); }

  serialize() {
    return { usdt: this.usdt, base: this.base, feesPaid: this.feesPaid,
             orders: [...this.orders.entries()], pendingFills: this.pendingFills,
             idCounter: this.idCounter, idPrefix: this.idPrefix };
  }
  restore(s) {
    if (!s) return;
    this.usdt = s.usdt; this.base = s.base; this.feesPaid = s.feesPaid;
    this.orders = new Map(s.orders); this.pendingFills = s.pendingFills;
    this.idCounter = s.idCounter; this.idPrefix = s.idPrefix;
  }

  snapshot() {
    let fq = 0, fb = 0;
    for (const o of this.orders.values()) {
      if (o.side === "buy") fq += o.px * o.sz; else fb += o.sz;
    }
    return {
      [this.quoteCcy]: { avail: this.usdt, total: this.usdt + fq },
      [this.baseCcy]: { avail: this.base, total: this.base + fb },
    };
  }

  _tryFill() {
    const px = this.priceFn();
    for (const [oid, o] of [...this.orders.entries()]) {
      const hit = (o.side === "buy" && px <= o.px) || (o.side === "sell" && px >= o.px);
      if (hit) {
        this.orders.delete(oid);
        this.pendingFills.push([oid, o.side, o.px, o.sz]);
        this.log("info", `[模拟] 成交 ${o.side} ${o.sz} @ ${o.px}`);
      }
    }
  }

  async placeLimit(side, px, sz) {
    const pxS = qStr(px, this.tickSz);
    const szS = qStr(sz, this.lotSz);
    const pxf = parseFloat(pxS), szf = parseFloat(szS);
    if (szf < this.minSz || pxf <= 0) {
      this.log("warning", `[模拟] 跳过过小订单 ${side} ${szS}@${pxS}`);
      return null;
    }
    if (side === "buy") {
      const cost = pxf * szf;
      if (cost > this.usdt) {
        this.log("warning", `[模拟] USDT 不足 (${this.usdt.toFixed(4)} < ${cost.toFixed(4)})，跳过买单`);
        return null;
      }
      this.usdt -= cost;
    } else {
      if (szf > this.base) {
        this.log("warning", `[模拟] ${this.baseCcy} 余额不足，跳过卖单`);
        return null;
      }
      this.base -= szf;
    }
    const oid = this.nextId();
    this.orders.set(oid, { side, px: pxf, sz: szf });
    this.log("info", `[模拟] 限价单 ${side} ${szS} ${this.instId} @ ${pxS}`);
    return oid;
  }

  async placeMarket(side, sz) {
    const szf = quantize(sz, this.lotSz);
    if (szf < this.minSz) return null;
    const px = await this.price();
    if (side === "sell") {
      if (szf > this.base) return null;
      this.base -= szf;
      const fee = -px * szf * TAKER_FEE;
      this.usdt += px * szf + fee;
      this.feesPaid += Math.abs(fee);
      this.log("info", `[模拟] 市价卖出 ${szf} @ ${px}`);
      return this.nextId();
    }
    const cost = px * szf * 1.001;
    if (cost > this.usdt) return null;
    this.usdt -= cost;
    this.base += szf;
    return this.nextId();
  }

  async cancelAll() {
    for (const o of this.orders.values()) {
      if (o.side === "buy") this.usdt += o.px * o.sz;
      else this.base += o.sz;
    }
    this.orders.clear();
  }

  async pending() {
    return [...this.orders.entries()].map(([oid, o]) =>
      ({ ord_id: oid, side: o.side, px: o.px, sz: o.sz, ord_type: "limit" }));
  }

  async fills(seenIds) {
    this._tryFill();
    const res = [];
    for (const [oid, side, px, sz] of this.pendingFills) {
      if (seenIds.has(oid)) continue;
      seenIds.add(oid);
      let fee;
      if (side === "buy") {
        fee = -sz * MAKER_FEE;           // 买入费用以基础币计（OKX 口径）
        this.base += sz + fee;
      } else {
        fee = -px * sz * MAKER_FEE;      // 卖出费用以报价币计
        this.usdt += px * sz + fee;
      }
      this.feesPaid += Math.abs(fee);
      res.push({ ord_id: oid, side, px, sz, fee });
    }
    this.pendingFills = this.pendingFills.filter((f) => !seenIds.has(f[0]));
    return res;
  }

  nextId() { return this.idPrefix + this.idCounter++; }
}

/** 离线演示通道：PaperBroker + 随机游走价格。 */
export class WalkBroker extends PaperBroker {
  constructor({ instId = "BTC-USDT", startUsdt = 14, startPx = 65000, log = () => {} } = {}) {
    super({ instId, startUsdt, priceFn: createWalkPriceFn({ startPx }), log });
  }
}

/** 按模式构建通道；brokerState 用于恢复纸面钱包。 */
export async function makeBroker(cfg, env, brokerState, log) {
  const okxKeys = {
    apiKey: env.OKX_API_KEY ?? "",
    secretKey: env.OKX_API_SECRET ?? "",
    passphrase: env.OKX_API_PASSPHRASE ?? "",
    log,
  };
  let broker;
  if (cfg.mode === "offline") {
    broker = new WalkBroker({ instId: cfg.instId, startUsdt: cfg.paperUsdt, log });
  } else {
    const client = createOkxClient({ ...okxKeys, simulated: cfg.mode === "demo" });
    if (cfg.mode === "dry") {
      const pub = createOkxClient({ log });
      broker = new PaperBroker({ instId: cfg.instId, startUsdt: cfg.paperUsdt,
        priceFn: async () => parseFloat((await pub.tickers(cfg.instId)).last), log });
    } else {
      broker = new OkxBroker({ client, instId: cfg.instId, log });
      await broker.init();
      const bal = broker.balances();
      if ((bal[broker.quoteCcy] ?? 0) <= 0) {
        log("warning", `${broker.quoteCcy} 可用为 0：请确认资金已划转到「交易账户」，否则下单会失败`);
      }
    }
  }
  if (brokerState && broker.restore) broker.restore(brokerState);
  return broker;
}
