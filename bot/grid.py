"""现货网格策略引擎。

原理：把价格区间 [lower, upper] 均分为 grids 档。
价格每跌入一格 → 该格挂买入；买入成交后 → 在上一格挂卖出（赚一格差价）。
卖出成交后 → 回到下一格重新挂买。如此低买高卖循环。

断路器：价格跌破下沿 (1 - breakdown_buffer) 时视为单边下跌趋势，
按 breakdown_action 处理后停机，避免无限接飞刀：
  stop_loss —— 撤单 + 市价清仓全部持仓回 USDT，停机
  hold      —— 仅撤单停机，保留已买入的币

状态落盘到 state/*.json，重启自动恢复；人工调整区间后用 --reset 重新开始。
"""
import json
import logging
import os
from dataclasses import dataclass

log = logging.getLogger("grid")


@dataclass
class GridConfig:
    inst_id: str = "BTC-USDT"
    upper: float = 70000.0      # 网格上沿
    lower: float = 58000.0      # 网格下沿
    grids: int = 8              # 格数（>=2）
    budget_quote: float = 12.0  # 网格总预算（报价币，如 USDT），留少量余量付手续费
    breakdown_buffer: float = 0.02   # 跌破下沿再 2% 触发断路器
    breakdown_action: str = "stop_loss"  # stop_loss / hold
    state_dir: str = "state"

    def validate(self):
        # NaN 参与 0 < x < y 比较恒为 False，可一并拦住空值/非数字
        if not (0 < self.lower < self.upper):
            raise ValueError("需要 0 < lower < upper（检查是否填了空值或非法数字）")
        if not (2 <= self.grids <= 50):
            raise ValueError("grids 需在 2~50 之间")
        if self.budget_quote <= 0:
            raise ValueError("budget_quote 必须 > 0")
        if not (0 <= self.breakdown_buffer <= 0.5):
            raise ValueError("breakdown_buffer 需在 0~0.5 之间")
        if self.breakdown_action not in ("stop_loss", "hold"):
            raise ValueError("breakdown_action 只能是 stop_loss / hold")


class GridEngine:
    def __init__(self, cfg: GridConfig, broker):
        cfg.validate()
        self.cfg = cfg
        self.broker = broker
        os.makedirs(cfg.state_dir, exist_ok=True)
        self.state_path = os.path.join(
            cfg.state_dir, f"grid_{cfg.inst_id.replace('-', '_')}.json")
        self.st = None
        self._loaded = False
        self.last_px = 0.0
        self._seed_full_logged = False  # 『预算已用完』只在状态变化时记录一次
        self._seed_fail_logged = False  # 『挂单失败』同样防刷屏

    # ---------- 状态管理 ----------
    def _expected_levels(self) -> list:
        return [round(self.cfg.lower +
                      (self.cfg.upper - self.cfg.lower) * i / (self.cfg.grids - 1), 8)
                for i in range(self.cfg.grids)]

    def _fresh_state(self) -> dict:
        return {
            "levels": self._expected_levels(),
            "buys": {},    # 档位索引 -> 挂单ord_id（该档的买入单）
            "sells": {},   # 档位索引 -> 挂单ord_id（该档的卖出单）
            "seen": [],    # 已处理过的订单号（去重，防重复响应）
            "halted": False,
            "halted_reason": "",
            "cycles": 0,          # 完成的买卖循环数
            "buy_fills": 0,       # 买入成交笔数（供复盘统计）
            "sell_fills": 0,      # 卖出成交笔数
            "level_stats": {},    # {"档位索引": {"buy": n, "sell": n}} 各档成交分布
            "reconfigs": 0,       # 通过复盘调整重铺的次数
            "invested_quote": 0.0,  # 已成交买入、尚未卖出回收的资金（库存+在途卖单）
            "realized_pnl": 0.0,  # 已实现盈亏(USDT, 近似)
            "fees": 0.0,          # 累计手续费(近似)
            "per_grid_quote": round(self.cfg.budget_quote / self.cfg.grids, 6),
        }

    def _load_or_init(self):
        if os.path.exists(self.state_path):
            with open(self.state_path, encoding="utf-8") as f:
                self.st = json.load(f)
            # 旧版本状态文件的兼容字段
            self.st.setdefault("buy_fills", self.st.get("cycles", 0))
            self.st.setdefault("sell_fills", 0)
            self.st.setdefault("level_stats", {})
            self.st.setdefault("reconfigs", 0)
            self.st.setdefault("invested_quote", 0.0)
            self.st.setdefault("miss", {})
            log.info("恢复历史状态: 买单%d笔 卖单%d笔 周期%d 已实现盈亏%.4f",
                     len(self.st["buys"]), len(self.st["sells"]),
                     self.st["cycles"], self.st["realized_pnl"])
            expected = self._expected_levels()
            if [round(x, 6) for x in self.st["levels"]] != [round(x, 6) for x in expected]:
                log.warning("历史网格区间[%.1f ~ %.1f]与本次连接参数[%.1f ~ %.1f]不一致，"
                            "将继续按历史区间运行；要使用新参数请点『重置网格』",
                            self.st["levels"][0], self.st["levels"][-1],
                            expected[0], expected[-1])
        else:
            self.st = self._fresh_state()
            log.info("初始化网格: %s 共%d档 per_grid=%.4f %s",
                     self.cfg.inst_id, self.cfg.grids, self.st["per_grid_quote"],
                     [round(l, 1) for l in self.st["levels"]])
        self._loaded = True

    def _save(self):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.st, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_path)

    def reset(self):
        """撤掉全部挂单并清空状态（人工调整区间后重新开始）。

        注意：不写状态文件——保持『干净起点』语义，否则紧接着创建的
        新引擎（复盘调整场景）会把这里写下的旧参数状态当作历史恢复。"""
        log.info("执行 reset: 撤销全部挂单并清空网格状态")
        try:
            self.broker.cancel_all()
        except Exception as e:
            log.error("reset 撤单失败: %s", e)
        if os.path.exists(self.state_path):
            os.remove(self.state_path)
        self.st = self._fresh_state()
        self._loaded = True

    # ---------- 内部工具 ----------
    def _find_entry(self, book: dict, ord_id: str):
        for k, v in book.items():
            if v == ord_id:
                return k
        return None

    def _committed_quote(self) -> float:
        """当前总占用 = 挂买单 + 已成交未回收（库存/在途卖单）。

        只统计挂买单会让『买入成交后』的资金看起来可用，实际它们已变成
        库存或冻结在在途卖单里——用幻影预算下单会被交易所拒单。"""
        return (self.st["per_grid_quote"] * len(self.st["buys"])
                + self.st.get("invested_quote", 0.0))

    def _spacing_ratio(self) -> float:
        lv = self.st["levels"]
        return (lv[1] - lv[0]) / lv[0]

    # ---------- 下单 ----------
    def _place_sell_after_buy(self, i: int, sz: float):
        """在第 i 档买入成交后，于上一档挂卖出。"""
        st = self.st
        levels = st["levels"]
        j = i + 1
        while j in st["sells"]:  # 占位冲突保护：逐档上移直到空位
            j += 1
        spacing = self._spacing_ratio()
        if j < len(levels):
            px = levels[j]  # 注意：必须在 j 确定之后再取价，否则位移后价位错档
        else:  # 超出顶档：按格距继续向上外溢
            px = levels[-1] * (1 + (j - len(levels) + 1) * spacing)
        oid = self.broker.place_limit("sell", px, sz)
        if oid:
            st["sells"][j] = oid
        else:
            log.warning("第%d档买入成交后挂卖失败，该笔持仓暂时无卖单托管(数量%.8f)", i, sz)

    def _place_buy_at_level(self, i: int):
        st = self.st
        if i < 0 or i in st["buys"]:
            return
        px = st["levels"][i]
        oid = self.broker.place_limit("buy", px, st["per_grid_quote"] / px)
        if oid:
            st["buys"][i] = oid

    def _seed(self, px: float):
        """确保每个『当前价之下』的空档都有买单（首次铺网 + 回收后补网）。"""
        st = self.st
        budget_left = self.cfg.budget_quote - self._committed_quote()
        hit_full = False
        for i, lv in enumerate(st["levels"]):
            if i in st["buys"] or lv >= px:
                continue
            if budget_left < st["per_grid_quote"] - 1e-9:
                hit_full = True
                break
            oid = self.broker.place_limit("buy", lv, st["per_grid_quote"] / lv)
            if oid:
                st["buys"][i] = oid
                budget_left -= st["per_grid_quote"]
                self._seed_full_logged = False
                self._seed_fail_logged = False
            else:
                if not self._seed_fail_logged:
                    log.warning("第%d档买单挂单失败（%s），本轮铺网中止，"
                                "条件恢复后自动重试", i, "预算/余额不足")
                    self._seed_fail_logged = True
                break
        if hit_full:
            if not self._seed_full_logged:
                log.info("网格预算已用完(已投入 %.2f/%.2f)，空档等待卖出回收后再铺",
                         self._committed_quote(), self.cfg.budget_quote)
                self._seed_full_logged = True
        else:
            self._seed_full_logged = False

    # ---------- 断路器 ----------
    def _breakdown(self, px: float):
        st = self.st
        lower = st["levels"][0]
        log.warning("断路器触发: 当前价 %.2f 跌破下沿 %.2f 的 %.1f%% 缓冲区",
                    px, lower, self.cfg.breakdown_buffer * 100)
        self.broker.cancel_all()
        st["buys"].clear()
        st["sells"].clear()
        if self.cfg.breakdown_action == "stop_loss":
            base = self.broker.balances().get(self.broker.base_ccy, 0.0)
            if base > 0:
                log.warning("断路器清仓: 市价卖出 %.8f %s，回到 USDT 停机",
                            base, self.broker.base_ccy)
                self.broker.place_market("sell", base)
            else:
                log.info("无持仓可清，直接停机")
        else:
            log.warning("hold 模式: 撤单停机，保留已买入的币")
        st["halted"] = True
        st["halted_reason"] = f"price {px:.2f} broke below lower {lower:.2f}"
        self._save()

    # ---------- 主循环 ----------
    def tick(self):
        """执行一轮：处理成交 -> 对账 -> 补网。"""
        if not self._loaded:
            self._load_or_init()
        st = self.st
        if st["halted"]:
            log.warning("已停机(%s)。调整区间后运行 --reset 可重新开始。", st["halted_reason"])
            return
        px = self.broker.price()
        self.last_px = px

        if px < st["levels"][0] * (1 - self.cfg.breakdown_buffer):
            self._breakdown(px)
            return

        # 1) 处理新成交
        seen = set(st["seen"])
        fills = self.broker.fills(seen)
        for f in fills:
            st["fees"] += abs(f.get("fee") or 0)
            if f["side"] == "buy":
                i = self._find_entry(st["buys"], f["ord_id"])
                if i is None:
                    log.warning("买入成交 %s 找不到档位（重启前旧单），忽略", f["ord_id"])
                    continue
                del st["buys"][i]
                # OKX 现货买入手续费从收到的基础币中扣除(fee为负)，卖出数量需扣除
                fee_val = f.get("fee") or 0
                sz_sell = f["sz"] + fee_val if fee_val < 0 else f["sz"]
                self._place_sell_after_buy(i, sz_sell)
                st["cycles"] += 1
                st["buy_fills"] += 1
                st["invested_quote"] = st.get("invested_quote", 0.0) + st["per_grid_quote"]
                st["level_stats"].setdefault(str(i), {"buy": 0, "sell": 0})["buy"] += 1
                log.info("网格: 第%d档买入成交(%.2f) -> 已在第%d档挂卖出",
                         i, f["px"], min(i + 1, len(st["levels"]) - 1))
            else:
                j = self._find_entry(st["sells"], f["ord_id"])
                if j is None:
                    log.warning("卖出成交 %s 找不到档位，忽略", f["ord_id"])
                    continue
                del st["sells"][j]
                if j >= 1:
                    buy_px = st["levels"][j - 1]
                    st["realized_pnl"] += (f["px"] - buy_px) * f["sz"] - abs(f.get("fee") or 0)
                self._place_buy_at_level(j - 1)
                st["sell_fills"] += 1
                st["invested_quote"] = max(0.0, st.get("invested_quote", 0.0) - st["per_grid_quote"])
                st["level_stats"].setdefault(str(j), {"buy": 0, "sell": 0})["sell"] += 1
                log.info("网格: 第%d档卖出成交(%.2f) -> 已在第%d档重新挂买",
                         j, f["px"], max(j - 1, 0))

        # 2) 对账：清理已消失的挂单记录。
        #    终态(成交/撤单)已确认 → 立即清除；查不到且无终态 → 连续 5 轮后判死
        #    （容忍下单延迟的瞬时抖动，同时清理模拟通道重启后丢失的旧挂单）
        pending_ids = {o["ord_id"] for o in self.broker.pending()}
        missing = st.setdefault("miss", {})
        for book in ("buys", "sells"):
            for k, oid in list(st[book].items()):
                if oid in pending_ids:
                    missing.pop(oid, None)
                elif oid in seen:
                    st[book].pop(k, None)
                    missing.pop(oid, None)
                    book_name = "买" if book == "buys" else "卖"
                    log.info("对账: %s单档位%s的挂单 %s 已有终态，清除记录", book_name, k, oid)
                else:
                    miss_n = missing.get(oid, 0) + 1
                    missing[oid] = miss_n
                    if miss_n >= 5:
                        st[book].pop(k, None)
                        missing.pop(oid, None)
                        log.warning("对账: 挂单 %s 连续%d轮查不到（多为重启前的旧模拟单），清除记录",
                                    oid, miss_n)
        # 清理已无挂单引用的 miss 计数，防止状态文件无限累积
        live_oids = set(st["buys"].values()) | set(st["sells"].values())
        for oid in list(missing.keys()):
            if oid not in live_oids:
                missing.pop(oid, None)

        # 3) 补网
        self._seed(px)

        st["seen"] = list(seen)[-2000:]
        self._save()

    def summary(self) -> dict:
        """当前状态摘要（用于日志展示；只发一次余额请求）。"""
        if not self._loaded:
            return {}
        st = self.st
        snap = self.broker.snapshot()
        quote, base = self.broker.quote_ccy, self.broker.base_ccy
        if self.last_px > 0:  # 总权益 = 现金+冻结挂单 + 持币市值
            est_total = (snap.get(quote, {}).get("total", 0.0) +
                         snap.get(base, {}).get("total", 0.0) * self.last_px)
        else:
            est_total = snap.get(quote, {}).get("avail", 0.0)
        return {
            "px": self.last_px,
            "open_buys": len(st["buys"]),
            "open_sells": len(st["sells"]),
            "cycles": st["cycles"],
            "buy_fills": st["buy_fills"],
            "sell_fills": st["sell_fills"],
            "realized_pnl": round(st["realized_pnl"], 4),
            "fees": round(st["fees"], 4),
            "est_total": round(est_total, 4),
            "halted": st["halted"],
            "balances": {ccy: v["avail"] for ccy, v in snap.items()},
        }
