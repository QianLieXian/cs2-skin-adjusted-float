# CS2 炼金磨损匹配 Web 工具

该目录是**独立子项目**，不会改动你原来的 Python 项目逻辑。

## 功能

- 支持目标磨损输入（0~1，最多 16 位小数）。
- 内置哈乐昆 / 攀升 / 寒带 / 热辐射 / 墨彩收藏品全部饰品数据（共 120 条，含每个饰品的最小/最大磨损）。
- 根据库存材料平均磨损，计算最接近目标值的输出饰品候选。
- 提供 Steam 登录与库存读取接口（需要配置 Steam API Key）。
- 支持直接粘贴交易链接读取公开库存（无需 Steam 登录），并标记交易冷却/限制中的物品。
- 前端支持直接填写 Steam Web API Key（会保存在浏览器 localStorage，并作为请求参数发送给当前后端）。

## 快速启动

```bash
cd steam-tradeup-web
npm install
npm run start
```

打开 `http://localhost:5173`。

## 常见问题

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'`




### 已登录但“库存 0 件 / source unknown”

这通常是后端未读取到可用的 `STEAM_API_KEY` 导致的，不是你 Steam 账号没物品。

- 启动日志如果出现 `[WARN] Missing STEAM_API_KEY`，说明服务端无法调用 Steam 库存 API。
- 新版本会在页面明确显示“请在后端 .env 配置 STEAM_API_KEY，或在前端填写 Steam Web API Key 后重试”。

请在 `steam-tradeup-web/.env` 增加：

```env
STEAM_API_KEY=你的SteamWebAPIKey
```

保存后重启：

```bash
npm run start
```

如果你暂时不想改服务器 `.env`，也可先在网页里填写 API Key，再点击登录后读取库存。
如果你不想登录，可改用“通过交易链接读取库存”（要求库存公开）。

### `InternalOpenIDError: Failed to verify assertion`

这通常不是 API Key 错误，而是 **Steam 回调地址不一致**（域名/端口/http-https 任意一项不一致）导致：

1. 先看后端新增日志（`[INFO] Steam OpenID start` / `[INFO] Steam OpenID return` / `[ERROR] Steam OpenID callback failed`）。
2. 对比以下字段必须一致：
   - `expectedReturnURL`
   - `openid.return_to`
   - `expectedRealm`
3. 固定 `BASE_URL`（或显式设置 `STEAM_REALM` 与 `STEAM_RETURN_URL`），避免登录发起与回调阶段使用了不同 Host。
4. 反向代理场景请正确透传 `X-Forwarded-Proto` 与 `X-Forwarded-Host`。
5. 如果你的面板代理会把 Host 改写成 `localhost`，请在 `.env` 增加固定公网地址：`PUBLIC_BASE_URL=https://你的域名`。
6. 当前版本已内置“回调失败自动无状态重试”（`steam-stateless`）。如果你日志中看到 `retry with openid.return_to + stateless strategy`，说明系统正在自动兜底处理该问题路径。
7. 若错误原因是 `Invalid or replayed nonce`，当前版本会优先触发 `check_authentication` 手动校验兜底（日志关键字：`manual nonce fallback`），不再先走一轮高概率无效的重复断言校验。
8. 若 `check_authentication` 仍失败，当前版本会进入“受限 replay-nonce 可信兜底”（日志关键字：`trusted replay nonce fallback`），仅在回调参数、Steam 端点、nonce 时间窗、session 发起时间窗都满足约束时放行。

示例：

```env
BASE_URL=http://localhost:5173
STEAM_REALM=http://localhost:5173/
STEAM_RETURN_URL=http://localhost:5173/api/auth/steam/return
# 反向代理头不稳定时建议显式指定
PUBLIC_BASE_URL=https://example.com
```

### `InternalOpenIDError: Failed to discover OP endpoint URL` / `connect ETIMEDOUT ...:443`

通常是本地网络无法直连 Steam OpenID。现在支持固定 OpenID 端点与可选代理：

1. 在 `.env` 中确认：
   - `STEAM_OPENID_PROVIDER=https://steamcommunity.com/openid`
2. 如果仍超时，配置代理（任选一种，示例端口 `26561`）：
   - `STEAM_PROXY_URL=http://127.0.0.1:26561`
   - 或 `STEAM_PROXY_PORT=26561`（默认主机为 `127.0.0.1`）
   - Clash 用户也可直接设 `MIXED_PROXY_PORT=26561` 或 `CLASH_MIXED_PORT=26561`
3. 本项目会优先尝试用户环境中的代理（`HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` 等），不再清空这些变量。
4. 重启服务 `npm run start`。

> 代理开启后，Steam 登录、OpenID 发现、公开库存读取都会走该代理。
> 如需显式指定代理，请优先设置 `STEAM_PROXY_URL`（例如 `http://127.0.0.1:26561`）。


这是依赖未安装或安装不完整导致的。请在 `steam-tradeup-web` 目录执行：

```bash
npm install
```

如果你之前在错误目录执行过命令，建议先确认当前路径正确，再重装依赖。仍有问题时可尝试：

```bash
rm -rf node_modules package-lock.json
npm install
```

Windows PowerShell 可用：

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
```

> 建议使用 Node.js LTS（20.x 或 22.x）。

如果你只开了 Clash 混合端口（例如 `26561`），但日志里还在连 `127.0.0.1:7890`，说明 npm 读到了旧代理配置。可在项目目录执行：

```bash
npm config delete proxy
npm config delete https-proxy
npm install
```

或直接使用本项目内置的 `.npmrc`（已默认指向 `http://127.0.0.1:26561`）。


## Steam 对接说明

1. 到 Steam 申请 Web API Key，填入 `.env` 的 `STEAM_API_KEY`。
2. 在 Steam OpenID 回调配置中，填写：
   - Realm: `http://localhost:5173/`
   - Return URL: `http://localhost:5173/api/auth/steam/return`
3. 点击页面 `Steam 登录（需后端）` 完成授权。

## 无登录读取库存（推荐）

如果你本地不好配置 Steam OpenID，可直接在前端输入交易链接（Trade Offer URL）：

1. 打开 Steam 客户端或网页，复制你的交易链接（形如 `https://steamcommunity.com/tradeoffer/new/?partner=...&token=...`）。
2. 粘贴到页面“通过交易链接读取库存”输入框。
3. 后端会通过 `steamcommunity.com/inventory/{steamId}/730/2` 拉取公开库存，并展示可交易状态/冷却提示。

> 注意：这种方式不需要登录，但仍依赖库存公开可见；且默认不会自动带出 float，需要结合 inspect 接口补全。

> 注意：Steam 官方库存 API 不稳定提供 float 值，因此 `server.js` 里已预留 CSFloat inspect 对接位。生产环境建议你把每件皮肤 inspect link 送去 CSFloat 接口，回填真实 float。

## 数据更新

```bash
npm run generate:data
```

脚本会从 `ByMykel/CSGO-API` 拉取最新 `skins.json` 并重建 `public/data/collection_skins.json`。


## 配置项放前端还是后端？

- **推荐**：把 `STEAM_API_KEY` 配在后端环境变量（`.env`），更适合长期部署。
- **临时排障**：可以在前端输入框填写 API Key，页面会保存在浏览器 localStorage，并在请求时带给当前后端。
- 任何密钥都不应暴露给不可信第三方页面；请只在你自己部署、可信来源的页面填写。

结论：本项目同时支持“后端 `.env` 固定配置”和“前端临时输入”两种方式；生产环境优先后端配置。
