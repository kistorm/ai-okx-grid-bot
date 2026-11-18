"""本地 Web 控制台服务端（纯标准库，无新增依赖）。

启动（项目根目录）:  python -m web.app [--port 8790]
然后浏览器打开 http://127.0.0.1:8790

安全设计:
- 只监听 127.0.0.1，局域网内其他设备访问不到
- API 凭据仅保存在本进程内存，不写磁盘、不打日志
- 欧易不存在「扫码授权 API 交易」机制；任何扫码授权交易所账户的操作都是钓鱼手法，
  正确方式是在欧易 App 创建只含「交易」权限的 API Key 后填入页面
"""
import argparse
import json
import logging
import os
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from bot.broker import LiveBroker, PaperBroker
from bot.grid import GridConfig, GridEngine
from bot.okx_client import OkxApiError, OkxClient
from bot.review import DailyTracker, build_review
from bot.stub import RandomWalkBroker

MODE_LABELS = {"dry": "纸面模拟", "offline": "离线演示", "demo": "欧易模拟盘", "live": "实盘"}
NEED_KEYS = ("demo", "live")
MARKET_INSTS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"]
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# 常见 OKX 错误码的人话提示（连接校验失败时附带展示）
OKX_ERR_HINTS = {
    "50111": "API Key 无效或已删除",
    "50112": "Passphrase 错误",
    "50113": "签名不匹配（检查 Secret Key 是否复制完整）",
    "51008": "余额不足（确认 USDT 已划转到交易账户）",
    "51010": "请求 IP 不在白名单",
}

log = logging.getLogger("web")


class UiLogHandler(logging.Handler):
    """捕获引擎相关日志到环形缓冲，供前端轮询展示。"""

    def __init__(self):
        super().__init__(level=logging.INFO)
        self._buf = deque(maxlen=1000)
        self._lock = threading.Lock()
        self._seq = 0

    def emit(self, record):
        entry = {
            "seq": 0,
            "ts": time.strftime("%H:%M:%S", time.localtime(record.created)),
            "level": record.levelname,
            "src": record.name,
            "msg": record.getMessage(),
        }
        with self._lock:
            self._seq += 1
            entry["seq"] = self._seq
            self._buf.append(entry)

    def events_after(self, after: int):
        with self._lock:
            events = [e for e in self._buf if e["seq"] > after]
            return events, self._seq


class TradingApp:
    """持有引擎/通道/行情线程，提供 HTTP 接口所需的全部状态与操作。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.mode = None
        self.engine = None
        self.broker = None
        self.interval = 30.0
        self.running = False
        self.paused = False
        self.pending_reset = False
        self.pending_reconfig = None   # 复盘确认后待执行的参数调整（GridConfig）
        self.tracker = DailyTracker(os.path.join("state", "review_history.json"))
        self.stop_event = threading.Event()
        self.market_stop = threading.Event()
        self.engine_thread = None
        self.market_thread = None
        self.market = []
        self.market_error = ""
        self.last_summary = {}
        self.last_balances = {}
        self.public_client = OkxClient()  # 公共行情（无需鉴权）
        self.ui_handler = UiLogHandler()
        self._setup_logging()

    def _setup_logging(self):
        root = logging.getLogger()
        root.setLevel(logging.INFO)
        if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
            root.addHandler(logging.StreamHandler())
        root.addHandler(self.ui_handler)

    # ---------- 后台循环 ----------
    def _engine_loop(self):
        while not self.stop_event.is_set():
            eng = self.engine
            if eng is not None:
                try:
                    if self.pending_reconfig is not None:
                        self._do_reconfig(eng)
                    elif self.pending_reset:
                        eng.reset()
                        self.pending_reset = False
                    elif not self.paused and not (eng._loaded and eng.st.get("halted")):
                        eng.tick()
                        s = eng.summary()  # 内部只发一次余额请求，含 balances
                        self.last_summary = s
                        self.last_balances = s.get("balances", {})
                        self._tracker_update(eng, s, paused=False,
                                             halted=eng.st.get("halted", False))
                    elif eng._loaded:
                        # 暂停/停机时也采样价格与权益，保证复盘数据完整
                        eng.last_px = eng.broker.price()
                        s = eng.summary()
                        self.last_summary = s
                        self.last_balances = s.get("balances", {})
                        self._tracker_update(eng, s, paused=self.paused,
                                             halted=eng.st.get("halted", False))
                except Exception:
                    log.exception("引擎 tick 异常")
            self.stop_event.wait(self.interval)

    def _market_loop(self):
        while not self.market_stop.is_set():
            out = []
            for inst in MARKET_INSTS:
                try:
                    t = self.public_client.tickers(inst)
                    last = float(t["last"])
                    open24 = float(t.get("open24h") or 0)
                    chg = (last - open24) / open24 * 100 if open24 > 0 else 0.0
                    out.append({"inst": inst, "last": last, "chg": round(chg, 2)})
                except Exception as e:
                    self.market_error = f"{e.__class__.__name__}: {e}"
            if out:
                self.market = out
                self.market_error = ""
            self.market_stop.wait(5)

    # ---------- 连接管理 ----------
    def connect(self, data: dict):
        with self.lock:
            if self.running:
                return {"ok": False, "error": "已连接，请先断开"}
            mode = data.get("mode", "")
            if mode not in MODE_LABELS:
                return {"ok": False, "error": f"未知模式 {mode}"}
            key = (data.get("api_key") or "").strip()
            secret = (data.get("api_secret") or "").strip()
            passphrase = (data.get("api_passphrase") or "").strip()
            if mode in NEED_KEYS and not (key and secret and passphrase):
                return {"ok": False, "error": "该模式需要在欧易创建 API Key 并填写三个凭据"
                                              "（权限只勾『交易』）"}
            inst_id = (data.get("inst_id") or "BTC-USDT").strip()
            try:
                cfg = GridConfig(
                    inst_id=inst_id,
                    upper=float(data.get("upper", 70000)),
                    lower=float(data.get("lower", 58000)),
                    grids=int(data.get("grids", 8)),
                    budget_quote=float(data.get("budget", 12)),
                    breakdown_buffer=float(data.get("breakdown_buffer", 0.02)),
                    breakdown_action=data.get("breakdown_action", "stop_loss"),
                    state_dir="state",
                )
                cfg.validate()
            except (ValueError, TypeError) as e:
                return {"ok": False, "error": f"参数错误: {e}"}

            client = OkxClient(key, secret, passphrase, simulated=(mode == "demo"))
            try:
                if mode == "offline":
                    broker = RandomWalkBroker(inst_id=inst_id,
                                              start_usdt=float(data.get("paper_usdt", 14)))
                elif mode == "dry":
                    broker = PaperBroker(client, inst_id,
                                         start_usdt=float(data.get("paper_usdt", 14)))
                else:
                    broker = LiveBroker(client, inst_id)
                    bal = broker.balances()  # 立即校验凭据与网络连通性
                    if bal.get(broker.quote_ccy, 0) <= 0:
                        log.warning("%s 可用为 0：请确认资金已划转到「交易账户」，否则下单会失败",
                                    broker.quote_ccy)
            except OkxApiError as e:
                hint = OKX_ERR_HINTS.get(str(e.code))
                return {"ok": False, "error": f"连接交易所失败: {e}"
                                             + (f"（提示：{hint}）" if hint else "")}
            except Exception as e:
                return {"ok": False, "error": f"连接交易所失败: {e}"}

            engine = GridEngine(cfg, broker)
            resumed = os.path.exists(engine.state_path)
            self.engine = engine
            self.broker = broker
            self.mode = mode
            self.interval = max(3.0, min(300.0, float(data.get("interval", 30)) or 30.0))
            if mode == "offline":
                self.interval = min(self.interval, 5.0)  # 演示模式跑快一点
            self.paused = False
            self.pending_reset = False
            self.pending_reconfig = None  # 不让上一次会话确认的调整泄漏到新连接
            self.last_summary = {}
            self.last_balances = {}
            self.running = True
            self.stop_event.clear()
            self.engine_thread = threading.Thread(target=self._engine_loop, daemon=True)
            self.engine_thread.start()
            if mode != "offline" and (self.market_thread is None or not self.market_thread.is_alive()):
                self.market_stop.clear()
                self.market_thread = threading.Thread(target=self._market_loop, daemon=True)
                self.market_thread.start()
            log.info("已连接: %s %s%s", MODE_LABELS[mode], inst_id,
                     "，恢复历史网格状态" if resumed else "，新开网格")
            return {"ok": True, "mode": mode, "resumed": resumed}

    def disconnect(self):
        with self.lock:
            if not self.running:
                return {"ok": False, "error": "未连接"}
            self.running = False
            self.stop_event.set()
        if self.engine_thread:
            self.engine_thread.join(timeout=self.interval + 3)
        with self.lock:
            self.engine = None
            self.broker = None
            self.mode = None
            self.pending_reconfig = None
            self.last_summary = {}
            self.last_balances = {}
            log.info("已断开连接（交易所挂单保留，状态已落盘）")
        return {"ok": True}

    def set_paused(self, paused: bool):
        self.paused = bool(paused)
        log.info("用户%s引擎（已有挂单保留在交易所）", "暂停" if self.paused else "继续")
        return {"ok": True, "paused": self.paused}

    def request_reset(self):
        if not self.running or self.engine is None:
            return {"ok": False, "error": "未连接"}
        self.pending_reset = True
        log.info("请求重置: 将撤销全部挂单并清空网格状态后重新铺网")
        return {"ok": True}

    # ---------- 复盘 ----------
    def _grid_info(self, eng) -> dict:
        st = eng.st
        return {"inst": eng.cfg.inst_id,
                "lower": st["levels"][0], "upper": st["levels"][-1],
                "grids": len(st["levels"]),
                "per_grid": st["per_grid_quote"],
                "committed": round(st["per_grid_quote"] * len(st["buys"]), 4),
                "open_buys": len(st["buys"]), "open_sells": len(st["sells"])}

    def _cfg_info(self, eng, s) -> dict:
        """复盘分析所需的当前参数与持仓概况。"""
        c = eng.cfg
        info = {"inst": c.inst_id, "upper": c.upper, "lower": c.lower,
                "grids": c.grids, "budget": c.budget_quote,
                "breakdown_action": c.breakdown_action}
        if s:
            info.update(self._grid_info(eng))
            bal = s.get("balances", {})
            info["base_value"] = round(bal.get(eng.broker.base_ccy, 0.0) * s.get("px", 0), 4)
        return info

    def _tracker_update(self, eng, s, paused, halted):
        """喂入当日采样；跨自然日时固化昨日记录并自动生成正式复盘。"""
        rollover = self.tracker.update(
            inst_id=eng.cfg.inst_id,
            px=s.get("px", 0.0), equity=s.get("est_total", 0.0),
            cycles=s.get("cycles", 0), realized=s.get("realized_pnl", 0.0),
            fees=s.get("fees", 0.0),
            buy_fills=s.get("buy_fills", 0), sell_fills=s.get("sell_fills", 0),
            open_buys=s.get("open_buys", 0), open_sells=s.get("open_sells", 0),
            committed=self._grid_info(eng)["committed"],
            halted=halted, paused=paused)
        if rollover:
            review = build_review(rollover, self._cfg_info(eng, s))
            self.tracker.add_review(rollover["date"], review, interim=False)
            day_pnl = round(rollover.get("end_equity", 0) - rollover.get("start_equity", 0), 4)
            day_cycles = rollover.get("cycles_end", 0) - rollover.get("cycles_start", 0)
            log.info("📋 已生成 %s 每日复盘: 循环 %d 个, 账户变动 %.4f USDT —— 打开『每日复盘』查看",
                     rollover["date"], day_cycles, day_pnl)

    def _do_reconfig(self, old_eng):
        """执行用户在复盘里确认过的参数调整：撤单重铺。"""
        cfg = self.pending_reconfig
        self.pending_reconfig = None
        log.info("执行复盘确认的调整: 撤销全部挂单, 新区间 [%.1f ~ %.1f] %d格",
                 cfg.lower, cfg.upper, cfg.grids)
        try:
            old_eng.reset()  # 撤单 + 清空旧状态；新引擎下一轮 tick 自动重新铺网
        except Exception:
            log.exception("reconfig 撤单失败")
        self.engine = GridEngine(cfg, self.broker)
        self.last_summary = {}
        self.tracker.note_reconfig()

    def review_snapshot(self) -> dict:
        eng = self.engine
        cfg_info = self._cfg_info(eng, self.last_summary or None) \
            if eng is not None and eng._loaded else None
        return {"connected": self.running, "paused": self.paused,
                "today": self.tracker.today_record(),
                "days": self.tracker.last_days(7),
                "reviews": self.tracker.last_reviews(7),
                "cfg": cfg_info}

    def generate_review(self) -> dict:
        eng = self.engine
        if eng is None or not eng._loaded:
            return {"ok": False, "error": "未连接或引擎未初始化，没有可分析的数据"}
        s = eng.summary()
        self._tracker_update(eng, s, paused=self.paused,
                             halted=eng.st.get("halted", False))
        rec = self.tracker.today_record()
        if not rec or rec.get("ticks", 0) == 0:
            return {"ok": False, "error": "今日暂无采样数据"}
        review = build_review(rec, self._cfg_info(eng, s))
        stored = self.tracker.add_review(rec["date"], review, interim=True)
        return {"ok": True, "review": stored}

    def apply_suggestion(self, data: dict) -> dict:
        """执行用户确认过的复盘建议。只有 reconfigure/pause 两类可执行。"""
        date_str = str(data.get("date") or "")
        sid = str(data.get("suggestion_id") or "")
        review = self.tracker.reviews.get(date_str)
        if not review:
            return {"ok": False, "error": "复盘报告不存在或已过期，请重新生成后再试"}
        sug = next((x for x in review.get("suggestions", []) if x.get("id") == sid), None)
        if not sug:
            return {"ok": False, "error": "建议项不存在（复盘可能已重新生成）"}
        act = (sug.get("action") or {}).get("type")
        if act == "pause":
            if not self.running:
                return {"ok": False, "error": "未连接，无需暂停"}
            self.set_paused(True)
            return {"ok": True, "message": "已暂停引擎（已有挂单保留），可随时点『继续』恢复"}
        if act != "reconfigure":
            return {"ok": True, "message": "该建议无需执行操作"}
        if not self.running or self.engine is None:
            return {"ok": False, "error": "未连接，无法调整参数"}
        ch = sug.get("changes", {})
        cur = self.engine.cfg
        new_cfg = GridConfig(
            inst_id=cur.inst_id,
            upper=float(ch.get("upper", cur.upper)),
            lower=float(ch.get("lower", cur.lower)),
            grids=int(ch.get("grids", cur.grids)),
            budget_quote=float(ch.get("budget_quote", cur.budget_quote)),
            breakdown_buffer=cur.breakdown_buffer,
            breakdown_action=str(ch.get("breakdown_action", cur.breakdown_action)),
            state_dir=cur.state_dir,
        )
        try:
            new_cfg.validate()
        except ValueError as e:
            return {"ok": False, "error": f"建议参数未通过校验: {e}"}
        with self.lock:
            self.pending_reconfig = new_cfg
        log.info("已受理复盘调整建议 %s: 区间 [%.1f ~ %.1f] %d格 —— 下一轮撤单重铺",
                 sid, new_cfg.lower, new_cfg.upper, new_cfg.grids)
        return {"ok": True,
                "message": "已受理：下一轮将撤销全部挂单并按新参数重新铺网"}

    # ---------- 状态 ----------
    def state(self):
        eng = self.engine
        s = {
            "connected": self.running,
            "mode": self.mode,
            "mode_label": MODE_LABELS.get(self.mode, ""),
            "paused": self.paused,
            "market_error": self.market_error,
            "summary": self.last_summary or {},
            "balances": self.last_balances or {},
            "quote_ccy": self.broker.quote_ccy if self.broker else "USDT",
            "base_ccy": self.broker.base_ccy if self.broker else "BTC",
            "halted": False,
            "halted_reason": "",
            "grid": None,
            "market": None,
        }
        if eng is not None and eng._loaded:
            st = eng.st
            s["halted"] = st["halted"]
            s["halted_reason"] = st["halted_reason"]
            s["grid"] = self._grid_info(eng)
            if self.mode == "offline" and self.last_summary.get("px"):
                # 离线模式没有外部行情，顶部大盘直接用引擎价格
                s["market"] = [{"inst": eng.cfg.inst_id,
                                "last": self.last_summary["px"], "chg": None}]
        return s


class _Handler(BaseHTTPRequestHandler):
    app: TradingApp = None

    def _send(self, status: int, ctype: str, body: bytes):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=200):
        self._send(status, "application/json; charset=utf-8",
                   json.dumps(obj, ensure_ascii=False).encode())

    def do_GET(self):
        try:
            self._do_get()
        except Exception as e:
            log.exception("GET 处理异常 %s", self.path)
            try:
                self._json({"error": str(e)}, 500)
            except Exception:
                pass

    def _do_get(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            try:  # 每次从磁盘读取，改完前端代码刷新浏览器即生效，无需重启服务
                with open(os.path.join(STATIC_DIR, "index.html"), "rb") as f:
                    html = f.read()
            except OSError:
                html = b"<h1>index.html missing</h1>"
            self._send(200, "text/html; charset=utf-8", html)
        elif path == "/api/state":
            self._json(self.app.state())
        elif path == "/api/market":
            self._json({"market": self.app.market, "error": self.app.market_error})
        elif path == "/api/events":
            qs = parse_qs(urlparse(self.path).query)
            try:
                after = int(qs.get("after", ["0"])[0])
            except ValueError:
                after = 0
            events, last = self.app.ui_handler.events_after(after)
            self._json({"events": events, "last": last})
        elif path == "/api/review":
            self._json(self.app.review_snapshot())
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json({"ok": False, "error": "请求体不是合法 JSON"}, 400)
            return
        try:
            if path == "/api/connect":
                self._json(self.app.connect(data))
            elif path == "/api/pause":
                self._json(self.app.set_paused(bool(data.get("paused"))))
            elif path == "/api/reset":
                self._json(self.app.request_reset())
            elif path == "/api/review/generate":
                self._json(self.app.generate_review())
            elif path == "/api/review/apply":
                self._json(self.app.apply_suggestion(data))
            elif path == "/api/disconnect":
                self._json(self.app.disconnect())
            else:
                self._json({"ok": False, "error": "not found"}, 404)
        except Exception as e:
            log.exception("接口异常 %s", path)
            self._json({"ok": False, "error": str(e)}, 500)

    def log_message(self, fmt, *args):  # 静默逐条请求日志
        log.debug("http " + fmt % args)


def auto_connect_from_env(app: TradingApp):
    """容器/开机自启场景：按环境变量 AUTO_MODE 自动连接，缺省不自动连接。

    AUTO_MODE=offline|dry|demo|live；demo/live 需同时提供
    OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE 环境变量。
    """
    mode = os.getenv("AUTO_MODE", "").strip()
    if not mode:
        return
    if mode not in MODE_LABELS:
        log.warning("AUTO_MODE=%s 无效（可选 %s），跳过自动连接", mode, "/".join(MODE_LABELS))
        return
    key = os.getenv("OKX_API_KEY", "")
    secret = os.getenv("OKX_API_SECRET", "")
    passphrase = os.getenv("OKX_API_PASSPHRASE", "")
    if mode in NEED_KEYS and not (key and secret and passphrase):
        log.warning("AUTO_MODE=%s 但缺少 OKX_API_KEY/SECRET/PASSPHRASE，跳过自动连接", mode)
        return

    def _run():
        time.sleep(1.0)  # 等端口先就绪
        try:
            r = app.connect({
                "mode": mode,
                "inst_id": os.getenv("AUTO_INST", "BTC-USDT").strip(),
                "upper": float(os.getenv("AUTO_UPPER", 70000)),
                "lower": float(os.getenv("AUTO_LOWER", 58000)),
                "grids": int(os.getenv("AUTO_GRIDS", 8)),
                "budget": float(os.getenv("AUTO_BUDGET", 12)),
                "interval": float(os.getenv("AUTO_INTERVAL", 30)),
                "breakdown_action": os.getenv("AUTO_BREAKDOWN_ACTION", "stop_loss"),
                "paper_usdt": float(os.getenv("AUTO_PAPER_USDT", 14)),
                "api_key": key, "api_secret": secret, "api_passphrase": passphrase,
            })
        except Exception as e:
            log.error("自动连接失败: %s", e)
            return
        log.info("自动连接(AUTO_MODE=%s)结果: %s", mode, r)

    threading.Thread(target=_run, daemon=True).start()


def main():
    ap = argparse.ArgumentParser(description="欧易网格机器人 Web 控制台")
    ap.add_argument("--host", default="127.0.0.1", help="默认只监听本机")
    ap.add_argument("--port", type=int, default=8790)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO)
    app = TradingApp()
    _Handler.app = app
    auto_connect_from_env(app)

    if args.host != "127.0.0.1":
        log.warning("监听非本机地址会让局域网内其他设备打开此页面，请确认了解风险")
    log.info("控制台地址: http://%s:%d  (Ctrl+C 退出)", args.host, args.port)
    srv = ThreadingHTTPServer((args.host, args.port), _Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log.info("退出")


if __name__ == "__main__":
    main()
