/** GridDO：网格引擎在 Workers 上的宿主。
 *
 * 一个 DO 实例托管一个网格机器人：
 *  - 引擎状态/纸面钱包/复盘数据持久化在 DO storage，休眠后自动恢复
 *  - Alarms 驱动周期性 tick（断网/重启后由 cron 兜底重新拉起）
 *  - 事件环形缓冲供前端轮询
 * DO 实例内单线程串行处理（input gates），无需 Python 版的锁机制。
 */
import { GridEngine, validateConfig } from "./grid.js";
import { DailyTracker, buildReview, shanghaiTime } from "./review.js";
import { makeBroker } from "./brokers.js";
import { createOkxClient } from "./okx.js";

const MODE_LABELS = { dry: "纸面模拟", offline: "离线演示", demo: "欧易模拟盘", live: "实盘" };
const NEED_KEYS = ["demo", "live"];
const EVENTS_CAP = 300;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

export class GridDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.loaded = false;
    this.config = null;      // {mode, instId, upper, lower, grids, budget, breakdownBuffer, breakdownAction, intervalSec, paperUsdt}
    this.stopped = true;     // true = 引擎未连接（不 tick）
    this.paused = false;
    this.engine = null;
    this.broker = null;
    this.events = [];
    this.evSeq = 0;
    this.lastSummary = {};
    this.tracker = new DailyTracker();
    this.pendingReconfig = null;
    this.pendingReset = false;
  }

  async init() {
    if (this.loaded) return;
    const saved = await this.state.storage.get(["config", "stopped", "paused",
      "events", "review", "engineState", "brokerState", "pendingReconfig", "pendingReset"]);
    this.config = saved.get("config") ?? null;
    this.stopped = saved.get("stopped") ?? true;
    this.paused = saved.get("paused") ?? false;
    this.events = saved.get("events") ?? [];
    this.evSeq = this.events.length ? this.events[this.events.length - 1].seq : 0;
    this.tracker.load(saved.get("review") ?? { days: {}, reviews: {} });
    this.pendingReconfig = saved.get("pendingReconfig") ?? null;
    this.pendingReset = saved.get("pendingReset") ?? false;
    this._savedEngineState = saved.get("engineState") ?? null;
    this._savedBrokerState = saved.get("brokerState") ?? null;
    this.loaded = true;
    // 引擎构建失败可重试（如 OKX WAF 间歇拦截 instruments 拉取），不阻塞 alarm 链
    await this._ensureEngine();
  }

  async _ensureEngine() {
    if (this.engine) return;
    try {
      await this._buildEngine(this._savedBrokerState, this._savedEngineState);
      this._buildError = null;
    } catch (e) {
      this._buildError = String(e.message || e);
      this.log("warning", "web", `引擎启动失败（稍后自动重试）: ${this._buildError}`);
    }
  }

  log(level, src, msg) {
    this.evSeq += 1;
    this.events.push({ seq: this.evSeq, ts: shanghaiTime(), level, src, msg });
    if (this.events.length > EVENTS_CAP) {
      this.events.splice(0, this.events.length - EVENTS_CAP);
    }
  }

  async _buildEngine(brokerState, engineState) {
    this.broker = await makeBroker(this.config, this.env, brokerState,
      (level, msg) => this.log(level, "broker", msg));
    this.engine = new GridEngine(this.config, this.broker, engineState,
      (level, msg) => this.log(level, "grid", msg));
  }

  async _persist() {
    await this.state.storage.put({
      config: this.config,
      stopped: this.stopped,
      paused: this.paused,
      engineState: this.engine?.st ?? null,
      brokerState: this.broker?.serialize ? this.broker.serialize() : null,
      events: this.events,
      review: this.tracker.export(),
      pendingReconfig: this.pendingReconfig,
      pendingReset: this.pendingReset,
    });
  }

  async _ensureAlarm() {
    if (this.stopped || !this.config) return;
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + 500);
    }
  }

  /** runtime alarm：一轮采样/tick，然后排下一次。任何失败都不中断排期（自愈）。 */
  async alarm() {
    try { await this.init(); }
    catch (e) { this.log("error", "web", `初始化失败（下一轮重试）: ${e.message}`); }
    if (!this.config || this.stopped) return;
    try {
      await this._ensureEngine();
      if (this._buildError) {
        // 引擎构建失败（多为 WAF 拦截），拉长间隔重试
        this.log("warning", "web", "引擎尚未启动，等待下一轮重试");
        await this.state.storage.setAlarm(Date.now() + Math.max(30000, this.config.intervalSec * 1000));
        return;
      }
      if (this.pendingReconfig) {
        await this._doReconfig();
      } else if (this.pendingReset) {
        this.pendingReset = false;
        await this.engine.reset();
      } else if (!this.paused && !this.engine.st.halted) {
        await this.engine.tick();
      } else {
        // 暂停/停机时也采样，保证复盘数据完整
        this.engine.lastPx = await this.broker.price();
      }
      const s = this.engine.summary();
      this.lastSummary = s;
      this._trackerUpdate(s, this.paused, this.engine.st.halted);
    } catch (e) {
      this.log("error", "web", `引擎 tick 异常: ${e.message}`);
    }
    try { await this._persist(); }
    catch (e) { this.log("error", "web", `状态保存失败: ${e.message}`); }
    if (!this.stopped) {
      try {
        await this.state.storage.setAlarm(Date.now() + this.config.intervalSec * 1000);
      } catch (e) {
        this.log("error", "web", `alarm 排期失败: ${e.message}`);
        try { await this.state.storage.setAlarm(Date.now() + 30000); } catch { /* 忽略 */ }
      }
    }
  }

  _gridInfo(eng) {
    const st = eng.st;
    return { inst: eng.cfg.instId,
      lower: st.levels[0], upper: st.levels[st.levels.length - 1],
      grids: st.levels.length, per_grid: st.per_grid_quote,
      committed: Number((st.per_grid_quote * Object.keys(st.buys).length + (st.invested_quote ?? 0)).toFixed(4)),
      open_buys: Object.keys(st.buys).length, open_sells: Object.keys(st.sells).length };
  }

  _cfgInfo(eng, s) {
    const c = eng.cfg;
    const info = { inst: c.instId, upper: c.upper, lower: c.lower, grids: c.grids,
      budget: c.budget, breakdown_action: c.breakdownAction };
    if (s) {
      Object.assign(info, this._gridInfo(eng));
      const bal = s.balances ?? {};
      info.base_value = Number((bal[eng.broker.baseCcy] ?? 0) * (s.px ?? 0)).toFixed(4);
    }
    return info;
  }

  _trackerUpdate(s, paused, halted) {
    const rollover = this.tracker.update({
      instId: this.engine.cfg.instId,
      px: s.px ?? 0, equity: s.est_total ?? 0,
      cycles: s.cycles ?? 0, realized: s.realized_pnl ?? 0, fees: s.fees ?? 0,
      buyFills: s.buy_fills ?? 0, sellFills: s.sell_fills ?? 0,
      openBuys: s.open_buys ?? 0, openSells: s.open_sells ?? 0,
      committed: this._gridInfo(this.engine).committed,
      halted, paused,
    });
    if (rollover) {
      const review = buildReview(rollover, this._cfgInfo(this.engine, s));
      this.tracker.addReview(rollover.date, review, false);
      const dayPnl = (rollover.end_equity ?? 0) - (rollover.start_equity ?? 0);
      const dayCycles = (rollover.cycles_end ?? 0) - (rollover.cycles_start ?? 0);
      this.log("info", "web", `📋 已生成 ${rollover.date} 每日复盘: 循环 ${dayCycles} 个, ` +
        `账户变动 ${dayPnl.toFixed(4)} USDT —— 打开『每日复盘』查看`);
    }
  }

  /** 开机自启：部署后由 cron 首次触发，按 AUTO_MODE 环境变量自动连接。 */
  async _autoConnect() {
    if (this.config && !this.stopped) return { ok: true, message: "已在运行" };
    const mode = this.env.AUTO_MODE ?? "";
    if (!mode) return { ok: false, error: "未设置 AUTO_MODE" };
    if (!MODE_LABELS[mode]) return { ok: false, error: `AUTO_MODE=${mode} 无效` };
    if (NEED_KEYS.includes(mode) &&
        !(this.env.OKX_API_KEY && this.env.OKX_API_SECRET && this.env.OKX_API_PASSPHRASE)) {
      this.log("warning", "web", `AUTO_MODE=${mode} 但缺少 OKX secrets，跳过自动连接`);
      return { ok: false, error: `AUTO_MODE=${mode} 但缺少 OKX secrets` };
    }
    const r = await this.apiConnect({
      mode,
      inst_id: this.env.AUTO_INST ?? "BTC-USDT",
      upper: Number(this.env.AUTO_UPPER ?? 70000),
      lower: Number(this.env.AUTO_LOWER ?? 58000),
      grids: Number(this.env.AUTO_GRIDS ?? 8),
      budget: Number(this.env.AUTO_BUDGET ?? 12),
      interval: Number(this.env.AUTO_INTERVAL ?? 30),
      breakdown_action: this.env.AUTO_BREAKDOWN_ACTION ?? "stop_loss",
      paper_usdt: Number(this.env.AUTO_PAPER_USDT ?? 14),
    });
    if (r.ok) {
      this.paused = false;
      await this._persist();
      await this.state.storage.setAlarm(Date.now() + 500);
    }
    return r;
  }

  async _doReconfig() {
    const cfg = this.pendingReconfig;
    this.pendingReconfig = null;
    this.log("info", "web", `执行复盘确认的调整: 撤销全部挂单, 新区间 [${cfg.lower} ~ ${cfg.upper}] ${cfg.grids}格`);
    try { await this.engine.reset(); }
    catch (e) { this.log("error", "web", `reconfig 撤单失败: ${e.message}`); }
    this.engine = new GridEngine(cfg, this.broker, null,
      (level, msg) => this.log(level, "grid", msg));
    this.tracker.noteReconfig();
  }

  // ---------- API ----------
  async apiConnect(body) {
    const mode = body.mode ?? "";
    if (!MODE_LABELS[mode]) return { ok: false, error: `未知模式 ${mode}` };
    if (NEED_KEYS.includes(mode) &&
        !(this.env.OKX_API_KEY && this.env.OKX_API_SECRET && this.env.OKX_API_PASSPHRASE)) {
      return { ok: false, error: "该模式需要先配置 OKX_API_KEY/SECRET/PASSPHRASE secrets " +
        "（npx wrangler secret put OKX_API_KEY 等）" };
    }
    const cfg = {
      mode,
      instId: String(body.inst_id ?? "BTC-USDT").trim(),
      upper: Number(body.upper ?? 70000),
      lower: Number(body.lower ?? 58000),
      grids: Math.round(Number(body.grids ?? 8)),
      budget: Number(body.budget ?? 12),
      breakdownBuffer: Number(body.breakdown_buffer ?? 0.02),
      breakdownAction: body.breakdown_action ?? "stop_loss",
      intervalSec: clamp(Math.round(Number(body.interval ?? 30) || 30), 3, 300),
      paperUsdt: Number(body.paper_usdt ?? 14),
    };
    if (mode === "offline") cfg.intervalSec = Math.min(cfg.intervalSec, 5);
    // 清理交易所上可能残留的孤儿挂单（模式切换/实例重建后，旧通道的挂单不再被管理）
    if (this.env.OKX_API_KEY && this.env.OKX_API_SECRET && this.env.OKX_API_PASSPHRASE) {
      try {
        const cleanup = createOkxClient({
          apiKey: this.env.OKX_API_KEY, secretKey: this.env.OKX_API_SECRET,
          passphrase: this.env.OKX_API_PASSPHRASE, simulated: mode === "demo",
          log: (l, m) => this.log(l, "broker", m),
        });
        let n = 0;
        for (const o of await cleanup.pendingOrders(cfg.instId)) {
          try { await cleanup.cancelOrder(cfg.instId, o.ordId); n += 1; } catch { /* 忽略单笔失败 */ }
        }
        if (n > 0) this.log("info", "web", `已清理交易所残留挂单 ${n} 笔`);
      } catch (e) {
        this.log("warning", "web", `残留挂单清理失败（不阻断连接）: ${e.message}`);
      }
    }
    let engineState = null, brokerState = null;
    if (!body.fresh) {
      // 默认恢复历史状态；传 fresh=true 则忽略旧状态全新开始（如行情异常污染后）
      try {
        engineState = (await this.state.storage.get("engineState")) ?? null;
        brokerState = (await this.state.storage.get("brokerState")) ?? null;
      } catch { /* 忽略 */ }
    }
    // 校验 + 构建引擎（可能抛 GridConfigError）
    const log = (level, msg) => this.log(level, "broker", msg);
    let engine;
    try {
      const broker = await makeBroker(cfg, this.env, brokerState, log);
      engine = new GridEngine(cfg, broker, engineState, (level, msg) => this.log(level, "grid", msg));
    } catch (e) {
      return { ok: false, error: `连接失败: ${e.message}` };
    }
    // live 零余额警告
    if (mode === "demo" || mode === "live") {
      const bal = engine.broker.balances();
      if ((bal[engine.broker.quoteCcy] ?? 0) <= 0) {
        this.log("warning", "web", `${engine.broker.quoteCcy} 可用为 0：请确认资金已划转到「交易账户」`);
      }
    }
    const resumed = engineState !== null;
    this.config = cfg;
    this.stopped = false;
    this.paused = false;
    this.engine = engine;
    this.broker = engine.broker;
    this.lastSummary = {};
    await this._persist();
    await this.state.storage.setAlarm(Date.now() + 500);
    this.log("info", "web", `已连接: ${MODE_LABELS[mode]} ${cfg.instId}` +
      (resumed ? "，恢复历史网格状态" : "，新开网格"));
    return { ok: true, mode, resumed };
  }

  async apiDisconnect() {
    if (!this.config) return { ok: false, error: "未连接" };
    try { await this.engine?.broker?.cancelAll(); } catch { /* 忽略 */ }
    this.stopped = true;
    await this.state.storage.deleteAlarm();
    await this._persist();
    this.log("info", "web", "已断开连接（交易所挂单保留，状态已落盘）");
    return { ok: true };
  }

  apiPause(body) {
    this.paused = !!body.paused;
    this.log("info", "web", `用户${this.paused ? "暂停" : "继续"}引擎（已有挂单保留在交易所）`);
    return { ok: true, paused: this.paused };
  }

  async apiReset() {
    if (!this.config || this.stopped) return { ok: false, error: "未连接" };
    this.pendingReset = true;
    this.log("info", "web", "请求重置: 将撤销全部挂单并清空网格状态后重新铺网");
    return { ok: true };
  }

  apiReview() {
    const eng = this.engine;
    const cfgInfo = eng && this.config ? this._cfgInfo(eng, this.lastSummary) : null;
    return { connected: !!this.config && !this.stopped, paused: this.paused,
      today: this.tracker.todayRecord(), days: this.tracker.lastDays(7),
      reviews: this.tracker.lastReviews(7), cfg: cfgInfo };
  }

  async apiGenerateReview() {
    if (!this.config || !this.engine) {
      return { ok: false, error: "未连接或引擎未初始化，没有可分析的数据" };
    }
    this.engine.lastPx = await this.broker.price();
    const s = this.engine.summary();
    this._trackerUpdate(s, this.paused, this.engine.st.halted);
    const rec = this.tracker.todayRecord();
    if (!rec || (rec.ticks ?? 0) === 0) {
      return { ok: false, error: "今日暂无采样数据" };
    }
    const review = buildReview(rec, this._cfgInfo(this.engine, s));
    const stored = this.tracker.addReview(rec.date, review, true);
    return { ok: true, review: stored };
  }

  async apiApplySuggestion(body) {
    const dateStr = String(body.date ?? "");
    const sid = String(body.suggestion_id ?? "");
    const review = this.tracker.reviews[dateStr];
    if (!review) return { ok: false, error: "复盘报告不存在或已过期，请重新生成后再试" };
    const sug = (review.suggestions ?? []).find((x) => x.id === sid);
    if (!sug) return { ok: false, error: "建议项不存在（复盘可能已重新生成）" };
    const act = sug.action?.type;
    if (act === "pause") {
      if (!this.config || this.stopped) return { ok: false, error: "未连接，无需暂停" };
      this.paused = true;
      this.log("info", "web", "用户暂停引擎（已有挂单保留在交易所）");
      return { ok: true, message: "已暂停引擎（已有挂单保留），可随时点『继续』恢复" };
    }
    if (act !== "reconfigure") return { ok: true, message: "该建议无需执行操作" };
    if (!this.config || this.stopped) return { ok: false, error: "未连接，无法调整参数" };
    const ch = sug.changes ?? {};
    const cur = this.engine.cfg;
    const cfg = {
      mode: cur.mode, instId: cur.instId,
      upper: Number(ch.upper ?? cur.upper),
      lower: Number(ch.lower ?? cur.lower),
      grids: Math.round(Number(ch.grids ?? cur.grids)),
      budget: Number(ch.budget ?? cur.budget),
      breakdownBuffer: cur.breakdownBuffer,
      breakdownAction: ch.breakdown_action ?? cur.breakdownAction,
      intervalSec: cur.intervalSec, paperUsdt: cur.paperUsdt,
    };
    try {
      validateConfig(cfg);
    } catch (e) {
      return { ok: false, error: `建议参数未通过校验: ${e.message}` };
    }
    this.pendingReconfig = cfg;
    this.log("info", "web", `已受理复盘调整建议 ${sid}: 区间 [${cfg.lower} ~ ${cfg.upper}] ${cfg.grids}格 —— 下一轮撤单重铺`);
    return { ok: true, message: "已受理：下一轮将撤销全部挂单并按新参数重新铺网" };
  }

  stateView() {
    const eng = this.engine;
    const s = {
      connected: !!this.config && !this.stopped,
      mode: this.config?.mode ?? null,
      mode_label: MODE_LABELS[this.config?.mode ?? ""] ?? "",
      paused: this.paused,
      market_error: "",
      summary: this.lastSummary ?? {},
      balances: (this.lastSummary ?? {}).balances ?? {},
      quote_ccy: this.broker?.quoteCcy ?? "USDT",
      base_ccy: this.broker?.baseCcy ?? "BTC",
      halted: false, halted_reason: "", grid: null, market: null,
    };
    if (eng && this.config && !this.stopped) {
      s.halted = eng.st.halted;
      s.halted_reason = eng.st.halted_reason;
      s.grid = this._gridInfo(eng);
      if (this.config.mode === "offline" && (this.lastSummary ?? {}).px) {
        s.market = [{ inst: eng.cfg.instId, last: this.lastSummary.px, chg: null }];
      }
    }
    return s;
  }

  async fetch(request) {
    await this.init();
    const url = new URL(request.url);
    const path = url.pathname;
    let body = {};
    if (request.method === "POST") {
      try { body = await request.json(); } catch { body = {}; }
    }
    try {
      switch (path) {
        case "/internal/ensure-alarm":
          await this._ensureAlarm();
          return json({ ok: true });
        case "/internal/auto-connect":
          return json(await this._autoConnect());
        case "/api/auto-connect":
          return json(await this._autoConnect());
        case "/api/state":
          return json(this.stateView());
        case "/api/events": {
          const after = Number(url.searchParams.get("after") ?? 0);
          return json({ events: this.events.filter((e) => e.seq > after), last: this.evSeq });
        }
        case "/api/review":
          return json(this.apiReview());
        case "/api/debug-balances": {
          // 临时诊断：对比交易账户与资金账户的 USDT
          try {
            if (!this.broker?.c) return json({ error: "当前通道无 OKX 客户端" });
            const trade = await this.broker.c.balance("USDT");
            let funding = null;
            try { funding = await this.broker.c.fundingBalances("USDT"); } catch (e) {
              funding = [{ ccy: "USDT", err: e.message }];
            }
            return json({ trade, funding });
          } catch (e) {
            return json({ error: e.message });
          }
        }
        case "/api/connect":
          return json(await this.apiConnect(body));
        case "/api/disconnect":
          return json(await this.apiDisconnect());
        case "/api/pause":
          return json(this.apiPause(body));
        case "/api/reset":
          return json(await this.apiReset());
        case "/api/review/generate":
          return json(await this.apiGenerateReview());
        case "/api/review/apply":
          return json(await this.apiApplySuggestion(body));
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      this.log("error", "web", `接口异常 ${path}: ${e.message}`);
      return json({ ok: false, error: e.message }, 500);
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
