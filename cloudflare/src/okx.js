/**
 * 欧易 OKX V5 REST 客户端（Workers 版，WebCrypto 签名）。
 *
 * 签名规则与官方文档一致:
 *   prehash = timestamp + METHOD + requestPath [+ query] [+ body]
 *   OK-ACCESS-SIGN = base64(hmac_sha256(secret, prehash))
 */
const enc = new TextEncoder();

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
  timeoutMs = 15000,
  log = () => {},
} = {}) {
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
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers["OK-ACCESS-KEY"] = apiKey;
      headers["OK-ACCESS-SIGN"] = await sign(timestamp, method, requestPath, body);
      headers["OK-ACCESS-TIMESTAMP"] = timestamp;
      headers["OK-ACCESS-PASSPHRASE"] = passphrase;
    }
    if (simulated) headers["x-simulated-trading"] = "1";
    // 下单类 POST 不重试（超时后状态未知，重试可能重复下单）；GET 重试 2 次
    const attempts = method === "POST" && data ? 1 : 3;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await fetch(baseUrl + requestPath, {
          method,
          headers,
          body: data ? body : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const payload = await resp.json();
        if (payload.code !== "0") {
          throw new OkxApiError(payload.code, payload.msg, payload.data);
        }
        return payload.data;
      } catch (e) {
        if (e instanceof OkxApiError) throw e;
        lastErr = e;
        log("warning", `请求失败(第${i + 1}/${attempts}次) ${method} ${requestPath}: ${e}`);
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  }

  return {
    tickers: async (instId) =>
      (await request("GET", "/api/v5/market/tickers", { instId }))[0],
    instruments: async (instType = "SPOT", instId = null) => {
      const params = { instType };
      if (instId) params.instId = instId;
      return request("GET", "/api/v5/public/instruments", params);
    },
    balance: async () => request("GET", "/api/v5/account/balance", null),
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
