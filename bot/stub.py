"""离线演示通道：价格按时间做均值回归随机游走。

无需网络与 API Key，用途：
  1) 先打开界面看看效果（选「离线演示」模式）
  2) 本地端到端测试整条链路
注意：虚拟行情的波动速度不代表真实市场。
"""
import logging
import math
import random
import time

from .broker import PaperBroker

log = logging.getLogger("stub")


class RandomWalkBroker(PaperBroker):
    """继承 PaperBroker 的钱包/撮合逻辑，仅把价格源换成确定性随机游走。"""

    STEPS = 100000

    def __init__(self, inst_id="BTC-USDT", start_px=65000.0, start_usdt=14.0,
                 vol=0.005, step_s=3.0):
        self._start_px = float(start_px)
        self._vol = float(vol)
        self._step_s = float(step_s)
        self._t0 = time.time()
        self._prices = self._build_path()
        super().__init__(client=None, inst_id=inst_id, start_usdt=start_usdt)

    def _build_path(self):
        """预生成均值回归价格路径（固定随机种子，任何人打开效果一致）。"""
        rnd = random.Random(20261118)
        px = self._start_px
        out = [px]
        for _ in range(self.STEPS - 1):
            px *= math.exp(rnd.gauss(0, self._vol) - 0.03 * math.log(px / self._start_px))
            out.append(px)
        return out

    def price(self) -> float:
        n = int((time.time() - self._t0) / self._step_s)
        return self._prices[max(0, min(n, len(self._prices) - 1))]
