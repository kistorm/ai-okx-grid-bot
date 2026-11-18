"""每日复盘模块的确定性测试：数据采集跨日固化 + 规则化建议生成。

不依赖网络与 API Key。运行: cd okx-grid-bot && python3 tests/test_review.py
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bot.review import DailyTracker, build_review  # noqa: E402

TMP = "state_test_review"


def clean():
    shutil.rmtree(TMP, ignore_errors=True)


def sample_update_kwargs(px=65000, equity=14.0, cycles=0, realized=0.0, fees=0.0,
                         buy_fills=0, sell_fills=0, open_buys=5, open_sells=0,
                         committed=7.5, halted=False, paused=False,
                         inst_id="BTC-USDT"):
    return dict(inst_id=inst_id, px=px, equity=equity, cycles=cycles, realized=realized,
                fees=fees, buy_fills=buy_fills, sell_fills=sell_fills,
                open_buys=open_buys, open_sells=open_sells, committed=committed,
                halted=halted, paused=paused)


def test_tracker_rollover():
    clean()
    day = {"d": "2026-11-17"}
    now_fn = lambda fmt: day["d"] if fmt == "%Y-%m-%d" else "12:00:00"  # noqa: E731
    path = os.path.join(TMP, "review_history.json")
    tr = DailyTracker(path, now_fn=now_fn)
    tr.update(**sample_update_kwargs(px=65000, equity=14.0, cycles=0))
    tr.update(**sample_update_kwargs(px=66000, equity=14.1, cycles=3, realized=0.05,
                                     fees=0.01, buy_fills=3, sell_fills=3,
                                     open_buys=4, open_sells=0, committed=6.0))
    # 跨自然日
    day["d"] = "2026-11-18"
    rolled = tr.update(**sample_update_kwargs(px=65500, equity=14.05))
    assert rolled is not None, "跨日应返回昨日固化记录"
    assert rolled["date"] == "2026-11-17"
    assert rolled["px_high"] == 66000 and rolled["px_low"] == 65000
    assert rolled["end_equity"] == 14.1
    assert not rolled["active"], "昨日记录应被关闭"
    assert "2026-11-17" in tr.days and "2026-11-18" in tr.days
    assert tr.today_record()["start_equity"] == 14.05, "今日记录应从新起点开始"
    # 模拟重启：同一日期重建 tracker，当日记录应延续而非清零
    tr2 = DailyTracker(path, now_fn=now_fn)
    tr2.update(**sample_update_kwargs(px=65600, equity=14.06))
    assert tr2.today_record()["ticks"] >= 2, "重启后今日采样应延续"
    print("PASS: 采集器跨日固化 + 重启恢复当日记录")


def test_tracker_reset_baseline():
    """网格 reset 让累计计数器归零时，当日基线应重新锚定（日增量不能变负）。"""
    clean()
    day = {"d": "2026-11-17"}
    tr = DailyTracker(os.path.join(TMP, "review_history.json"),
                      now_fn=lambda fmt: day["d"] if fmt == "%Y-%m-%d" else "12:00:00")
    tr.update(**sample_update_kwargs(px=65000, equity=14.0, cycles=10, realized=0.15,
                                     fees=0.05, buy_fills=10, sell_fills=10))
    assert tr.today_record()["cycles_start"] == 10
    # 模拟 reset：计数器归零
    tr.update(**sample_update_kwargs(px=65100, equity=14.0, cycles=0, realized=0.0,
                                     fees=0.0, buy_fills=0, sell_fills=0))
    tr.update(**sample_update_kwargs(px=65200, equity=14.02, cycles=2, realized=0.01,
                                     fees=0.002, buy_fills=2, sell_fills=2))
    r = tr.today_record()
    assert r["cycles_end"] - r["cycles_start"] == 2, \
        f"重置后日增量应为新循环数, 实际 {r['cycles_end'] - r['cycles_start']}"
    assert r["realized_end"] - r["realized_start"] == 0.01
    assert r.get("resets_seen") == 1
    print("PASS: 重置后当日基线重新锚定，日增量不再为负")


def test_review_breakdown():
    rec = {"date": "2026-11-17", "ticks": 100, "start_px": 64000, "end_px": 56000,
           "px_high": 64500, "px_low": 56000, "start_equity": 14.0, "end_equity": 12.9,
           "cycles_start": 0, "cycles_end": 4, "realized_start": 0, "realized_end": -0.3,
           "fees_start": 0, "fees_end": 0.01, "halted_seen": True, "paused_ticks": 0,
           "open_buys_end": 0, "open_sells_end": 0, "committed_end": 0}
    cfg = {"upper": 70000, "lower": 58000, "grids": 8, "budget": 12.0,
           "committed": 0.0, "open_buys": 0, "open_sells": 0, "base_value": 0.0}
    r = build_review(rec, cfg)
    assert any(f["level"] == "risk" for f in r["findings"]), "断路器日应给出风险提示"
    kinds = [(s["kind"], s["action"]["type"]) for s in r["suggestions"]]
    assert ("reconfigure", "reconfigure") in kinds, "应给出下移区间建议"
    assert ("pause", "pause") in kinds, "应给出暂停备选"
    s1 = r["suggestions"][0]
    assert s1["changes"]["lower"] < 58000, "建议下沿应低于原下沿"
    assert s1["changes"]["upper"] > s1["changes"]["lower"]
    assert all(s["id"] for s in r["suggestions"]), "建议必须有 id 供确认执行引用"
    print("PASS: 断路器日 → 下移区间 + 暂停备选")


def test_review_above_upper():
    rec = {"date": "2026-11-17", "ticks": 100, "start_px": 71000, "end_px": 72500,
           "px_high": 72500, "px_low": 70500, "start_equity": 14.0, "end_equity": 14.0,
           "cycles_start": 0, "cycles_end": 0, "realized_start": 0, "realized_end": 0,
           "fees_start": 0, "fees_end": 0, "paused_ticks": 0,
           "open_buys_end": 8, "open_sells_end": 0, "committed_end": 12.0}
    cfg = {"upper": 70000, "lower": 58000, "grids": 8, "budget": 12.0,
           "committed": 12.0, "open_buys": 8, "open_sells": 0, "base_value": 0.0}
    r = build_review(rec, cfg)
    s0 = r["suggestions"][0]
    assert s0["action"]["type"] == "reconfigure", "价格全程高于上沿应建议上移区间"
    assert s0["changes"]["upper"] > 70000
    print("PASS: 价格全程高于上沿 → 上移区间建议")


def test_review_fee_drag():
    rec = {"date": "2026-11-17", "ticks": 200, "start_px": 65000, "end_px": 65100,
           "px_high": 65200, "px_low": 64900, "start_equity": 14.0, "end_equity": 14.0,
           "cycles_start": 0, "cycles_end": 6, "realized_start": 0, "realized_end": 0.02,
           "fees_start": 0, "fees_end": 0.05, "paused_ticks": 0,
           "open_buys_end": 5, "open_sells_end": 0, "committed_end": 7.5}
    cfg = {"upper": 70000, "lower": 58000, "grids": 8, "budget": 12.0,
           "committed": 7.5, "open_buys": 5, "open_sells": 0, "base_value": 0.0}
    r = build_review(rec, cfg)
    assert any(s["changes"].get("grids") == 6 for s in r["suggestions"]), \
        "费用侵蚀应建议减少格数拉大间距"
    print("PASS: 手续费侵蚀 → 减少格数建议")


def test_review_inventory_pause():
    rec = {"date": "2026-11-17", "ticks": 200, "start_px": 62000, "end_px": 59000,
           "px_high": 62500, "px_low": 58800, "start_equity": 14.0, "end_equity": 13.2,
           "cycles_start": 0, "cycles_end": 5, "realized_start": 0, "realized_end": 0.04,
           "fees_start": 0, "fees_end": 0.02, "paused_ticks": 0,
           "open_buys_end": 0, "open_sells_end": 2, "committed_end": 9.0}
    cfg = {"upper": 70000, "lower": 58000, "grids": 8, "budget": 12.0,
           "committed": 9.0, "open_buys": 0, "open_sells": 2, "base_value": 1.8}
    r = build_review(rec, cfg)
    assert any(s["action"]["type"] == "pause" for s in r["suggestions"]), \
        "库存过重且价格在下半区应建议暂停"
    assert any(f["level"] == "warn" for f in r["findings"])
    print("PASS: 库存过重 → 暂停建议")


def test_review_healthy():
    rec = {"date": "2026-11-17", "ticks": 300, "start_px": 65000, "end_px": 65300,
           "px_high": 65800, "px_low": 64200, "start_equity": 14.0, "end_equity": 14.15,
           "cycles_start": 0, "cycles_end": 5, "realized_start": 0, "realized_end": 0.12,
           "fees_start": 0, "fees_end": 0.01, "paused_ticks": 0,
           "open_buys_end": 5, "open_sells_end": 1, "committed_end": 7.5}
    cfg = {"upper": 70000, "lower": 58000, "grids": 8, "budget": 12.0,
           "committed": 7.5, "open_buys": 5, "open_sells": 1, "base_value": 0.5}
    r = build_review(rec, cfg)
    assert any(f["level"] == "ok" for f in r["findings"])
    assert any(s["action"]["type"] == "none" for s in r["suggestions"]), "健康日应建议维持现状"
    assert all(s["action"]["type"] != "reconfigure" for s in r["suggestions"]), \
        "健康日不应鼓动调参"
    print("PASS: 表现良好 → 维持现状，不鼓动调参")


def test_review_no_data():
    r = build_review({"ticks": 0}, {"upper": 70000, "lower": 58000,
                                    "grids": 8, "budget": 12.0})
    assert r["findings"], "无数据日应有提示"
    assert r["suggestions"]
    print("PASS: 无数据日给出提示")


if __name__ == "__main__":
    test_tracker_rollover()
    test_tracker_reset_baseline()
    test_review_breakdown()
    test_review_above_upper()
    test_review_fee_drag()
    test_review_inventory_pause()
    test_review_healthy()
    test_review_no_data()
    clean()
    print("\n复盘模块测试全部通过 ✓")
