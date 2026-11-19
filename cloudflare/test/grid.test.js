/** 网格引擎确定性测试（与 Python 版 test_offline.py 同场景）+ 资金守恒终检。 */
import { describe, it, expect } from "vitest";
import { GridEngine, validateConfig, GridConfigError } from "../src/grid.js";

const LOT = 1e-8, MIN = 1e-5, TICK = 0.1;
const q = (v, unit, dec) => parseFloat((Math.floor(v / unit + 1e-9) * unit).toFixed(dec));

class StubBroker {
  constructor(path) {
    this.path = path; this.i = -1;
    this.usdt = 14; this.base = 0;
    this.orders = new Map(); this.id = 1;
    this.baseCcy = "BTC"; this.quoteCcy = "USDT";
  }
  _px() { return this.path[Math.max(0, this.i)]; }
  async price() { this.i = Math.min(this.i + 1, this.path.length - 1); return this._px(); }
  async snapshot() {
    let fq = 0, fb = 0;
    for (const o of this.orders.values()) {
      if (o.side === "buy") fq += o.px * o.sz; else fb += o.sz;
    }
    return { USDT: { avail: this.usdt, total: this.usdt + fq },
             BTC: { avail: this.base, total: this.base + fb } };
  }
  async placeLimit(side, px, sz) {
    px = q(px, TICK, 1); sz = q(sz, LOT, 8);
    if (sz < MIN || px <= 0) return null;
    if (side === "buy") {
      const c = px * sz;
      if (c > this.usdt) return null;
      this.usdt -= c;
    } else {
      if (sz > this.base) return null;
      this.base -= sz;
    }
    const oid = String(this.id++);
    this.orders.set(oid, { side, px, sz });
    return oid;
  }
  async placeMarket(side, sz) {
    sz = q(sz, LOT, 8);
    if (sz < MIN) return null;
    const px = this._px();
    if (side === "sell") {
      if (sz > this.base) return null;
      this.base -= sz;
      this.usdt += px * sz * 0.999;
      return String(this.id++);
    }
    return null;
  }
  async cancelAll() {
    for (const o of this.orders.values()) {
      if (o.side === "buy") this.usdt += o.px * o.sz;
      else this.base += o.sz;
    }
    this.orders.clear();
  }
  async pending() {
    return [...this.orders.entries()].map(([ord_id, o]) =>
      ({ ord_id, side: o.side, px: o.px, sz: o.sz, ord_type: "limit" }));
  }
  async fills(seen) {
    const px = this._px(); const res = [];
    for (const [oid, o] of [...this.orders.entries()]) {
      const hit = (o.side === "buy" && px <= o.px) || (o.side === "sell" && px >= o.px);
      if (!hit) continue;
      this.orders.delete(oid);
      const fee = o.side === "buy" ? -o.sz * 0.0008 : -o.px * o.sz * 0.0008;
      if (o.side === "buy") this.base += o.sz + fee;
      else this.usdt += o.px * o.sz + fee;
      seen.add(oid);
      res.push({ ord_id: oid, side: o.side, px: o.px, sz: o.sz, fee });
    }
    return res;
  }
}

const CFG = { mode: "offline", instId: "BTC-USDT", upper: 70000, lower: 58000,
  grids: 8, budget: 12, breakdownBuffer: 0.02, breakdownAction: "stop_loss",
  intervalSec: 5, paperUsdt: 14 };

async function runTicks(engine, broker, n) {
  for (let i = 0; i < n; i++) await engine.tick();
}

describe("validateConfig", () => {
  it("拦截 NaN/非法格数/非法缓冲/相等边界", () => {
    expect(() => validateConfig({ upper: NaN, lower: 1, grids: 8, budget: 12,
      breakdownBuffer: 0.02, breakdownAction: "stop_loss" })).toThrow(GridConfigError);
    expect(() => validateConfig({ upper: 70000, lower: 58000, grids: 500, budget: 12,
      breakdownBuffer: 0.02, breakdownAction: "stop_loss" })).toThrow(GridConfigError);
    expect(() => validateConfig({ upper: 70000, lower: 58000, grids: 8, budget: 12,
      breakdownBuffer: -0.1, breakdownAction: "stop_loss" })).toThrow(GridConfigError);
    expect(() => validateConfig({ upper: 70000, lower: 70000, grids: 8, budget: 12,
      breakdownBuffer: 0.02, breakdownAction: "stop_loss" })).toThrow(GridConfigError);
    expect(() => validateConfig({ upper: 70000, lower: 58000, grids: 8, budget: 12,
      breakdownBuffer: 0.02, breakdownAction: "stop_loss" })).not.toThrow();
  });
});

describe("网格引擎", () => {
  it("场景A 跌后回升：完成循环、盈利、预算约束、资金守恒", { timeout: 60000 }, async () => {
    const broker = new StubBroker([
      66000, 64000, 64000, 61000, 61000, 59000, 59000,
      62000, 62000, 65000, 65000, 68000, 68000, 69000, 69000]);
    const logs = [];
    const engine = new GridEngine(CFG, broker, null, (l, m) => logs.push(`${l}:${m}`));
    await runTicks(engine, broker, 9);
    const s = engine.summary();
    expect(s.cycles).toBeGreaterThanOrEqual(2);
    expect(s.realized_pnl).toBeGreaterThan(0);
    expect(s.halted).toBe(false);
    expect(Object.keys(engine.st.buys).length + Object.keys(engine.st.sells).length).toBeGreaterThan(0);
    expect(engine._committed()).toBeLessThanOrEqual(12 + 1e-6);
    // 资金守恒：全部撤单回现金后，usdt ≈ 本金 + 已实现盈亏（差额=未卖出的亚最小单位灰尘）
    await engine.reset();
    expect(broker.base).toBeLessThan(5e-6);
    expect(Math.abs(broker.usdt - 14 - s.realized_pnl)).toBeLessThan(0.5);
  });

  it("场景B 单边暴跌：断路器清仓回 USDT 停机", { timeout: 30000 }, async () => {
    const broker = new StubBroker([66000, 60000, 55000]);
    const engine = new GridEngine(CFG, broker, null, () => {});
    await runTicks(engine, broker, 4);
    expect(engine.st.halted).toBe(true);
    expect(broker.base).toBeLessThan(1e-6);
    expect(broker.usdt).toBeGreaterThan(8);
  });

  it("场景C hold 模式：保留持仓停机", { timeout: 30000 }, async () => {
    const broker = new StubBroker([66000, 64500, 61000, 58500, 55000]);
    const engine = new GridEngine({ ...CFG, breakdownAction: "hold" }, broker, null, () => {});
    await runTicks(engine, broker, 6);
    expect(engine.st.halted).toBe(true);
    expect(broker.base).toBeGreaterThan(1e-5);
  });

  it("场景D 长震荡多循环：预算永不超限且每轮守恒（含未实现盈亏口径）", { timeout: 60000 }, async () => {
    // 多次往返震荡，每次下探/回升触发买卖
    const path = [
      66000, 61500, 61500, 59500, 59500, 65000, 65000,
      61500, 61500, 59500, 59500, 65000, 65000,
      61500, 61500, 59500, 59500, 65000, 65000];
    const broker = new StubBroker(path);
    const engine = new GridEngine(CFG, broker, null, () => {});
    for (let i = 0; i < path.length; i++) {
      await engine.tick();
      expect(engine._committed()).toBeLessThanOrEqual(12 + 1e-6);
      const s = engine.summary();
      const snap = await broker.snapshot();
      const equity = snap.USDT.total + snap.BTC.total * (engine.lastPx || 66000);
      // 恒等式：权益 = 本金 + 已实现盈亏 - 买入手续费 + 未实现盈亏(库存市值-投入)
      const unrealized = snap.BTC.total * (engine.lastPx || 66000) - engine.st.invested_quote;
      expect(Math.abs(equity - 14 - s.realized_pnl + s.fees - unrealized)).toBeLessThan(0.05);
    }
    expect(engine.st.cycles).toBeGreaterThanOrEqual(4);
  });
});
