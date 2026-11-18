/** 每日复盘模块测试：跨日固化、重置基线、规则建议（与 Python 版同场景）。 */
import { describe, it, expect } from "vitest";
import { DailyTracker, buildReview } from "../src/review.js";

// 2026-11-17 12:00 北京时间 = 04:00 UTC；逐日推进用固定时间戳
const DAY1 = Date.parse("2026-11-17T04:00:00Z");
const DAY2 = Date.parse("2026-11-18T04:00:00Z");

function sample(over = {}) {
  return Object.assign({
    instId: "BTC-USDT", px: 65000, equity: 14, cycles: 0, realized: 0, fees: 0,
    buyFills: 0, sellFills: 0, openBuys: 5, openSells: 0, committed: 7.5,
    halted: false, paused: false,
  }, over);
}

describe("DailyTracker", () => {
  it("跨日固化昨日记录，今日从新基线开始", () => {
    let now = DAY1;
    const tr = new DailyTracker(() => now);
    tr.update(sample({ px: 65000, equity: 14 }));
    tr.update(sample({ px: 66000, equity: 14.1, cycles: 3, realized: 0.05,
      fees: 0.01, buyFills: 3, sellFills: 3, openBuys: 4, committed: 6 }));
    now = DAY2;                                          // 跨自然日
    const rolled = tr.update(sample({ px: 65500, equity: 14.05 }));
    expect(rolled).not.toBeNull();
    expect(rolled.date).toBe("2026-11-17");
    expect(rolled.end_equity).toBe(14.1);
    expect(tr.days["2026-11-17"].active).toBe(false);
    expect(tr.todayRecord().start_equity).toBe(14.05);
  });

  it("重启恢复当日记录（load/export 往返）", () => {
    const tr = new DailyTracker(() => DAY1);
    tr.update(sample({ px: 65000, equity: 14 }));
    const tr2 = new DailyTracker(() => DAY1);
    tr2.load(tr.export());
    tr2.update(sample({ px: 65100, equity: 14.01 }));
    expect(tr2.todayRecord().ticks).toBe(2);
  });

  it("重置基线：计数器回落时日增量不再为负", () => {
    const tr = new DailyTracker(() => DAY1);
    tr.update(sample({ cycles: 10, realized: 0.15, fees: 0.05, buyFills: 10, sellFills: 10 }));
    tr.update(sample({ cycles: 0, realized: 0, fees: 0 }));                    // reset
    tr.update(sample({ px: 65200, equity: 14.02, cycles: 2, realized: 0.01,
      fees: 0.002, buyFills: 2, sellFills: 2 }));
    const r = tr.todayRecord();
    expect(r.cycles_end - r.cycles_start).toBe(2);
    expect(r.resets_seen).toBe(1);
  });

  it("lastDays/lastReviews 汇总正确", () => {
    const tr = new DailyTracker(() => DAY1);
    tr.update(sample({ px: 65000, equity: 14 }));
    tr.addReview("2026-11-17", { findings: [], suggestions: [] }, true);
    expect(tr.lastDays(7)[0].date).toBe("2026-11-17");
    expect(tr.lastReviews(7)[0].date).toBe("2026-11-17");
  });
});

const CFG = { upper: 70000, lower: 58000, grids: 8, budget: 12,
  committed: 7.5, open_buys: 5, open_sells: 0, base_value: 0.5 };

describe("buildReview 规则", () => {
  it("无数据日", () => {
    const r = buildReview({ ticks: 0 }, CFG);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.suggestions[0].action.type).toBe("none");
  });

  it("断路器日：风险提示 + 下移区间 + 暂停备选", () => {
    const rec = { ticks: 100, px_high: 64500, px_low: 56000, end_px: 56000,
      start_equity: 14, end_equity: 12.9, cycles_start: 0, cycles_end: 4,
      realized_start: 0, realized_end: -0.3, fees_start: 0, fees_end: 0.01,
      halted_seen: true, paused_ticks: 0 };
    const r = buildReview(rec, { ...CFG, committed: 0, open_buys: 0, open_sells: 0, base_value: 0 });
    expect(r.findings.some((f) => f.level === "risk")).toBe(true);
    expect(r.suggestions[0].action.type).toBe("reconfigure");
    expect(r.suggestions[0].changes.lower).toBeLessThan(58000);
    expect(r.suggestions.some((s) => s.action.type === "pause")).toBe(true);
    expect(r.suggestions.every((s) => s.id)).toBe(true);
  });

  it("价格全程高于上沿：建议上移", () => {
    const rec = { ticks: 100, px_high: 72500, px_low: 70500, end_px: 72500,
      start_equity: 14, end_equity: 14, cycles_start: 0, cycles_end: 0,
      realized_start: 0, realized_end: 0, fees_start: 0, fees_end: 0, paused_ticks: 0 };
    const r = buildReview(rec, { ...CFG, committed: 12, open_buys: 8, open_sells: 0, base_value: 0 });
    expect(r.suggestions[0].action.type).toBe("reconfigure");
    expect(r.suggestions[0].changes.upper).toBeGreaterThan(70000);
  });

  it("手续费侵蚀：建议减少格数", () => {
    const rec = { ticks: 200, px_high: 65200, px_low: 64900, end_px: 65100,
      start_equity: 14, end_equity: 14, cycles_start: 0, cycles_end: 6,
      realized_start: 0, realized_end: 0.02, fees_start: 0, fees_end: 0.05, paused_ticks: 0 };
    const r = buildReview(rec, CFG);
    expect(r.suggestions.some((s) => s.changes.grids === 6)).toBe(true);
  });

  it("库存过重：建议暂停", () => {
    const rec = { ticks: 200, px_high: 62500, px_low: 58800, end_px: 59000,
      start_equity: 14, end_equity: 13.2, cycles_start: 0, cycles_end: 5,
      realized_start: 0, realized_end: 0.04, fees_start: 0, fees_end: 0.02, paused_ticks: 0 };
    const r = buildReview(rec, { ...CFG, committed: 9, open_buys: 0, open_sells: 2, base_value: 1.8 });
    expect(r.suggestions.some((s) => s.action.type === "pause")).toBe(true);
  });

  it("健康日：维持现状，不鼓动调参", () => {
    const rec = { ticks: 300, px_high: 65800, px_low: 64200, end_px: 65300,
      start_equity: 14, end_equity: 14.15, cycles_start: 0, cycles_end: 5,
      realized_start: 0, realized_end: 0.12, fees_start: 0, fees_end: 0.01, paused_ticks: 0 };
    const r = buildReview(rec, CFG);
    expect(r.findings.some((f) => f.level === "ok")).toBe(true);
    expect(r.suggestions.some((s) => s.action.type === "none")).toBe(true);
    expect(r.suggestions.every((s) => s.action.type !== "reconfigure")).toBe(true);
  });
});
