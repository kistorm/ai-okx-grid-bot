"""每日复盘：数据采集(DailyTracker) + 规则化分析与调整建议(build_review)。

设计原则（不可违背）：
- 建议由确定性规则计算，绝不自动执行——任何调整都必须由用户在界面上二次确认后生效
- 数据逐 tick 采样，按本地自然日切分；跨日时固化昨日记录，供生成正式复盘
- 历史数据原子落盘 state/review_history.json，重启不丢
"""
import json
import logging
import os
import time

log = logging.getLogger("review")

MAX_DAYS = 30      # 明细记录保留天数
MAX_REVIEWS = 60   # 复盘报告保留份数


def round_px(px: float) -> float:
    """按价格量级选择展示精度。"""
    if px >= 1000:
        return round(px, 1)
    if px >= 1:
        return round(px, 2)
    return round(px, 6)


class DailyTracker:
    """逐 tick 采集当日交易与行情数据，按自然日切分并落盘。"""

    def __init__(self, history_path: str, now_fn=None):
        self.history_path = history_path
        self._now_fn = now_fn or (lambda fmt: time.strftime(fmt))
        self.days = {}      # date -> 当日记录（今日记录也存这里，active=True）
        self.reviews = {}   # date -> 复盘报告（同日重新生成则覆盖）
        self._load()

    def _load(self):
        if not os.path.exists(self.history_path):
            return
        try:
            with open(self.history_path, encoding="utf-8") as f:
                data = json.load(f)
            self.days = data.get("days", {})
            self.reviews = data.get("reviews", {})
            # 今日已有记录会被 update() 继续累计，重启不丢当日数据
        except Exception as e:
            log.warning("复盘历史文件读取失败，将重新开始: %s", e)
            self.days = {}
            self.reviews = {}

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.history_path) or ".", exist_ok=True)
            tmp = self.history_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"days": self.days, "reviews": self.reviews},
                          f, ensure_ascii=False)
            os.replace(tmp, self.history_path)
        except Exception as e:
            log.error("复盘数据保存失败: %s", e)

    def _today_str(self) -> str:
        return self._now_fn("%Y-%m-%d")

    def update(self, *, inst_id, px, equity, cycles, realized, fees,
               buy_fills, sell_fills, open_buys, open_sells, committed,
               halted, paused):
        """喂入一次采样。跨自然日时返回昨日记录（调用方据此生成正式复盘）。"""
        today = self._today_str()
        rollover = None
        rec = self.days.get(today)
        if rec is None:
            rec = {
                "date": today, "inst_id": inst_id, "active": True,
                "start_px": px, "end_px": px, "px_high": px, "px_low": px,
                "start_equity": equity, "end_equity": equity,
                "cycles_start": cycles, "cycles_end": cycles,
                "realized_start": realized, "realized_end": realized,
                "fees_start": fees, "fees_end": fees,
                "buy_fills_start": buy_fills, "buy_fills_end": buy_fills,
                "sell_fills_start": sell_fills, "sell_fills_end": sell_fills,
                "open_buys_end": open_buys, "open_sells_end": open_sells,
                "committed_end": committed,
                "ticks": 1, "paused_ticks": 0, "halted_seen": halted,
                "reconfigs": 0,
            }
            # 关闭此前仍标记为活跃的旧记录（断连跨日后重新出现的情况）
            for d, r in self.days.items():
                if d != today and r.get("active"):
                    r["active"] = False
                    if rollover is None or d > rollover["date"]:
                        rollover = r
        else:
            rollover = None
            # 重置检测：循环数只会单调递增，若回落说明网格被 reset/复盘重铺过，
            # 此时把当日各项基线重新锚定到当前值，保证日增量有意义
            if cycles < rec.get("cycles_start", cycles):
                rec["cycles_start"] = cycles
                rec["realized_start"] = realized
                rec["fees_start"] = fees
                rec["buy_fills_start"] = buy_fills
                rec["sell_fills_start"] = sell_fills
                rec["resets_seen"] = rec.get("resets_seen", 0) + 1
                log.info("检测到网格重置，当日复盘基线已重新锚定（第%d次）",
                         rec["resets_seen"])
            rec.update({
                "end_px": px, "end_equity": equity,
                "cycles_end": cycles, "realized_end": realized, "fees_end": fees,
                "buy_fills_end": buy_fills, "sell_fills_end": sell_fills,
                "open_buys_end": open_buys, "open_sells_end": open_sells,
                "committed_end": committed,
                "ticks": rec.get("ticks", 0) + 1,
            })
            rec["px_high"] = max(rec.get("px_high", px), px)
            rec["px_low"] = min(rec.get("px_low", px), px)
            if halted:
                rec["halted_seen"] = True
            if paused:
                rec["paused_ticks"] = rec.get("paused_ticks", 0) + 1
        self.days[today] = rec
        self._trim()
        self.save()
        return rollover

    def note_reconfig(self):
        """记录一次复盘驱动的参数重铺（计入当日）。"""
        rec = self.days.get(self._today_str())
        if rec:
            rec["reconfigs"] = rec.get("reconfigs", 0) + 1
            self.save()

    def add_review(self, date_str: str, review: dict, interim: bool) -> dict:
        stored = {"date": date_str,
                  "generated_at": self._now_fn("%H:%M:%S"),
                  "interim": interim,
                  "findings": review.get("findings", []),
                  "suggestions": review.get("suggestions", [])}
        self.reviews[date_str] = stored
        if len(self.reviews) > MAX_REVIEWS:
            for d in sorted(self.reviews)[:-MAX_REVIEWS]:
                self.reviews.pop(d, None)
        self.save()
        return stored

    def last_days(self, n: int = 7) -> list:
        out = []
        for d in sorted(self.days, reverse=True)[:n]:
            r = self.days[d]
            out.append({
                "date": d,
                "pnl": round(r.get("end_equity", 0) - r.get("start_equity", 0), 4),
                "cycles": r.get("cycles_end", 0) - r.get("cycles_start", 0),
                "realized": round(r.get("realized_end", 0) - r.get("realized_start", 0), 4),
                "fees": round(r.get("fees_end", 0) - r.get("fees_start", 0), 4),
            })
        return out

    def last_reviews(self, n: int = 7) -> list:
        return [self.reviews[d] for d in sorted(self.reviews, reverse=True)[:n]]

    def today_record(self) -> dict:
        return self.days.get(self._today_str())

    def _trim(self):
        if len(self.days) > MAX_DAYS:
            for d in sorted(self.days)[:-MAX_DAYS]:
                self.days.pop(d, None)


def build_review(rec: dict, cfg: dict) -> dict:
    """规则化分析。rec 为当日记录，cfg 为当前网格参数与持仓概况。

    返回 {findings: [{level,title,detail}], suggestions: [{id,kind,urgency,title,
    reason,changes,action}]}。urgency: ok/info/warn/risk。
    """
    findings, suggestions = [], []

    def F(level, title, detail):
        findings.append({"level": level, "title": title, "detail": detail})

    if not rec or rec.get("ticks", 0) == 0:
        F("info", "今日无运行数据", "机器人未连接，或当日没有产生任何采样。")
        suggestions.append({
            "id": "S1", "kind": "keep", "urgency": "ok",
            "title": "维持现状", "reason": "暂无数据可供分析，先连接并运行一段时间。",
            "changes": {}, "action": {"type": "none"},
        })
        return {"findings": findings, "suggestions": suggestions}

    day_pnl = rec.get("end_equity", 0) - rec.get("start_equity", 0)
    day_realized = rec.get("realized_end", 0) - rec.get("realized_start", 0)
    day_fees = rec.get("fees_end", 0) - rec.get("fees_start", 0)
    cycles = rec.get("cycles_end", 0) - rec.get("cycles_start", 0)
    hi, lo = rec.get("px_high", 0), rec.get("px_low", 0)
    end_px = rec.get("end_px", 0)
    upper, lower = cfg.get("upper", 0), cfg.get("lower", 0)
    grids, budget = cfg.get("grids", 0), cfg.get("budget", 1)
    spread_ratio = (upper - lower) / lower if lower else 0
    inv_ratio = min(cfg.get("committed", 0) / budget, 1.0) if budget else 0

    F("info", "当日概览",
      f"完成 {cycles} 个买卖循环，已实现盈亏 {round(day_realized, 4)} USDT，"
      f"手续费 {round(day_fees, 4)} USDT，账户变动 {round(day_pnl, 4)} USDT；"
      f"价格区间 {round_px(lo)} ~ {round_px(hi)}。")

    sid = iter(f"S{i}" for i in range(1, 10))

    # 1) 断路器已触发 —— 最高优先级
    if rec.get("halted_seen"):
        F("risk", "触发了下跌断路器",
          "价格跌破网格下沿并已按设定清仓/停机。继续沿用原区间会立即再次触发。")
        new_lower = round_px(min(lo * 0.98, lower * 0.92))
        new_upper = round_px(new_lower * (1 + spread_ratio))
        suggestions.append({
            "id": next(sid), "kind": "reconfigure", "urgency": "risk",
            "title": "整体下移网格区间并重新铺网",
            "reason": "下移后保持格距不变，避免在当前价位立即再次触发断路器；"
                      "执行会撤销现有挂单并按新区间重新下单。",
            "changes": {"lower": new_lower, "upper": new_upper, "grids": grids},
            "action": {"type": "reconfigure"},
        })
        suggestions.append({
            "id": next(sid), "kind": "pause", "urgency": "warn",
            "title": "先暂停，人工观察后再定",
            "reason": "不确定后续走势时，暂停不会新增操作（已有挂单保留），观察后再决定。",
            "changes": {}, "action": {"type": "pause"},
        })
        return {"findings": findings, "suggestions": suggestions[:3]}

    # 2) 价格全程高于上沿 —— 空转
    if lo > upper:
        F("warn", "价格全程高于网格上沿", "当日没有买入成交，机器人基本空转。")
        new_upper = round_px(hi * 1.005)
        new_lower = round_px(new_upper / (1 + spread_ratio))
        suggestions.append({
            "id": next(sid), "kind": "reconfigure", "urgency": "warn",
            "title": "上移网格区间",
            "reason": "把区间上移到近期价格带内，恢复低买高卖能力；执行会撤单重铺。",
            "changes": {"lower": new_lower, "upper": new_upper, "grids": grids},
            "action": {"type": "reconfigure"},
        })

    # 3) 库存过重（下跌中买入远多于卖出）
    mid = (upper + lower) / 2
    if inv_ratio > 0.6 and end_px < mid:
        F("warn", "底部库存占比偏高",
          f"网格预算的 {round(inv_ratio * 100)}% 已变成持币，说明下跌中买入多于卖出，"
          "若继续下跌会进一步放大浮亏。")
        if rec.get("paused_ticks", 0) < rec.get("ticks", 1) / 2:
            suggestions.append({
                "id": next(sid), "kind": "pause", "urgency": "warn",
                "title": "暂停网格，控制继续沉底",
                "reason": "暂停后不再新铺买单（已有挂单保留），等待你判断后再继续。",
                "changes": {}, "action": {"type": "pause"},
            })

    # 4) 手续费侵蚀
    if cycles >= 3 and day_fees > 0 and day_realized >= 0 \
            and day_fees > day_realized * 0.6:
        F("warn", "手续费侵蚀明显",
          f"费用 {round(day_fees, 4)} USDT 相对已实现盈亏 {round(day_realized, 4)} USDT 占比过高，"
          "格距太密时常见。")
        suggestions.append({
            "id": next(sid), "kind": "reconfigure", "urgency": "info",
            "title": "减少格数、拉大单格间距",
            "reason": f"格数 {grids} → {max(4, grids - 2)}，单格利润变厚，费用占比下降；"
                      "执行会撤单重铺。",
            "changes": {"grids": max(4, grids - 2), "upper": upper, "lower": lower},
            "action": {"type": "reconfigure"},
        })

    # 5) 区间内零成交（波动太小）
    if cycles == 0 and lo >= lower and hi <= upper and not suggestions:
        F("info", "价格在区间内但未触发任何成交", "当日波动小于单格间距。")
        new_lower = round_px(lo * 0.995)
        new_upper = round_px(hi * 1.005)
        if new_upper > new_lower:
            suggestions.append({
                "id": next(sid), "kind": "reconfigure", "urgency": "info",
                "title": "收窄区间贴合近期波动",
                "reason": "收窄后更容易触发成交；注意格距变小后费用占比会上升。"
                          "执行会撤单重铺。",
                "changes": {"lower": new_lower, "upper": new_upper, "grids": grids},
                "action": {"type": "reconfigure"},
            })

    # 6) 表现良好
    if day_pnl > 0 and cycles >= 3:
        F("ok", "网格运转良好", "买卖循环正常，当日为正贡献，无需调整。")
        suggestions.append({
            "id": next(sid), "kind": "keep", "urgency": "ok",
            "title": "维持现状", "reason": "策略表现正常，建议保持参数不动。",
            "changes": {}, "action": {"type": "none"},
        })

    if not suggestions:
        suggestions.append({
            "id": next(sid), "kind": "keep", "urgency": "ok",
            "title": "维持现状", "reason": "未发现需要调整的信号，继续观察。",
            "changes": {}, "action": {"type": "none"},
        })
    return {"findings": findings, "suggestions": suggestions[:3]}
