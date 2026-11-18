/** 每日复盘（Workers 版，从 Python 版 1:1 移植）。
 *
 * 原则：建议由确定性规则计算，绝不自动执行——任何调整必须由用户二次确认。
 * 数据按北京时间自然日切分（Workers 运行在 UTC，这里显式用 Asia/Shanghai）。
 */

const MAX_DAYS = 30;
const MAX_REVIEWS = 60;
const SH = "Asia/Shanghai";

export function shanghaiDate(ms = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SH, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(ms);
}

export function shanghaiTime(ms = Date.now()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SH, hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(ms);
}

function roundPx(px) {
  if (px >= 1000) return Number(px.toFixed(1));
  if (px >= 1) return Number(px.toFixed(2));
  return Number(px.toFixed(6));
}

/** 每日数据采集器。days/reviews 由调用方（GridDO）持久化。 */
export class DailyTracker {
  constructor(nowFn = null) {
    this._now = nowFn ?? (() => Date.now());
    this.days = {};
    this.reviews = {};
  }

  load(saved) {
    if (saved?.days) this.days = saved.days;
    if (saved?.reviews) this.reviews = saved.reviews;
  }

  export() { return { days: this.days, reviews: this.reviews }; }

  update({ instId, px, equity, cycles, realized, fees, buyFills, sellFills,
           openBuys, openSells, committed, halted, paused }) {
    const today = shanghaiDate(this._now());
    let rollover = null;
    let rec = this.days[today];
    if (!rec) {
      rec = {
        date: today, inst_id: instId, active: true,
        start_px: px, end_px: px, px_high: px, px_low: px,
        start_equity: equity, end_equity: equity,
        cycles_start: cycles, cycles_end: cycles,
        realized_start: realized, realized_end: realized,
        fees_start: fees, fees_end: fees,
        buy_fills_start: buyFills, buy_fills_end: buyFills,
        sell_fills_start: sellFills, sell_fills_end: sellFills,
        open_buys_end: openBuys, open_sells_end: openSells,
        committed_end: committed,
        ticks: 1, paused_ticks: 0, halted_seen: halted, reconfigs: 0,
      };
      // 关闭此前仍活跃的旧记录（跨日/断连恢复场景）
      for (const [d, r] of Object.entries(this.days)) {
        if (d !== today && r.active) {
          r.active = false;
          if (!rollover || d > rollover.date) rollover = r;
        }
      }
    } else {
      rollover = null;
      // 重置检测：循环数只会单调递增，回落说明网格被 reset/重铺，重新锚定基线
      if (cycles < (rec.cycles_start ?? cycles)) {
        rec.cycles_start = cycles;
        rec.realized_start = realized;
        rec.fees_start = fees;
        rec.buy_fills_start = buyFills;
        rec.sell_fills_start = sellFills;
        rec.resets_seen = (rec.resets_seen ?? 0) + 1;
      }
      Object.assign(rec, {
        end_px: px, end_equity: equity,
        cycles_end: cycles, realized_end: realized, fees_end: fees,
        buy_fills_end: buyFills, sell_fills_end: sellFills,
        open_buys_end: openBuys, open_sells_end: openSells,
        committed_end: committed,
        ticks: (rec.ticks ?? 0) + 1,
      });
      rec.px_high = Math.max(rec.px_high ?? px, px);
      rec.px_low = Math.min(rec.px_low ?? px, px);
      if (halted) rec.halted_seen = true;
      if (paused) rec.paused_ticks = (rec.paused_ticks ?? 0) + 1;
    }
    this.days[today] = rec;
    this._trim();
    return rollover;
  }

  noteReconfig() {
    const rec = this.days[shanghaiDate(this._now())];
    if (rec) rec.reconfigs = (rec.reconfigs ?? 0) + 1;
  }

  addReview(dateStr, review, interim) {
    const stored = {
      date: dateStr,
      generated_at: shanghaiTime(this._now()),
      interim,
      findings: review.findings ?? [],
      suggestions: review.suggestions ?? [],
    };
    this.reviews[dateStr] = stored;
    const keys = Object.keys(this.reviews);
    if (keys.length > MAX_REVIEWS) {
      for (const d of keys.sort().slice(0, keys.length - MAX_REVIEWS)) delete this.reviews[d];
    }
    return stored;
  }

  lastDays(n = 7) {
    return Object.keys(this.days).sort().reverse().slice(0, n).map((d) => {
      const r = this.days[d];
      return {
        date: d,
        pnl: Number(((r.end_equity ?? 0) - (r.start_equity ?? 0)).toFixed(4)),
        cycles: (r.cycles_end ?? 0) - (r.cycles_start ?? 0),
        realized: Number(((r.realized_end ?? 0) - (r.realized_start ?? 0)).toFixed(4)),
        fees: Number(((r.fees_end ?? 0) - (r.fees_start ?? 0)).toFixed(4)),
      };
    });
  }

  lastReviews(n = 7) {
    return Object.keys(this.reviews).sort().reverse().slice(0, n)
      .map((d) => this.reviews[d]);
  }

  todayRecord() { return this.days[shanghaiDate(this._now())] ?? null; }

  _trim() {
    const keys = Object.keys(this.days);
    if (keys.length > MAX_DAYS) {
      for (const d of keys.sort().slice(0, keys.length - MAX_DAYS)) delete this.days[d];
    }
  }
}

/** 规则化分析。rec 当日记录，cfg 当前参数与持仓概况。 */
export function buildReview(rec, cfg) {
  const findings = [];
  const suggestions = [];
  const F = (level, title, detail) => findings.push({ level, title, detail });

  if (!rec || (rec.ticks ?? 0) === 0) {
    F("info", "今日无运行数据", "机器人未连接，或当日没有产生任何采样。");
    suggestions.push({ id: "S1", kind: "keep", urgency: "ok", title: "维持现状",
      reason: "暂无数据可供分析，先连接并运行一段时间。", changes: {}, action: { type: "none" } });
    return { findings, suggestions };
  }

  const dayPnl = (rec.end_equity ?? 0) - (rec.start_equity ?? 0);
  const dayRealized = (rec.realized_end ?? 0) - (rec.realized_start ?? 0);
  const dayFees = (rec.fees_end ?? 0) - (rec.fees_start ?? 0);
  const cycles = (rec.cycles_end ?? 0) - (rec.cycles_start ?? 0);
  const hi = rec.px_high ?? 0, lo = rec.px_low ?? 0;
  const endPx = rec.end_px ?? 0;
  const upper = cfg.upper ?? 0, lower = cfg.lower ?? 0;
  const grids = cfg.grids ?? 0, budget = cfg.budget || 1;
  const spreadRatio = lower ? (upper - lower) / lower : 0;
  const invRatio = Math.min((cfg.committed ?? 0) / budget, 1);

  F("info", "当日概览",
    `完成 ${cycles} 个买卖循环，已实现盈亏 ${dayRealized.toFixed(4)} USDT，` +
    `手续费 ${dayFees.toFixed(4)} USDT，账户变动 ${dayPnl.toFixed(4)} USDT；` +
    `价格区间 ${roundPx(lo)} ~ ${roundPx(hi)}。`);

  let sid = 0;
  const nextId = () => `S${++sid}`;

  // 1) 断路器 —— 最高优先级
  if (rec.halted_seen) {
    F("risk", "触发了下跌断路器",
      "价格跌破网格下沿并已按设定清仓/停机。继续沿用原区间会立即再次触发。");
    const newLower = roundPx(Math.min(lo * 0.98, lower * 0.92));
    const newUpper = roundPx(newLower * (1 + spreadRatio));
    suggestions.push({ id: nextId(), kind: "reconfigure", urgency: "risk",
      title: "整体下移网格区间并重新铺网",
      reason: "下移后保持格距不变，避免在当前价位立即再次触发断路器；执行会撤销现有挂单并按新区间重新下单。",
      changes: { lower: newLower, upper: newUpper, grids },
      action: { type: "reconfigure" } });
    suggestions.push({ id: nextId(), kind: "pause", urgency: "warn",
      title: "先暂停，人工观察后再定",
      reason: "不确定后续走势时，暂停不会新增操作（已有挂单保留），观察后再决定。",
      changes: {}, action: { type: "pause" } });
    return { findings, suggestions: suggestions.slice(0, 3) };
  }

  // 2) 价格全程高于上沿
  if (lo > upper) {
    F("warn", "价格全程高于网格上沿", "当日没有买入成交，机器人基本空转。");
    const newUpper = roundPx(hi * 1.005);
    const newLower = roundPx(newUpper / (1 + spreadRatio));
    suggestions.push({ id: nextId(), kind: "reconfigure", urgency: "warn",
      title: "上移网格区间",
      reason: "把区间上移到近期价格带内，恢复低买高卖能力；执行会撤单重铺。",
      changes: { lower: newLower, upper: newUpper, grids },
      action: { type: "reconfigure" } });
  }

  // 3) 库存过重
  const mid = (upper + lower) / 2;
  if (invRatio > 0.6 && endPx < mid) {
    F("warn", "底部库存占比偏高",
      `网格预算的 ${Math.round(invRatio * 100)}% 已变成持币，说明下跌中买入多于卖出，` +
      "若继续下跌会进一步放大浮亏。");
    if ((rec.paused_ticks ?? 0) < (rec.ticks ?? 1) / 2) {
      suggestions.push({ id: nextId(), kind: "pause", urgency: "warn",
        title: "暂停网格，控制继续沉底",
        reason: "暂停后不再新铺买单（已有挂单保留），等待你判断后再继续。",
        changes: {}, action: { type: "pause" } });
    }
  }

  // 4) 手续费侵蚀
  if (cycles >= 3 && dayFees > 0 && dayRealized >= 0 && dayFees > dayRealized * 0.6) {
    F("warn", "手续费侵蚀明显",
      `费用 ${dayFees.toFixed(4)} USDT 相对已实现盈亏 ${dayRealized.toFixed(4)} USDT 占比过高，格距太密时常见。`);
    suggestions.push({ id: nextId(), kind: "reconfigure", urgency: "info",
      title: "减少格数、拉大单格间距",
      reason: `格数 ${grids} → ${Math.max(4, grids - 2)}，单格利润变厚，费用占比下降；执行会撤单重铺。`,
      changes: { grids: Math.max(4, grids - 2), upper, lower },
      action: { type: "reconfigure" } });
  }

  // 5) 区间内零成交
  if (cycles === 0 && lo >= lower && hi <= upper && suggestions.length === 0) {
    F("info", "价格在区间内但未触发任何成交", "当日波动小于单格间距。");
    const newLower = roundPx(lo * 0.995);
    const newUpper = roundPx(hi * 1.005);
    if (newUpper > newLower) {
      suggestions.push({ id: nextId(), kind: "reconfigure", urgency: "info",
        title: "收窄区间贴合近期波动",
        reason: "收窄后更容易触发成交；注意格距变小后费用占比会上升。执行会撤单重铺。",
        changes: { lower: newLower, upper: newUpper, grids },
        action: { type: "reconfigure" } });
    }
  }

  // 6) 表现良好
  if (dayPnl > 0 && cycles >= 3) {
    F("ok", "网格运转良好", "买卖循环正常，当日为正贡献，无需调整。");
    suggestions.push({ id: nextId(), kind: "keep", urgency: "ok",
      title: "维持现状", reason: "策略表现正常，建议保持参数不动。",
      changes: {}, action: { type: "none" } });
  }

  if (suggestions.length === 0) {
    suggestions.push({ id: nextId(), kind: "keep", urgency: "ok",
      title: "维持现状", reason: "未发现需要调整的信号，继续观察。",
      changes: {}, action: { type: "none" } });
  }
  return { findings, suggestions: suggestions.slice(0, 3) };
}
