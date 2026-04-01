# CS2 炼金磨损匹配 Web 工具

该目录是**独立子项目**，不会改动你原来的 Python 项目逻辑。

## 功能

- 支持目标磨损输入（0~1，最多 16 位小数）。
- 内置哈乐昆 / 攀升 / 寒带 / 热辐射 / 墨彩收藏品全部饰品数据（共 120 条，含每个饰品的最小/最大磨损）。
- 根据库存材料平均磨损，计算最接近目标值的输出饰品候选。
- 提供 Steam 登录与库存读取接口（需要配置 Steam API Key）。
- 支持直接粘贴交易链接读取公开库存（无需 Steam 登录），并标记交易冷却/限制中的物品。

## 快速启动

```bash
cd steam-tradeup-web
npm install
npm run start
```

打开 `http://localhost:5173`。

## 常见问题

### `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'`



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
2. 如果仍超时，配置代理（任选一种，示例端口 `25561`）：
   - `STEAM_PROXY_URL=http://127.0.0.1:25561`
   - 或 `STEAM_PROXY_PORT=25561`（默认主机为 `127.0.0.1`）
   - Clash 用户也可直接设 `MIXED_PROXY_PORT=25561` 或 `CLASH_MIXED_PORT=25561`
3. 本项目会优先尝试用户环境中的代理（`HTTPS_PROXY/HTTP_PROXY/ALL_PROXY` 等），不再清空这些变量。
4. 重启服务 `npm run start`。

> 代理开启后，Steam 登录、OpenID 发现、公开库存读取都会走该代理。
> 如需显式指定代理，请优先设置 `STEAM_PROXY_URL`（例如 `http://127.0.0.1:25561`）。


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

如果你只开了 Clash 混合端口（例如 `25561`），但日志里还在连 `127.0.0.1:7890`，说明 npm 读到了旧代理配置。可在项目目录执行：

```bash
npm config delete proxy
npm config delete https-proxy
npm install
```

或直接使用本项目内置的 `.npmrc`（已默认指向 `http://127.0.0.1:25561`）。


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

- `STEAM_API_KEY` 必须放后端环境变量（`.env`），**不要放前端页面**。
- 任何密钥（Steam Web API Key、第三方 token、代理账号密码）都不应出现在前端，因为前端代码和网络请求对用户是可见的。
- 前端可以填写的是**非敏感参数**（例如交易链接、目标磨损值、筛选条件）。

结论：这个项目里，Steam API Key 只需要后端配置，前端没有必要也不应该提供输入框。
