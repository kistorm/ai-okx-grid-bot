/** Worker 入口：静态资源 + /api/* 鉴权转发到 GridDO + cron 兜底。
 *
 * 安全：/api/* 需要 UI_TOKEN（wrangler secret put UI_TOKEN），
 * 前端在 localStorage 保存令牌并附带 Authorization 头。
 */
import { GridDO } from "./do.js";

export { GridDO };

const MARKET_INSTS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];
let marketCache = { t: 0, data: [], error: "" };

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function timingSafeEqual(a, b) {
  // 等长比较，避免逐字符提前短路
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

async function fetchMarket() {
  if (Date.now() - marketCache.t < 10000) return;
  let lastErr = "";
  for (const host of ["https://www.okx.com", "https://aws.okx.com"]) {
    try {
      const resp = await fetch(
        `${host}/api/v5/market/tickers?instType=SPOT`,
        { signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", Accept: "application/json" } });
      const p = await resp.json();
      if (p.code === "0") {
        const data = [];
        for (const inst of MARKET_INSTS) {
          const t = (p.data ?? []).find((x) => x.instId === inst);
          if (!t) continue;
          const last = parseFloat(t.last);
          const open = parseFloat(t.open24h || 0);
          const chg = open > 0 ? Math.round(((last - open) / open) * 10000) / 100 : 0;
          data.push({ inst, last, chg });
        }
        if (data.length) { marketCache = { t: Date.now(), data, error: "" }; return; }
        lastErr = "行情列表中未找到目标交易对";
      } else {
        lastErr = `OKX ${p.code}: ${p.msg}`;
      }
    } catch (e) {
      lastErr = `${e.name || "Error"}`;
    }
  }
  marketCache.error = lastErr;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    // 访问令牌校验（部署后必须设置 UI_TOKEN，否则接口一律拒绝）
    const expected = env.UI_TOKEN ?? "";
    if (!expected) {
      return json({ error: "未设置 UI_TOKEN：请运行 npx wrangler secret put UI_TOKEN" }, 401);
    }
    const auth = (request.headers.get("Authorization") || "").slice(7);
    const token = auth || url.searchParams.get("token") || "";
    if (!timingSafeEqual(token, expected)) {
      return json({ error: "访问令牌错误" }, 401);
    }
    if (url.pathname === "/api/market") {
      try { await fetchMarket(); } catch { /* 忽略，走缓存/错误 */ }
      return json({ market: marketCache.data, error: marketCache.error });
    }
    if (url.pathname === "/api/auto-connect") {
      // 手动触发开机自启逻辑（cron 兜底之外的主动入口）
      const id = env.GRID.idFromName("bot-v3");
      return env.GRID.get(id).fetch(request);
    }
    if (url.pathname === "/api/kill-instance") {
      // 运维：断开某个历史实例（停止其 alarm 链）。用法 /api/kill-instance?name=bot
      const name = url.searchParams.get("name") || "";
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return json({ error: "name 非法" }, 400);
      const id = env.GRID.idFromName(name);
      return env.GRID.get(id).fetch(
        new Request("https://do.internal/api/disconnect", { method: "POST" }));
    }
    // 其余 /api/* 转发给 GridDO（同实例单机器人）
    const id = env.GRID.idFromName("bot-v3");
    return env.GRID.get(id).fetch(request);
  },

  /** cron 兜底：每分钟确保 alarm 在排期；首次部署按 AUTO_MODE 自动连接。 */
  async scheduled(controller, env, ctx) {
    const id = env.GRID.idFromName("bot-v3");
    const stub = env.GRID.get(id);
    ctx.waitUntil(stub.fetch(
      new Request("https://do.internal/internal/ensure-alarm", { method: "POST" })));
    ctx.waitUntil(stub.fetch(
      new Request("https://do.internal/internal/auto-connect", { method: "POST" })));
  },
};
