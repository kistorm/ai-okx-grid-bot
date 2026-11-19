/**
 * 欧易 OKX V5 REST 客户端（Workers 版，WebCrypto 签名）。
 *
 * 签名规则与官方文档一致:
 *   prehash = timestamp + METHOD + requestPath [+ query] [+ body]
 *   OK-ACCESS-SIGN = base64(hmac_sha256(secret, prehash))
 *
 * 网络适配：
 *  - 带浏览器 UA（OKX 边缘对无 UA 的数据中心请求会返回 WAF 参数错误）
 *  - 主域名 www.okx.com 失败时自动回退备用域名 aws.okx.com
 */
const enc = new TextEncoder();

const HOSTS = ["https://www.okx.com", "https://aws.okx.com"];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export class OkxApiError extends Error {
  constructor(code, msg, data) {
    super(`OKX API 错误 code=${code} msg=${msg}`);
    this.code = code;
    this.msg = msg;
    this.data = data;
  }
}

function b64(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function createOkxClient({
  apiKey = "",
  secretKey = "",
  passphrase = "",
  simulated = false,
  baseUrl = "https://www.okx.com",
  timeoutMs = 6000,
  log = () => {},
} = {}) {
  const hosts = [baseUrl, ...HOSTS.filter((h) => h !== baseUrl)];

  async function sign(timestamp, method, requestPath, body) {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secretKey),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC", key, enc.encode(`${timestamp}${method.toUpperCase()}${requestPath}${body}`));
    return b64(mac);
  }

  async function request(method, path, params, data) {
    let requestPath = path;
    if (params) requestPath += "?" + new URLSearchParams(params).toString();
    const body = data ? JSON.stringify(data) : "";
    const timestamp = new Date().toISOString(); // 毫秒级 ISO，与官方要求一致
    // 下单类 POST 不重试（超时后状态未知，重试可能重复下单），且只打主域名；
    // 其余 GET 依次尝试主备域名：网络失败与部分 OKX 业务错误（如区域网关的
    // 参数差异）都换下一个域名再试，最后一个域名的错误才抛出。
    const attempts = method === "POST" && data ? hosts.slice(0, 1) : hosts;
    let lastApiErr = null;
    let lastErr = null;
    for (let i = 0; i < attempts.length; i++) {
      const host = attempts[i];
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": UA,
        Accept: "application/json",
      };
      if (apiKey) {
        headers["OK-ACCESS-KEY"] = apiKey;
        headers["OK-ACCESS-SIGN"] = await sign(timestamp, method, requestPath, body);
        headers["OK-ACCESS-TIMESTAMP"] = timestamp;
        headers["OK-ACCESS-PASSPHRASE"] = passphrase;
      }
      if (simulated) headers["x-simulated-trading"] = "1";
      try {
        const resp = await fetch(host + requestPath, {
          method,
          headers,
          body: data ? body : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const payload = await resp.json();
        if (payload.code !== "0") {
          // code=1 时真实原因在 data[0].sCode/sMsg（如余额不足/参数错误），挖出来便于诊断
          const inner = (payload.data ?? [])[0];
          const detail = inner?.sMsg
            ? `${payload.msg}（真实原因 ${inner.sCode}: ${inner.sMsg}）[${host}]`
            : `${payload.msg} [${host}]`;
          const err = new OkxApiError(payload.code, detail, payload.data);
          if (method === "POST" && data) throw err;
          lastApiErr = err;
          continue;
        }
        return payload.data;
      } catch (e) {
        if (e instanceof OkxApiError && method === "POST" && data) throw e;
        lastErr = e;
        log("warning", `请求失败(第${i + 1}/${attempts.length}次) ${method} ${requestPath}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastApiErr ?? lastErr;
  }

  return {
    /** 行情查询：CF 出口命中的 OKX 网关变体要求 instType 且忽略 instId
     *  （返回全 SPOT 列表，需自行查找目标交易对）；标准 REST 网关同样支持
     *  instType 形态。统一用 instType=SPOT 拉列表后查找。 */
    tickers: async (instId) => {
      const data = await request("GET", "/api/v5/market/tickers", { instType: "SPOT" });
      const row = (data ?? []).find((t) => t.instId === instId);
      if (!row) throw new Error(`行情列表中未找到 ${instId}`);
      return row;
    },
    instruments: async (instType = "SPOT", instId = null) => {
      const params = { instType };
      if (instId) params.instId = instId;
      return request("GET", "/api/v5/public/instruments", params);
    },
    balance: async () => request("GET", "/api/v5/account/balance", null),
    // 资金账户余额（资产账户），用于诊断“钱在哪”
    fundingBalances: async (ccy = null) =>
      request("GET", "/api/v5/asset/balances", ccy ? { ccy } : null),
    placeOrder: async (instId, side, ordType, sz, px = null, tdMode = "cash") => {
      const body = { instId, tdMode, side, ordType, sz };
      if (px !== null) body.px = px;
      return (await request("POST", "/api/v5/trade/order", null, body))[0];
    },
    cancelOrder: async (instId, ordId) =>
      (await request("POST", "/api/v5/trade/cancel-order", null,
        { instId, ordId }))[0],
    pendingOrders: async (instId) =>
      request("GET", "/api/v5/trade/orders-pending",
        { instType: "SPOT", instId }),
    ordersHistory: async (instId, limit = 100) =>
      request("GET", "/api/v5/trade/orders-history",
        { instType: "SPOT", instId, limit: String(limit) }),
  };
}
