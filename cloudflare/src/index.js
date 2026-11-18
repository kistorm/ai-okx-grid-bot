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
  const data = [];
  let error = "";
  for (const inst of MARKET_INSTS) {
    try {
      const resp = await fetch(
        `https://www.okx.com/api/v5/market/tickers?instId=${inst}`,
        { signal: AbortSignal.timeout(8000) });
      const p = await resp.json();
      if (p.code === "0") {
        const t = p.data[0];
        const last = parseFloat(t.last);
        const open = parseFloat(t.open24h || 0);
        const chg = open > 0 ? Math.round(((last - open) / open) * 10000) / 100 : 0;
        data.push({ inst, last, chg });
      }
    } catch (e) {
      error = e.name || "Error";
    }
  }
  if (data.length) marketCache = { t: Date.now(), data, error: "" };
  else marketCache.error = error || "行情获取失败";
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
      const id = env.GRID.idFromName("bot");
      return env.GRID.get(id).fetch(request);
    }
    // 其余 /api/* 转发给 GridDO（同实例单机器人）
    const id = env.GRID.idFromName("bot");
    return env.GRID.get(id).fetch(request);
  },

  /** cron 兜底：每分钟确保 alarm 在排期；首次部署按 AUTO_MODE 自动连接。 */
  async scheduled(controller, env, ctx) {
    const id = env.GRID.idFromName("bot");
    const stub = env.GRID.get(id);
    ctx.waitUntil(stub.fetch(
      new Request("https://do.internal/internal/ensure-alarm", { method: "POST" })));
    ctx.waitUntil(stub.fetch(
      new Request("https://do.internal/internal/auto-connect", { method: "POST" })));
  },
};
