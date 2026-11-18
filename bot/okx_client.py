"""欧易 OKX V5 REST 客户端：签名、请求封装、错误处理。

签名规则（官方文档）:
  prehash = timestamp + METHOD + requestPath [+ query] [+ body]
  OK-ACCESS-SIGN = base64(hmac_sha256(secret_key, prehash))
  OK-ACCESS-TIMESTAMP = ISO8601 毫秒级 UTC, 例 2020-12-08T09:08:07.721Z
"""
import base64
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests

log = logging.getLogger("okx")


class OkxApiError(RuntimeError):
    """OKX 返回 code != '0' 时抛出。"""

    def __init__(self, code, msg, data=None):
        super().__init__(f"OKX API 错误 code={code} msg={msg} data={data}")
        self.code = code
        self.msg = msg
        self.data = data


class OkxClient:
    def __init__(self, api_key="", secret_key="", passphrase="",
                 simulated=False, base_url="https://www.okx.com", timeout=15):
        self.api_key = api_key
        self.secret_key = secret_key
        self.passphrase = passphrase
        self.simulated = simulated          # demo 模拟盘需带 x-simulated-trading: 1
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    # ---------- 签名 ----------
    @staticmethod
    def _timestamp() -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    def _sign(self, timestamp: str, method: str, request_path: str, body: str) -> str:
        message = f"{timestamp}{method.upper()}{request_path}{body}"
        mac = hmac.new(self.secret_key.encode(), message.encode(), hashlib.sha256)
        return base64.b64encode(mac.digest()).decode()

    def _headers(self, method: str, request_path: str, body: str) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:  # 公共行情接口无需鉴权头
            ts = self._timestamp()
            headers.update({
                "OK-ACCESS-KEY": self.api_key,
                "OK-ACCESS-SIGN": self._sign(ts, method, request_path, body),
                "OK-ACCESS-TIMESTAMP": ts,
                "OK-ACCESS-PASSPHRASE": self.passphrase,
            })
        if self.simulated:
            headers["x-simulated-trading"] = "1"
        return headers

    # ---------- 请求 ----------
    def _request(self, method: str, path: str, params=None, data=None):
        request_path = path
        if params:
            request_path = f"{path}?{urlencode(params)}"
        body = json.dumps(data, separators=(",", ":")) if data is not None else ""
        url = self.base_url + request_path
        # 下单类 POST 绝不自动重试（超时后状态未知，重试可能造成重复下单）
        attempts = 1 if (method == "POST" and data is not None) else 3
        last_exc = None
        for i in range(attempts):
            try:
                resp = self.session.request(
                    method, url,
                    headers=self._headers(method, request_path, body),
                    data=body if data is not None else None,
                    timeout=self.timeout,
                )
                payload = resp.json()
                if payload.get("code") != "0":
                    raise OkxApiError(payload.get("code"), payload.get("msg"), payload.get("data"))
                return payload.get("data")
            except OkxApiError:
                raise
            except (requests.RequestException, ValueError) as e:
                last_exc = e
                log.warning("请求失败(第%d/%d次) %s %s: %s", i + 1, attempts, method, request_path, e)
                time.sleep(0.8 * (i + 1))
        raise last_exc

    # ---------- 公共行情 ----------
    def tickers(self, inst_id: str) -> dict:
        return self._request("GET", "/api/v5/market/tickers", {"instId": inst_id})[0]

    def instruments(self, inst_type: str = "SPOT", inst_id: str = None) -> list:
        params = {"instType": inst_type}
        if inst_id:
            params["instId"] = inst_id
        return self._request("GET", "/api/v5/public/instruments", params)

    # ---------- 账户 ----------
    def balance(self, ccy: str = None) -> list:
        params = {"ccy": ccy} if ccy else None
        return self._request("GET", "/api/v5/account/balance", params)

    # ---------- 交易 ----------
    def place_order(self, inst_id: str, side: str, ord_type: str, sz: str,
                    px: str = None, td_mode: str = "cash") -> dict:
        body = {"instId": inst_id, "tdMode": td_mode, "side": side,
                "ordType": ord_type, "sz": sz}
        if px is not None:
            body["px"] = px
        return self._request("POST", "/api/v5/trade/order", data=body)[0]

    def cancel_order(self, inst_id: str, ord_id: str) -> dict:
        return self._request("POST", "/api/v5/trade/cancel-order",
                             data={"instId": inst_id, "ordId": ord_id})[0]

    def pending_orders(self, inst_id: str) -> list:
        return self._request("GET", "/api/v5/trade/orders-pending",
                             {"instType": "SPOT", "instId": inst_id})

    def orders_history(self, inst_id: str, limit: int = 100, after: str = None) -> list:
        params = {"instType": "SPOT", "instId": inst_id, "limit": str(limit)}
        if after:
            params["after"] = str(after)
        return self._request("GET", "/api/v5/trade/orders-history", params)
