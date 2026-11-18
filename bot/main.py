"""欧易现货网格机器人入口。

用法（在项目根目录执行）:
  python -m bot.main --mode dry            # 纸面模拟：真实行情 + 本地虚拟钱包，零风险
  python -m bot.main --mode demo           # 欧易模拟盘：需在模拟盘单独创建 API Key
  python -m bot.main --mode live           # 实盘：真实下单
  python -m bot.main --mode live --reset   # 撤销挂单 + 清空状态，重新开始
"""
import argparse
import logging
import os
import sys
import time

from .broker import LiveBroker, PaperBroker
from .grid import GridConfig, GridEngine
from .okx_client import OkxClient

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

log = logging.getLogger("main")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="欧易现货网格机器人")
    p.add_argument("--mode", choices=["dry", "demo", "live"], default="dry",
                   help="运行模式: dry=纸面模拟(默认) demo=欧易模拟盘 live=实盘")
    p.add_argument("--inst", default="BTC-USDT", help="交易对，默认 BTC-USDT")
    p.add_argument("--upper", type=float, default=70000.0, help="网格上沿价格")
    p.add_argument("--lower", type=float, default=58000.0, help="网格下沿价格")
    p.add_argument("--grids", type=int, default=8, help="网格档数(>=2)")
    p.add_argument("--budget", type=float, default=12.0, help="网格总预算(USDT)")
    p.add_argument("--interval", type=float, default=30.0, help="轮询间隔秒数")
    p.add_argument("--ticks", type=int, default=0, help="运行轮数，0=一直运行")
    p.add_argument("--paper-usdt", type=float, default=14.0, help="dry 模拟盘初始USDT")
    p.add_argument("--breakdown-buffer", type=float, default=0.02,
                   help="跌破下沿多少比例触发断路器，默认0.02=2%%")
    p.add_argument("--breakdown-action", choices=["stop_loss", "hold"],
                   default="stop_loss", help="断路器动作: stop_loss=清仓停机 hold=保留币停机")
    p.add_argument("--state-dir", default="state", help="状态文件目录")
    p.add_argument("--reset", action="store_true", help="撤销全部挂单并清空状态后退出")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args(argv)


def setup_logging(level: str):
    fmt = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
    handlers = [logging.StreamHandler(sys.stdout),
                logging.FileHandler("bot.log", encoding="utf-8")]
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO),
                        format=fmt, handlers=handlers)


def main(argv=None):
    args = parse_args(argv)
    setup_logging(args.log_level)
    log.info("欧易现货网格机器人启动 mode=%s", args.mode)

    cfg = GridConfig(inst_id=args.inst, upper=args.upper, lower=args.lower,
                     grids=args.grids, budget_quote=args.budget,
                     breakdown_buffer=args.breakdown_buffer,
                     breakdown_action=args.breakdown_action,
                     state_dir=args.state_dir)
    try:
        cfg.validate()
    except ValueError as e:
        sys.exit(f"参数错误: {e}")

    key = os.getenv("OKX_API_KEY", "")
    secret = os.getenv("OKX_API_SECRET", "")
    passphrase = os.getenv("OKX_API_PASSPHRASE", "")
    if args.mode in ("demo", "live") and not (key and secret and passphrase):
        sys.exit("demo/live 模式需要先复制 .env.example 为 .env 并填写 API Key "
                 "(务必只开『交易』权限，禁止『提币』权限)")

    client = OkxClient(key, secret, passphrase, simulated=(args.mode == "demo"))

    if args.mode == "dry":
        log.info("== 纸面模拟模式: 使用真实行情, 钱包为本地虚拟, 不涉及真实资金 ==")
        broker = PaperBroker(client, cfg.inst_id, start_usdt=args.paper_usdt)
    else:
        broker = LiveBroker(client, cfg.inst_id)
        log.info("== %s ==", "欧易模拟盘" if args.mode == "demo" else "实盘模式")

    engine = GridEngine(cfg, broker)

    if args.reset:
        engine.reset()
        print("reset 完成: 挂单已撤销, 状态已清空")
        return

    log.info("网格参数: %s 区间[%.0f, %.0f] %d档 预算%.2fUSDT "
             "断路器=%s(缓冲%.1f%%) 轮询%.0fs",
             cfg.inst_id, cfg.lower, cfg.upper, cfg.grids, cfg.budget_quote,
             cfg.breakdown_action, cfg.breakdown_buffer * 100, args.interval)

    n = 0
    try:
        while args.ticks == 0 or n < args.ticks:
            try:
                engine.tick()
                s = engine.summary()
                if s:
                    log.info("状态: 价格=%.2f 挂买%d/挂卖%d 完成周期%d "
                             "已实现盈亏%.4f 费用%.4f 估值%.4f%s",
                             s["px"], s["open_buys"], s["open_sells"], s["cycles"],
                             s["realized_pnl"], s["fees"], s["est_total"],
                             " [已停机]" if s["halted"] else "")
            except Exception:
                log.exception("本轮执行异常，下一轮重试")
            n += 1
            if args.ticks == 0 or n < args.ticks:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("收到 Ctrl+C 退出。挂单与状态已保存，下次启动自动恢复。")
    finally:
        if engine._loaded:
            try:
                s = engine.summary()
                log.info("最终状态: 周期%d 已实现盈亏%.4f 费用%.4f 估值%.4f",
                         s["cycles"], s["realized_pnl"], s["fees"], s["est_total"])
            except Exception as e:
                log.warning("退出时汇总状态失败: %s", e)


if __name__ == "__main__":
    main()
