"""交易通道抽象层。

LiveBroker  —— 实盘 / 欧易模拟盘：直接调用欧易 REST API。
PaperBroker —— 本地纸面模拟：使用真实行情价格，钱包与订单在本地模拟，不下任何真实单。

两者实现同一接口，GridEngine 对底层通道无感知。
"""
import itertools
import logging
import uuid
from abc import ABC, abstractmethod
from decimal import Decimal, ROUND_DOWN

from .okx_client import OkxClient

log = logging.getLogger("broker")


def quantize(value, unit: Decimal) -> str:
    """向下取整到 unit 的整数倍并返回字符串（满足交易所精度要求）。"""
    q = (Decimal(str(value)) / unit).to_integral_value(rounding=ROUND_DOWN) * unit
    return format(q.normalize(), "f")


class Broker(ABC):
    base_ccy: str
    quote_ccy: str
    min_sz: Decimal
    lot_sz: Decimal
    tick_sz: Decimal

    @abstractmethod
    def price(self) -> float: ...

    @abstractmethod
    def snapshot(self) -> dict:
        """一次取回各币种 {ccy: {"avail": 可用, "total": 可用+挂单冻结}}。

        balances()/equity() 均由它派生，实盘下只需发一次余额请求。"""

    def balances(self) -> dict:
        return {ccy: v["avail"] for ccy, v in self.snapshot().items()}

    def equity(self, px: float) -> float:
        """按当前价估算总权益：现金 + 持仓 + 挂单冻结，折算成报价币。"""
        s = self.snapshot()
        return (s.get(self.quote_ccy, {}).get("total", 0.0) +
                s.get(self.base_ccy, {}).get("total", 0.0) * px)

    @abstractmethod
    def place_limit(self, side: str, px: float, sz: float):
        """返回 ord_id，失败/数量过小返回 None。"""

    @abstractmethod
    def place_market(self, side: str, sz: float): ...

    @abstractmethod
    def cancel_all(self) -> None: ...

    @abstractmethod
    def pending(self) -> list: ...

    @abstractmethod
    def fills(self, seen_ids: set) -> list:
        """返回新成交列表 [{ord_id, side, px, sz, fee}]，并把已处理的 ord_id 加入 seen_ids。"""


class LiveBroker(Broker):
    """实盘 / 模拟盘通道。"""

    def __init__(self, client: OkxClient, inst_id: str):
        self.c = client
        self.inst_id = inst_id
        meta = client.instruments("SPOT", inst_id)[0]
        self.lot_sz = Decimal(meta["lotSz"])
        self.min_sz = Decimal(meta["minSz"])
        self.tick_sz = Decimal(meta["tickSz"])
        self.base_ccy, self.quote_ccy = inst_id.split("-")
        log.info("交易规则 %s: minSz=%s lotSz=%s tickSz=%s",
                 inst_id, self.min_sz, self.lot_sz, self.tick_sz)

    def price(self) -> float:
        return float(self.c.tickers(self.inst_id)["last"])

    def snapshot(self) -> dict:
        out = {}
        for d in self.c.balance()[0].get("details", []):
            avail = float(d.get("availBal") or d.get("availEq") or 0)
            out[d["ccy"]] = {"avail": avail, "total": avail + float(d.get("frozenBal") or 0)}
        return out

    def place_limit(self, side: str, px: float, sz: float):
        px_s = quantize(px, self.tick_sz)
        sz_s = quantize(sz, self.lot_sz)
        if Decimal(sz_s) < self.min_sz or Decimal(px_s) <= 0:
            log.warning("跳过过小订单 %s %s@%s (minSz=%s)", side, sz_s, px_s, self.min_sz)
            return None
        try:
            r = self.c.place_order(self.inst_id, side, "limit", sz_s, px_s)
        except Exception as e:
            log.error("下单失败 %s %s@%s: %s", side, sz_s, px_s, e)
            return None
        if r.get("sCode") != "0":
            log.error("下单被拒 %s %s@%s: sCode=%s sMsg=%s",
                      side, sz_s, px_s, r.get("sCode"), r.get("sMsg"))
            return None
        log.info("[实盘] 限价单 %s %s %s @ %s ordId=%s", side, sz_s, self.inst_id, px_s, r["ordId"])
        return r["ordId"]

    def place_market(self, side: str, sz: float):
        sz_s = quantize(sz, self.lot_sz)
        if Decimal(sz_s) < self.min_sz:
            log.warning("市价单数量过小，跳过: %s (minSz=%s)", sz_s, self.min_sz)
            return None
        try:
            r = self.c.place_order(self.inst_id, side, "market", sz_s)
        except Exception as e:
            log.error("市价单失败 %s %s: %s", side, sz_s, e)
            return None
        if r.get("sCode") != "0":
            log.error("市价单被拒: sCode=%s sMsg=%s", r.get("sCode"), r.get("sMsg"))
            return None
        log.info("[实盘] 市价单 %s %s %s", side, sz_s, self.inst_id)
        return r["ordId"]

    def cancel_all(self) -> None:
        try:
            orders = self.c.pending_orders(self.inst_id)
        except Exception as e:
            log.error("查询挂单失败: %s", e)
            return
        for o in orders:
            try:
                r = self.c.cancel_order(self.inst_id, o["ordId"])
                if r.get("sCode") not in (None, "0"):
                    log.warning("[实盘] 撤单未成功 ordId=%s sCode=%s sMsg=%s",
                                o["ordId"], r.get("sCode"), r.get("sMsg"))
                else:
                    log.info("[实盘] 已撤单 ordId=%s", o["ordId"])
            except Exception as e:
                log.warning("撤单失败 ordId=%s: %s", o["ordId"], e)

    def pending(self) -> list:
        out = []
        for o in self.c.pending_orders(self.inst_id):
            out.append({
                "ord_id": o["ordId"],
                "side": o["side"],
                "px": float(o["px"]) if o.get("px") else 0.0,
                "sz": float(o.get("accFillSz") or o["sz"]),
                "ord_type": o.get("ordType"),
            })
        return out

    def fills(self, seen_ids: set) -> list:
        res = []
        try:
            hist = self.c.orders_history(self.inst_id, limit=100)
        except Exception as e:
            log.error("查询历史订单失败: %s", e)
            return res
        for o in hist:
            oid = o["ordId"]
            if oid in seen_ids:
                continue
            seen_ids.add(oid)  # 无论终态如何都标记为已见，避免重复处理
            state = o.get("state")
            acc = float(o.get("accFillSz") or 0)
            if state == "filled" or (state == "canceled" and acc > 0):
                # 完全成交，或部分成交后撤单——成交部分仍需按网格挂出对应单
                px = float(o.get("avgPx") or o.get("px") or 0)
                fee = float(o.get("fee") or 0)
                res.append({"ord_id": oid, "side": o["side"], "px": px, "sz": acc, "fee": fee})
                log.info("[实盘] 成交(%s) %s %s @ %s fee=%s", state, o["side"], acc, px, fee)
        return res


class PaperBroker(Broker):
    """本地纸面模拟：真实行情驱动，钱包/订单在本地模拟。

    成交规则（简化，忽略盘口深度）：
      限价买：价格 <= 挂单价 时成交；限价卖：价格 >= 挂单价 时成交。
    下单即冻结资金，撤单返还；手续费按 maker 费率近似扣除。
    """

    MAKER_FEE = 0.0008  # 普通用户现货 maker 费率（模拟用近似值）
    TAKER_FEE = 0.001   # 市价单按 taker 计费

    def __init__(self, client: OkxClient = None, inst_id: str = "BTC-USDT",
                 start_usdt: float = 14.0, price_provider=None):
        self.c = client
        self.inst_id = inst_id
        if client is not None:  # 真实交易规则；离线演示通道(client=None)用默认精度
            meta = client.instruments("SPOT", inst_id)[0]
            self.lot_sz = Decimal(meta["lotSz"])
            self.min_sz = Decimal(meta["minSz"])
            self.tick_sz = Decimal(meta["tickSz"])
        else:
            self.lot_sz = Decimal("0.000001")
            self.min_sz = Decimal("0.00001")
            self.tick_sz = Decimal("0.1")
        self.base_ccy, self.quote_ccy = inst_id.split("-")
        if price_provider is None:
            if client is not None:
                price_provider = lambda: float(client.tickers(inst_id)["last"])  # noqa: E731
            else:
                price_provider = lambda: 65000.0  # noqa: E731
        self._price_fn = price_provider
        self.usdt = float(start_usdt)
        self.base = 0.0
        self.fees_paid = 0.0
        self._orders = {}          # ord_id -> {side, px, sz}
        self._pending_fills = []   # 待引擎取走的成交
        self._ids = itertools.count(1)
        # 进程级唯一前缀：防止与状态文件里上一进程的订单号/seen去重表冲突
        # （冲突会导致新成交被引擎误判为已处理而静默吞掉，造成库存泄漏）
        self._id_prefix = uuid.uuid4().hex[:8] + "-"
        log.info("纸面模拟钱包: %s=%.4f (仅本地模拟)", self.quote_ccy, self.usdt)

    def price(self) -> float:
        return float(self._price_fn())

    def snapshot(self) -> dict:
        frozen_quote = sum(o["px"] * o["sz"] for o in self._orders.values() if o["side"] == "buy")
        frozen_base = sum(o["sz"] for o in self._orders.values() if o["side"] == "sell")
        return {
            self.quote_ccy: {"avail": self.usdt, "total": self.usdt + frozen_quote},
            self.base_ccy: {"avail": self.base, "total": self.base + frozen_base},
        }

    def _try_fill(self):
        px = self.price()
        for oid, o in list(self._orders.items()):
            hit = (o["side"] == "buy" and px <= o["px"]) or \
                  (o["side"] == "sell" and px >= o["px"])
            if hit:
                del self._orders[oid]
                self._pending_fills.append((oid, o["side"], o["px"], o["sz"]))
                log.info("[模拟] 成交 %s %s @ %s", o["side"], o["sz"], o["px"])

    def place_limit(self, side: str, px: float, sz: float):
        px_s = quantize(px, self.tick_sz)
        sz_s = quantize(sz, self.lot_sz)
        pxf, szf = float(px_s), float(sz_s)
        if szf < float(self.min_sz) or pxf <= 0:
            log.warning("[模拟] 跳过过小订单 %s %s@%s", side, sz_s, px_s)
            return None
        if side == "buy":
            cost = pxf * szf
            if cost > self.usdt:
                log.warning("[模拟] USDT 不足 (%.4f < %.4f)，跳过买单", self.usdt, cost)
                return None
            self.usdt -= cost  # 冻结
        else:
            if szf > self.base:
                log.warning("[模拟] %s 余额不足，跳过卖单", self.base_ccy)
                return None
            self.base -= szf   # 冻结
        oid = f"{self._id_prefix}{next(self._ids)}"
        self._orders[oid] = {"side": side, "px": pxf, "sz": szf}
        log.info("[模拟] 限价单 %s %s %s @ %s", side, sz_s, self.inst_id, px_s)
        return oid

    def place_market(self, side: str, sz: float):
        szf = float(quantize(sz, self.lot_sz))
        if szf < float(self.min_sz):
            return None
        px = self.price()
        if side == "sell":
            if szf > self.base:
                return None
            self.base -= szf
            fee = -px * szf * self.TAKER_FEE
            self.usdt += px * szf + fee
            self.fees_paid += abs(fee)
            log.info("[模拟] 市价卖出 %s @ %s", szf, px)
            return f"{self._id_prefix}{next(self._ids)}"
        cost = px * szf * (1 + 0.001)  # 网格策略不市价买入，保留兜底
        if cost > self.usdt:
            return None
        self.usdt -= cost
        self.base += szf
        return f"{self._id_prefix}{next(self._ids)}"

    def cancel_all(self) -> None:
        for o in self._orders.values():
            if o["side"] == "buy":
                self.usdt += o["px"] * o["sz"]
            else:
                self.base += o["sz"]
        self._orders.clear()

    def pending(self) -> list:
        return [{"ord_id": oid, "side": o["side"], "px": o["px"], "sz": o["sz"],
                 "ord_type": "limit"} for oid, o in self._orders.items()]

    def fills(self, seen_ids: set) -> list:
        self._try_fill()
        res = []
        for oid, side, px, sz in self._pending_fills:
            if oid in seen_ids:
                continue
            seen_ids.add(oid)
            # 费用记为负数（与 OKX 一致）：买入以基础币计费，卖出以报价币计费
            if side == "buy":
                fee = -sz * self.MAKER_FEE
                self.base += sz + fee
            else:
                fee = -px * sz * self.MAKER_FEE
                self.usdt += px * sz + fee
            self.fees_paid += abs(fee)
            res.append({"ord_id": oid, "side": side, "px": px, "sz": sz, "fee": fee})
        self._pending_fills = [f for f in self._pending_fills if f[0] not in seen_ids]
        return res
