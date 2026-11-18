"""离线逻辑测试：脚本化价格路径驱动 GridEngine，验证网格行为与断路器。

不依赖网络、不需要 API Key。
运行: cd okx-grid-bot && python3 tests/test_offline.py
"""
import logging
import os
import shutil
import sys
from decimal import Decimal, ROUND_DOWN

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bot.grid import GridConfig, GridEngine  # noqa: E402


def q(v, unit):
    return format(((Decimal(str(v)) / unit).to_integral_value(rounding=ROUND_DOWN) * unit).normalize(), "f")


class StubBroker:
    """本地桩通道：手工喂价格路径，模拟成交与钱包。"""
    lot_sz = Decimal("0.000001")
    min_sz = Decimal("0.00001")
    tick_sz = Decimal("0.1")
    base_ccy = "BTC"
    quote_ccy = "USDT"

    def __init__(self, path):
        self.path = path
        self.i = -1
        self.usdt = 14.0
        self.base = 0.0
        self._orders = {}
        self._ids = iter(range(1, 10 ** 6))

    def _px(self):
        return self.path[self.i]

    def price(self):
        self.i = min(self.i + 1, len(self.path) - 1)  # 推进价格路径，末端保持不动
        return self._px()

    def snapshot(self):
        frozen_quote = sum(o["px"] * o["sz"] for o in self._orders.values() if o["side"] == "buy")
        frozen_base = sum(o["sz"] for o in self._orders.values() if o["side"] == "sell")
        return {
            "USDT": {"avail": self.usdt, "total": self.usdt + frozen_quote},
            "BTC": {"avail": self.base, "total": self.base + frozen_base},
        }

    def balances(self):
        return {ccy: v["avail"] for ccy, v in self.snapshot().items()}

    def place_limit(self, side, px, sz):
        px_s, sz_s = q(px, self.tick_sz), q(sz, self.lot_sz)
        pxf, szf = float(px_s), float(sz_s)
        if szf < float(self.min_sz) or pxf <= 0:
            return None
        if side == "buy":
            cost = pxf * szf
            if cost > self.usdt:
                return None
            self.usdt -= cost
        else:
            if szf > self.base:
                return None
            self.base -= szf
        oid = str(next(self._ids))
        self._orders[oid] = {"side": side, "px": pxf, "sz": szf}
        return oid

    def place_market(self, side, sz):
        szf = float(q(sz, self.lot_sz))
        if szf < float(self.min_sz):
            return None
        if side == "sell":
            px = self._px()
            self.base -= szf
            self.usdt += px * szf * 0.9992
            return str(next(self._ids))
        return None

    def cancel_all(self):
        for o in self._orders.values():
            if o["side"] == "buy":
                self.usdt += o["px"] * o["sz"]
            else:
                self.base += o["sz"]
        self._orders.clear()

    def pending(self):
        return [{"ord_id": k, "side": o["side"], "px": o["px"], "sz": o["sz"],
                 "ord_type": "limit"} for k, o in self._orders.items()]

    def fills(self, seen_ids):
        px = self._px()
        res = []
        for oid, o in list(self._orders.items()):
            hit = (o["side"] == "buy" and px <= o["px"]) or \
                  (o["side"] == "sell" and px >= o["px"])
            if not hit:
                continue
            del self._orders[oid]
            # 与 OKX 一致：fee 为负，买入以基础币计费、卖出以报价币计费
            if o["side"] == "buy":
                fee = -o["sz"] * 0.0008
                self.base += o["sz"] + fee
            else:
                fee = -o["px"] * o["sz"] * 0.0008
                self.usdt += o["px"] * o["sz"] + fee
            res.append({"ord_id": oid, "side": o["side"], "px": o["px"], "sz": o["sz"], "fee": fee})
        return res


def run(name, path, cfg_kwargs, checks, tmp_state="state_test"):
    print(f"\n===== 场景 {name} =====")
    shutil.rmtree(tmp_state, ignore_errors=True)
    broker = StubBroker(path)
    cfg = GridConfig(state_dir=tmp_state, **cfg_kwargs)
    engine = GridEngine(cfg, broker)
    for _ in range(len(path) + 2):
        engine.tick()
    s = engine.summary()
    print("摘要:", s)
    for desc, fn in checks:
        assert fn(s, engine, broker), f"断言失败: {desc}"
        print(f"  PASS: {desc}")
    shutil.rmtree(tmp_state, ignore_errors=True)
    print(f"场景 {name} 全部通过")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    # 场景A: 价格下探回升 —— 应完成若干买卖循环并产生正收益
    run(
        "A 跌后回升(震荡获利)", 
        [66000, 64000, 61000, 59000, 62000, 65000, 68000, 69000, 69000],
        dict(upper=70000, lower=58000, grids=8, budget_quote=12.0),
        [
            ("完成了至少3个买卖循环", lambda s, e, b: s["cycles"] >= 3),
            ("已实现盈亏为正", lambda s, e, b: s["realized_pnl"] > 0),
            ("未触发断路器", lambda s, e, b: not s["halted"]),
            ("仍有挂单在盘中", lambda s, e, b: len(e.st["buys"]) + len(e.st["sells"]) > 0),
            ("预算约束成立(挂买单+库存投入<=12)", lambda s, e, b: e._committed_quote() <= 12.0 + 1e-6),
            ("总权益守恒(≈本金+已实现盈亏, 权益核算未漏挂单)", lambda s, e, b: 13.0 < s["est_total"] < 15.0),
        ],
    )

    # 场景B: 单边暴跌 —— 断路器应清仓回USDT并停机
    run(
        "B 单边下跌(断路器止损)",
        [66000, 60000, 55000],
        dict(upper=70000, lower=58000, grids=8, budget_quote=12.0,
             breakdown_action="stop_loss", breakdown_buffer=0.02),
        [
            ("断路器已触发停机", lambda s, e, b: s["halted"]),
            ("清仓后BTC持仓≈0", lambda s, e, b: b.base < 1e-6),
            ("清仓后USDT回到8以上", lambda s, e, b: b.usdt > 8.0),
        ],
    )

    # 场景C: hold模式断路器 —— 价格逐格下穿(挂单真实成交)后跌破下沿，保留币停机
    run(
        "C 单边下跌(hold保留持仓)",
        [66000, 64500, 61000, 58500, 55000],
        dict(upper=70000, lower=58000, grids=8, budget_quote=12.0,
             breakdown_action="hold", breakdown_buffer=0.02),
        [
            ("断路器已触发停机", lambda s, e, b: s["halted"]),
            ("保留了已买入的BTC", lambda s, e, b: b.base > 0.00001),
        ],
    )

    print("\n全部测试通过 ✓")
