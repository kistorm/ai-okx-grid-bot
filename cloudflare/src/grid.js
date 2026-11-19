/** 现货网格策略引擎（Workers 版，从 Python 版 1:1 移植，含全部已知修复）。
 *
 * 原理：价格每跌一格买入一份，每涨一格卖出一份；内置下跌断路器。
 * 修复清单（相对早期版本的差异，均已包含）：
 *  - 预算核算含库存投入（invested_quote），不会用幻影预算下单
 *  - 卖单占位冲突逐档上移后价格重算，顶档外溢不覆盖已有单
 *  - 对账：终态确认即清；连续 5 轮查不到判死（容忍瞬时抖动/清理重启旧单）
 *  - 卖出数量扣除买入手续费（基础币计费）
 *  - 铺网失败/预算耗尽日志防刷屏
 */

export class GridConfigError extends Error {}

export function validateConfig(cfg) {
  // NaN 参与 0 < x < y 比较恒为 false，可一并拦住空值/非数字
  if (!(0 < cfg.lower && cfg.lower < cfg.upper)) {
    throw new GridConfigError("需要 0 < lower < upper（检查是否填了空值或非法数字）");
  }
  if (!(Number.isInteger(cfg.grids) && cfg.grids >= 2 && cfg.grids <= 50)) {
    throw new GridConfigError("grids 需为 2~50 的整数");
  }
  if (!(cfg.budget > 0)) throw new GridConfigError("budget 必须 > 0");
  if (!(cfg.breakdownBuffer >= 0 && cfg.breakdownBuffer <= 0.5)) {
    throw new GridConfigError("breakdownBuffer 需在 0~0.5 之间");
  }
  if (!["stop_loss", "hold"].includes(cfg.breakdownAction)) {
    throw new GridConfigError("breakdownAction 只能是 stop_loss / hold");
  }
}

function expectedLevels(cfg) {
  const out = [];
  for (let i = 0; i < cfg.grids; i++) {
    out.push(Number((cfg.lower + ((cfg.upper - cfg.lower) * i) / (cfg.grids - 1)).toFixed(8)));
  }
  return out;
}

function freshState(cfg) {
  return {
    levels: expectedLevels(cfg),
    buys: {},         // 档位索引 -> ord_id
    sells: {},        // 档位索引 -> ord_id
    seen: [],         // 已处理订单号（去重）
    miss: {},         // ord_id -> 连续查不到的轮数
    halted: false,
    halted_reason: "",
    cycles: 0,
    buy_fills: 0,
    sell_fills: 0,
    level_stats: {},
    reconfigs: 0,
    invested_quote: 0,   // 已成交未回收（库存+在途卖单）
    realized_pnl: 0,
    fees: 0,
    per_grid_quote: Number((cfg.budget / cfg.grids).toFixed(6)),
  };
}

function compatState(s) {
  s.miss ??= {};
  s.level_stats ??= {};
  s.invested_quote ??= 0;
  s.reconfigs ??= 0;
  s.buy_fills ??= s.cycles ?? 0;
  s.sell_fills ??= 0;
  return s;
}

export class GridEngine {
  /**
   * @param cfg 已校验的配置
   * @param broker 通道（async 接口）
   * @param savedState 持久化的历史状态（无则新开网格）
   * @param log (level, msg) => void
   */
  constructor(cfg, broker, savedState = null, log = () => {}) {
    validateConfig(cfg);
    this.cfg = cfg;
    this.broker = broker;
    this.log = log;
    this.lastPx = 0;
    this._seedFullLogged = false;
    this._seedFailLogged = false;
    if (savedState) {
      this.st = compatState(JSON.parse(JSON.stringify(savedState)));
      const expected = expectedLevels(cfg);
      const same = JSON.stringify(this.st.levels.map((x) => Number(x.toFixed(6)))) ===
                   JSON.stringify(expected.map((x) => Number(x.toFixed(6))));
      if (!same) {
        this.log("warning", `历史网格区间[${this.st.levels[0]} ~ ${this.st.levels[this.st.levels.length - 1]}]` +
          `与本次连接参数[${expected[0]} ~ ${expected[expected.length - 1]}]不一致，` +
          "将继续按历史区间运行；要使用新参数请点『重置网格』");
      }
      this.log("info", `恢复历史状态: 买单${Object.keys(this.st.buys).length}笔 ` +
        `卖单${Object.keys(this.st.sells).length}笔 周期${this.st.cycles} ` +
        `已实现盈亏${this.st.realized_pnl}`);
    } else {
      this.st = freshState(cfg);
      this.log("info", `初始化网格: ${cfg.instId} 共${cfg.grids}档 ` +
        `per_grid=${this.st.per_grid_quote} ` +
        `[${this.st.levels.map((l) => l.toFixed(1)).join(", ")}]`);
    }
  }

  _committed() {
    return this.st.per_grid_quote * Object.keys(this.st.buys).length + this.st.invested_quote;
  }

  _spacingRatio() {
    const lv = this.st.levels;
    return (lv[1] - lv[0]) / lv[0];
  }

  _findEntry(book, ordId) {
    for (const [k, v] of Object.entries(book)) if (v === ordId) return Number(k);
    return null;
  }

  async reset() {
    /** 撤单 + 清内存；不写持久化（保持干净起点，防止新引擎把旧参数当历史恢复）。 */
    this.log("info", "执行 reset: 撤销全部挂单并清空网格状态");
    try { await this.broker.cancelAll(); }
    catch (e) { this.log("error", `reset 撤单失败: ${e.message}`); }
    this.st = freshState(this.cfg);
  }

  _placeSellAfterBuy(i, sz) {
    const levels = this.st.levels;
    let j = i + 1;
    while (j in this.st.sells) j += 1;           // 占位冲突：逐档上移找空位
    const spacing = this._spacingRatio();
    const px = j < levels.length
      ? levels[j]                                 // j 确定后再取价，防止位移错档
      : levels[levels.length - 1] * (1 + (j - levels.length + 1) * spacing);
    return this.broker.placeLimit("sell", px, sz).then((oid) => {
      if (oid) this.st.sells[j] = oid;
      else this.log("warning", `第${i}档买入成交后挂卖失败，该笔持仓暂时无卖单托管(数量${sz.toFixed(8)})`);
    });
  }

  _placeBuyAtLevel(i) {
    if (i < 0 || i in this.st.buys) return Promise.resolve();
    const px = this.st.levels[i];
    return this.broker.placeLimit("buy", px, this.st.per_grid_quote / px).then((oid) => {
      if (oid) this.st.buys[i] = oid;
    });
  }

  async _seed(px) {
    const st = this.st;
    let budgetLeft = this.cfg.budget - this._committed();
    let hitFull = false;
    let placedThisTick = 0;               // 每轮最多新挂 2 单：共享出口 IP 下突发下单容易被限流
    for (let i = 0; i < st.levels.length; i++) {
      const lv = st.levels[i];
      if (i in st.buys || lv >= px) continue;
      if (budgetLeft < st.per_grid_quote - 1e-9) { hitFull = true; break; }
      if (placedThisTick >= 1) break;     // 剩余档位下一轮继续，渐进式铺满
      const oid = await this.broker.placeLimit("buy", lv, st.per_grid_quote / lv);
      if (oid) {
        st.buys[i] = oid;
        budgetLeft -= st.per_grid_quote;
        placedThisTick += 1;
        this._seedFullLogged = false;
        this._seedFailLogged = false;
        // 共享出口 IP 下连续下单会触发 OKX 突发限流，每单间隔 1.5 秒
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        // 失败档位跳过（下一轮重试），不中断其他档位的铺网
        if (!this._seedFailLogged) {
          this.log("warning", `第${i}档买单挂单失败（预算/余额不足），跳过该档稍后重试`);
          this._seedFailLogged = true;
        }
        continue;
      }
    }
    if (hitFull) {
      if (!this._seedFullLogged) {
        this.log("info", `网格预算已用完(已投入 ${this._committed().toFixed(2)}/${this.cfg.budget})，` +
          "空档等待卖出回收后再铺");
        this._seedFullLogged = true;
      }
    } else {
      this._seedFullLogged = false;
    }
  }

  async _breakdown(px) {
    const st = this.st;
    const lower = st.levels[0];
    this.log("warning", `断路器触发: 当前价 ${px.toFixed(2)} 跌破下沿 ${lower.toFixed(2)} 的 ` +
      `${(this.cfg.breakdownBuffer * 100).toFixed(1)}% 缓冲区`);
    await this.broker.cancelAll();
    st.buys = {};
    st.sells = {};
    if (this.cfg.breakdownAction === "stop_loss") {
      const base = (await this.broker.snapshot())[this.broker.baseCcy]?.avail ?? 0;
      if (base > 0) {
        this.log("warning", `断路器清仓: 市价卖出 ${base.toFixed(8)} ${this.broker.baseCcy}，回到 USDT 停机`);
        await this.broker.placeMarket("sell", base);
      } else {
        this.log("info", "无持仓可清，直接停机");
      }
    } else {
      this.log("warning", "hold 模式: 撤单停机，保留已买入的币");
    }
    st.halted = true;
    st.halted_reason = `price ${px.toFixed(2)} broke below lower ${lower.toFixed(2)}`;
  }

  async tick() {
    /** 执行一轮：断路器检查 -> 处理成交 -> 对账 -> 补网。 */
    const st = this.st;
    if (st.halted) return;
    const px = await this.broker.price();
    this.lastPx = px;

    if (px < st.levels[0] * (1 - this.cfg.breakdownBuffer)) {
      await this._breakdown(px);
      return;
    }

    // 1) 处理新成交
    const seen = new Set(st.seen);
    const fills = await this.broker.fills(seen);
    for (const f of fills) {
      st.fees += Math.abs(f.fee ?? 0);
      if (f.side === "buy") {
        const i = this._findEntry(st.buys, f.ord_id);
        if (i === null) {
          this.log("warning", `买入成交 ${f.ord_id} 找不到档位（重启前旧单），忽略`);
          continue;
        }
        delete st.buys[i];
        // OKX 现货买入手续费从收到的基础币中扣除（fee 为负），卖出数量需扣除
        const feeVal = f.fee ?? 0;
        const szSell = feeVal < 0 ? f.sz + feeVal : f.sz;
        await this._placeSellAfterBuy(i, szSell);
        st.cycles += 1;
        st.buy_fills += 1;
        st.invested_quote += st.per_grid_quote;
        (st.level_stats[String(i)] ??= { buy: 0, sell: 0 }).buy += 1;
        this.log("info", `网格: 第${i}档买入成交(${f.px.toFixed(2)}) -> 已在第` +
          `${Math.min(i + 1, st.levels.length - 1)}档挂卖出`);
      } else {
        const j = this._findEntry(st.sells, f.ord_id);
        if (j === null) {
          this.log("warning", `卖出成交 ${f.ord_id} 找不到档位，忽略`);
          continue;
        }
        delete st.sells[j];
        if (j >= 1) {
          const buyPx = st.levels[j - 1];
          st.realized_pnl += (f.px - buyPx) * f.sz - Math.abs(f.fee ?? 0);
        }
        await this._placeBuyAtLevel(j - 1);
        st.sell_fills += 1;
        st.invested_quote = Math.max(0, st.invested_quote - st.per_grid_quote);
        (st.level_stats[String(j)] ??= { buy: 0, sell: 0 }).sell += 1;
        this.log("info", `网格: 第${j}档卖出成交(${f.px.toFixed(2)}) -> 已在第${Math.max(j - 1, 0)}档重新挂买`);
      }
    }

    // 2) 对账：终态确认即清；连续 5 轮查不到判死；无引用的 miss 计数清理
    const pending = await this.broker.pending();
    const pendingIds = new Set(pending.map((o) => o.ord_id));
    for (const book of ["buys", "sells"]) {
      for (const [k, oid] of Object.entries(st[book])) {
        if (pendingIds.has(oid)) {
          delete st.miss[oid];
        } else if (seen.has(oid)) {
          delete st[book][k];
          delete st.miss[oid];
          this.log("info", `对账: ${book === "buys" ? "买" : "卖"}单档位${k}的挂单 ${oid} 已有终态，清除记录`);
        } else {
          const n = (st.miss[oid] ?? 0) + 1;
          st.miss[oid] = n;
          if (n >= 5) {
            delete st[book][k];
            delete st.miss[oid];
            this.log("warning", `对账: 挂单 ${oid} 连续${n}轮查不到（多为重启前的旧模拟单），清除记录`);
          }
        }
      }
    }
    const liveOids = new Set([...Object.values(st.buys), ...Object.values(st.sells)]);
    for (const oid of Object.keys(st.miss)) {
      if (!liveOids.has(oid)) delete st.miss[oid];
    }

    // 3) 补网
    await this._seed(px);

    const seenArr = [...seen];
    st.seen = seenArr.length > 2000 ? seenArr.slice(-2000) : seenArr;
  }

  summary() {
    const st = this.st;
    const snap = this.broker.snapshot();
    const estTotal = this.lastPx > 0
      ? (snap[this.broker.quoteCcy]?.total ?? 0) + (snap[this.broker.baseCcy]?.total ?? 0) * this.lastPx
      : (snap[this.broker.quoteCcy]?.avail ?? 0);
    return {
      px: this.lastPx,
      open_buys: Object.keys(st.buys).length,
      open_sells: Object.keys(st.sells).length,
      cycles: st.cycles,
      buy_fills: st.buy_fills,
      sell_fills: st.sell_fills,
      realized_pnl: Number(st.realized_pnl.toFixed(4)),
      fees: Number(st.fees.toFixed(4)),
      est_total: Number(estTotal.toFixed(4)),
      halted: st.halted,
      balances: Object.fromEntries(Object.entries(snap).map(([c, v]) => [c, v.avail])),
    };
  }
}
