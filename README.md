# OKX 现货网格机器人（ai-okx-grid-bot）

基于欧易 V5 REST API 的自动交易程序，带本地 Web 控制台与每日复盘。

- 策略：经典**现货网格**——价格每跌一格买入一份，每涨一格卖出一份，赚每格差价
- 防护：**下跌断路器**（跌破区间下沿自动清仓/停机，不无限接飞刀）
- 复盘：逐 tick 采集交易与行情数据，每天自动生成规则化复盘报告，
  调整建议**只提示、不自动执行**，是否采纳由你二次确认
- 只做现货、不用杠杆、API Key 不含提币权限（最后的安全垫）

> **诚实声明**：程序不保证盈利。小资金（如 14 USDT）下每个网格循环的利润在
> 0.02~0.05 USDT 量级，它首先是一台「验证策略 + 学习交易」的机器；
> 想滚大数字，靠的是策略验证成功后加本金，而不是提高杠杆频率。

## 功能一览

| 模块 | 说明 |
|------|------|
| Web 控制台 | 顶部大盘行情（BTC/ETH/SOL）· 左侧交易过程实时日志 · 右侧盈利/可用资金/暂停按钮 |
| 四种模式 | `offline` 离线演示（虚拟行情，零配置）· `dry` 纸面模拟（真实行情+虚拟钱包）· `demo` 欧易模拟盘 · `live` 实盘 |
| 网格引擎 | 自动铺网、成交配对（买→挂卖→回补）、断路器、状态落盘重启恢复 |
| 每日复盘 | 当日概览、历史每日记录、规则化调整建议（二次确认执行） |
| Docker | 一键部署，`restart: unless-stopped` 开机自启、崩溃自拉起 |
| 测试 | 离线确定性测试（网格行为/断路器/资金守恒）+ 复盘模块测试，无需网络与 Key |

## 快速开始

### 方式一：Docker（推荐，开机自启）

```bash
git clone git@github.com:kistorm/ai-okx-grid-bot.git
cd ai-okx-grid-bot
docker compose up -d --build
```

打开 http://127.0.0.1:8790 即可（只绑定宿主机回环地址，局域网访问不到）。

- `restart: unless-stopped` + Docker 服务开机自启 → 重启机器、崩溃都会自动拉起
- 状态与复盘历史挂载在 `./state/`，容器重建不丢
- 时区固定 Asia/Shanghai，复盘按北京时间切分
- 默认开机自动进入 `offline` 离线演示。要开机自动进入其他模式，在 `.env` 里配置
  （该文件被 .gitignore/.dockerignore 排除，不会进仓库/镜像）：

  ```ini
  AUTO_MODE=dry            # 或 demo / live（live 必须配下面三个凭据）
  OKX_API_KEY=...
  OKX_API_SECRET=...
  OKX_API_PASSPHRASE=...
  # 可选：AUTO_INST / AUTO_UPPER / AUTO_LOWER / AUTO_GRIDS / AUTO_BUDGET / AUTO_INTERVAL
  ```
  改完 `docker compose up -d` 重建生效。

常用命令：`docker logs -f okx-grid-bot`（日志）、`docker restart okx-grid-bot`（重启）、
`docker compose down`（彻底停止）。

### 方式二：Cloudflare Workers + Durable Objects（全球边缘，免费额度）

`cloudflare/` 目录是同一套网格引擎的 Workers 原生实现：
引擎状态存 Durable Object（SQLite），alarms 驱动周期性 tick，cron 每分钟兜底，
断电/重启后 cron 自动拉起并恢复状态——「开机自启」的云端版。

```bash
cd cloudflare
npx wrangler login               # 浏览器授权一次
npx wrangler deploy              # 部署
npx wrangler secret put UI_TOKEN # 设置控制台访问令牌（自定字符串）
```

- 访问地址：`https://ai-okx-grid-bot.<你的子域>.workers.dev`（**workers.dev 在大陆被墙**，
  需绑自定义域名才能直连；命令行/海外网络可直接访问）
- 首次部署后 1 分钟内（cron 触发）按 `AUTO_MODE`（默认 offline）自动连接并恢复运行；
  也可在页面手动连接
- 控制台需要输入 `UI_TOKEN` 令牌（保存在浏览器 localStorage）
- demo/live 模式需配置 secrets：`npx wrangler secret put OKX_API_KEY / OKX_API_SECRET /
  OKX_API_PASSPHRASE`
- 免费额度足够 14 USDT 量级的机器人（约每 30 秒一次 tick 的 DO 时长消耗）
- 已知差异：Workers 出口 IP 不固定，OKX 的 IP 白名单功能用不了；tick 间隔受
  alarms 精度限制

### 方式三：源码直跑

### 方式三：源码直跑

```bash
pip install -r requirements.txt

python3 tests/test_offline.py        # 离线自检（无需网络与 Key）
python3 tests/test_review.py         # 复盘模块自检

python -m web.app                    # Web 控制台 → http://127.0.0.1:8790
# 或纯命令行：
python -m bot.main --mode dry        # 纸面模拟
python -m bot.main --mode live       # 实盘
python -m bot.main --mode live --reset   # 撤单+清状态重开
```

## 连接模式与 API Key 安全

| 模式 | 行情 | 钱包 | 需要 Key | 用途 |
|------|------|------|----------|------|
| `offline` | 虚拟随机 | 本地虚拟 | 否 | 看界面/验证部署 |
| `dry` | 真实 | 本地虚拟 | 否 | 推荐先跑几天验证策略 |
| `demo` | 真实 | 欧易模拟盘 | 是（模拟盘单独创建） | 验证真实下单链路 |
| `live` | 真实 | 真实资金 | 是 | 实盘 |

创建 Key 的安全要求（逐条照做）：

1. 欧易 App/网页 → 个人中心 → **API** → 创建
2. 权限：**只勾「交易」，绝对不勾「提币」**
3. 建议绑定运行机器人的 IP 白名单
4. Secret 只在创建时显示一次；`.env` 不进 git、不发给任何人
5. 模拟盘要在模拟盘界面单独创建一套 Key
6. 确认 USDT 在**交易账户**（不是资金账户），否则下单报余额不足

**防钓鱼**：欧易不存在「扫码授权 API 交易」机制——任何让你扫码授权交易所账户的操作
都是钓鱼诈骗的典型手法。正确方式只有上面这一种。

## 界面与每日复盘

布局：**顶部**大盘行情｜**左侧**自动化交易过程实时日志（挂单/成交/断路器事件，
成交绿色高亮）｜**右侧**盈利（含权益走势）、可用资金、网格状态、暂停/重置/断开/复盘按钮。

每日复盘（右侧 →「每日复盘」）：

- 当日概览（价格区间、账户变动、循环数、费用、库存占比）+ 历史每日记录表
- 跨自然日自动固化昨日记录并生成正式复盘，事件流提示
- 规则化调整建议（确定性计算，非玄学）：

| 情形 | 建议 |
|------|------|
| 触发断路器 | 🔴 下移区间重铺 / 先暂停观察（二选一） |
| 价格全程高于上沿 | 🟠 上移区间 |
| 库存占比 >60% 且价格在下半区 | 🟠 暂停网格 |
| 手续费 > 已实现盈亏 60% | 🔵 减少格数拉大间距 |
| 区间内零成交 | 🔵 收窄区间 |
| 正贡献且循环正常 | 🟢 维持现状（不鼓动调参） |

**是否采纳由你本人决定**：执行任何调整需二次点击确认；机器人没有任何自动改参数的路径。
网格被重置时当日基线自动重锚，日增量不会出现负数。

## 参数说明

| 参数 | 默认 | 说明 |
|------|------|------|
| `inst` | BTC-USDT | 交易对。小资金建议只做 BTC/ETH |
| `upper` / `lower` | 70000 / 58000 | 网格上下沿，按近期波动区间设置 |
| `grids` | 8 | 格数（2~50）。每格间距必须 > 手续费×2，建议间距 ≥ 1.5% |
| `budget` | 12 | 网格总预算 USDT |
| `interval` | 30 | 轮询间隔秒（3~300） |
| `breakdown-buffer` | 0.02 | 跌破下沿 2% 触发断路器 |
| `breakdown-action` | stop_loss | `stop_loss`=清仓回 USDT 停机；`hold`=保留币停机 |

## 手续费数学

普通用户现货 maker 0.08%、taker 0.1%，一买一卖来回 ≈ 0.2% 成本。
默认参数每格间距 ≈ 2.6%，每格循环净利 ≈ 2.4% × 1.5 USDT ≈ 0.036 USDT。
**14 USDT 的现实预期是每天几毛钱以内的量级**——这台机器的价值是验证策略，不是印钞。

## FAQ（常见问题）

**Q：连接「纸面模拟/模拟盘/实盘」一直超时失败？**
机器人需要访问 `www.okx.com`。本机无法直连时：命令行方式给进程配置
`HTTPS_PROXY=http://127.0.0.1:代理端口`；Docker 方式在 `docker-compose.yml` 的
`environment` 里加 `HTTPS_PROXY`（代理跑在宿主机时地址用
`http://host.docker.internal:端口`，并在 compose 里加
`extra_hosts: ["host.docker.internal:host-gateway"]`）。离线演示模式不受影响。

**Q：右侧「USDT 可用」变少了？**
正常。网格会把预算冻结成挂买单和已买入的库存（含在途卖单），看「账户估值」
才是总资产口径（含挂单冻结与持币市值）。

**Q：断路器触发停机了，接下来怎么办？**
打开「每日复盘」，会有🔴建议：下移区间重铺，或先暂停观察。二选一确认执行即可。

**Q：数据存在哪里？删了会怎样？**
`state/` 目录（网格状态 + 复盘历史）。删掉只丢历史记录，机器人会用当前参数
重新铺网；交易账户里的真实资金不受影响。

**Q：改了参数为什么不生效？**
恢复历史状态时若与本次参数不一致，机器人会按历史区间继续跑并在日志警告；
点「重置网格」（或 `--reset`）后新参数才生效。

**Q：怎么彻底重新开始？**
页面点「重置网格」，或命令行 `--reset`：撤销全部挂单 + 清空状态重新铺网。

**Q：API Key 泄露了怎么办？**
立即去欧易后台删除该 Key。因为程序只要求交易权限（无提币权限），最坏情况是
被恶意交易，资金无法被转走。

**Q：能跑山寨币/合约吗？**
程序只支持欧易现货（tdMode=cash），结构上没有合约/杠杆/提币能力。小资金
不建议山寨币——滑点和风险都远高于 BTC/ETH。

**Q：两个机器人实例能同时跑吗？**
不能。同一交易对重复运行会互相打架（重复铺网/对账混乱）。

**Q：退出/Ctrl+C/容器重启，挂单会丢吗？**
不会。挂单留在交易所，状态已落盘，下次启动自动恢复并对账续管。

## 开发与测试

```bash
python3 tests/test_offline.py   # 网格行为/断路器/资金守恒（确定性场景，11 项断言）
python3 tests/test_review.py    # 复盘采集与规则建议（8 项断言）
```

目录结构：

```
okx-grid-bot/
├── bot/
│   ├── okx_client.py   # OKX V5 签名客户端（下单 POST 绝不自动重试）
│   ├── broker.py       # LiveBroker(实盘/模拟盘) + PaperBroker(纸面模拟/离线演示基类)
│   ├── grid.py         # 网格引擎 + 断路器 + 对账 + 状态持久化
│   ├── review.py       # 每日数据采集器 + 规则化复盘建议
│   ├── stub.py         # 离线演示随机行情通道
│   └── main.py         # 命令行入口
├── web/
│   ├── app.py          # Web 控制台服务端（纯标准库，含自动连接）
│   └── static/index.html
├── tests/              # 离线测试（无需网络与 Key）
├── Dockerfile / docker-compose.yml
└── state/              # 运行数据（不入库）
```

## 风险提示

- 加密货币波动剧烈，网格在单边行情会亏损或触发断路器；断路器只缓解、不消除损失。
- 本程序仅连接交易接口，无法提币（请确保 Key 未开提币权限，这是最后的安全垫）。
- 请自行确认所在地对加密货币交易的监管要求，自负盈亏。
