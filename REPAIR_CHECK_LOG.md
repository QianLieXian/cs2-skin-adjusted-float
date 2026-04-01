# 修复检查日志（2026-04-01）

## 背景
- 问题：交易链接读取失败，报错 `connect ECONNREFUSED 127.0.0.1:7890`。
- 目标：确保代理优先使用显式配置（例如 7897），并避免被系统环境变量中的 7890 意外覆盖。

## 五轮检查记录

### 第 1 轮：错误入口定位
- 检查了前端错误来源：`public/script.js` 将后端返回的 `error.message` 原样显示为“交易链接读取失败：...”。
- 结论：真正根因在后端代理连接，不在前端提示逻辑。

### 第 2 轮：代理候选顺序检查
- 检查了 `resolveSteamProxyCandidates()` 的候选组装顺序。
- 发现原逻辑会优先加入系统代理（`HTTP_PROXY/HTTPS_PROXY`），导致 7890 可能先被选中。
- 风险：即使你设置了 `STEAM_PROXY_PORT=7897`，仍可能先命中 7890。

### 第 3 轮：回退路径与可达性检查
- 检查了 `isProxyReachable()` 与“首个可达代理即采用”的策略。
- 发现：一旦 7890 在系统变量中可达，就会被优先采纳，造成行为与用户预期不一致。

### 第 4 轮：HTTP 客户端代理继承检查
- 检查了 axios 初始化。
- 发现原来 `proxy` 可能是 `undefined`，在部分场景可能继承系统代理环境变量。
- 风险：即使全局代理选择正确，个别请求仍可能走错代理。

### 第 5 轮：修复有效性复查
- 修复后再次核对：
  1. 优先级：`STEAM_PROXY_URL` > 固定端口（`STEAM_PROXY_PORT` / `MIXED_PROXY_PORT` / `CLASH_MIXED_PORT`）> 系统代理。
  2. 仅在显式/固定端口都缺失时，或设置 `STEAM_USE_SYSTEM_PROXY=true` 时，才引入系统代理候选。
  3. axios 在没有选中代理时明确 `proxy: false`，禁止隐式继承系统代理。
- 结论：已消除“明明配了 7897 却仍报 7890”的主要代码路径。

## 改动摘要
- 文件：`steam-tradeup-web/server.js`
- 关键修复：
  - 重排代理候选来源并分组（显式、固定端口、系统）。
  - 调整系统代理的启用条件（仅在必要时启用）。
  - 为 axios 添加 `proxy: proxyConfig ?? false`。

## 后续建议（每次启动前）
1. 检查 `.env` 是否设置 `STEAM_PROXY_URL=http://127.0.0.1:7897`（推荐）。
2. 若只用端口，确保 `STEAM_PROXY_PORT=7897` 且 `STEAM_PROXY_HOST=127.0.0.1`。
3. 非必要不要开启 `STEAM_USE_SYSTEM_PROXY=true`。
4. 启动日志确认是否出现：`Global proxy enabled ... 7897`。

---

## 2026-04-01（OpenID 断言校验失败 + 交易链接 400）

### 问题现象
- 登录报错：`InternalOpenIDError: Failed to verify assertion`。
- 读取交易链接报错：`Request failed with status code 400`。

### 本轮排查与修复
1. **修正 Steam OpenID 默认 Provider 地址**
   - 从 `https://steamcommunity.com/openid` 调整为 `https://steamcommunity.com/openid/login`，避免 Provider 端点不完整导致断言校验失败。

2. **增强 BASE_URL 处理，避免 realm / returnURL 不一致**
   - 新增 `normalizeBaseUrl()`，统一清理尾部 `/`、query、hash。
   - 默认 `realm` 与 `returnURL` 由规范化后的 BASE_URL 计算。

3. **按请求动态构建 OpenID 回调参数（兼容反向代理）**
   - 新增 `resolveRequestBaseUrl()` + `buildSteamAuthOptions()`。
   - 在 `/api/auth/steam` 与 `/api/auth/steam/return` 两个路由中都传入动态 `realm` / `returnURL`。
   - 启用 `app.set('trust proxy', true)`，在 Nginx/面板代理后可正确识别 `x-forwarded-proto/host`。

4. **提升交易链接容错**
   - `parseTradeUrl()` 增加 URL 解码与协议补全（支持用户粘贴不带 `https://` 的链接）。

5. **优化 Steam 库存 400 错误提示**
   - 当 Steam inventory API 返回 400 时，后端转换为更明确的业务提示：
     - 交易链接可能无效；或
     - 目标账号库存非公开。

### 下次排障建议
- 若仍遇到 OpenID assertion 失败，优先核对：
  1. 反向代理是否透传 `Host` 和 `X-Forwarded-Proto`。
  2. 实际访问域名是否与 Steam 开始登录时域名一致（中途换域名会导致校验失败）。
  3. `BASE_URL` 是否与外网访问地址一致（仅在你显式设置 `STEAM_REALM/STEAM_RETURN_URL` 时强依赖）。
- 若交易链接仍 400：
  1. 检查链接是否来自 `steamcommunity.com/tradeoffer/new/...`。
  2. 检查对方库存与个人资料是否公开。

---

## 2026-04-01（OpenID `Failed to discover OP endpoint URL`）

### 问题现象
- 访问 `/api/auth/steam` 后，服务端报错：`InternalOpenIDError: Failed to discover OP endpoint URL`。
- 日志中可见 realm/returnURL 已按反向代理域名构建，但 OpenID Provider 发现阶段失败。

### 本轮修复
1. **修正 OpenID Provider 默认值为登录端点**
   - 将默认 `STEAM_OPENID_PROVIDER` 从 `https://steamcommunity.com/openid` 调整为 `https://steamcommunity.com/openid/login`。
   - 同步调整 `normalizeOpenIdProvider()`：优先规范到 `/openid/login`，避免默认落在发现兼容性较差的路径。

2. **新增 Provider 候选与自动回退**
   - 新增 `getOpenIdProviderCandidates()`，自动构造主端点与回退端点（`/openid/login` ↔ `/openid`）。
   - 当捕获到 `Failed to discover OP endpoint URL` 时，自动切换到下一候选 Provider 并重试一次，降低单一路径失败概率。

3. **增强排障日志**
   - 在 Steam 登录启动日志中新增 `providerURL` 字段，便于确认当前实际使用的 OpenID Provider。

### 结果
- 代码层面已补齐“默认端点 + 回退重试 + 可观测性”三项能力，可覆盖你日志中的发现失败场景。
- 若仍失败，优先检查运行主机是否可连通 `steamcommunity.com`（DNS、TLS、出口代理、面板防火墙）。

---

## 2026-04-01（混合端口修正 + OpenID 发现失败 + 交易链接 ETIMEDOUT）

### 问题现象
- 启动日志提示代理回退到 `http://127.0.0.1:25561/`，但你的混合端口实际是 **26561**。
- Steam 登录报错：`InternalOpenIDError: Failed to discover OP endpoint URL`。
- 交易链接读取偶发超时：`connect ETIMEDOUT 31.13.94.49:443`。

### 本轮修复
1. **修正默认混合端口为 26561**
   - 在未显式设置 `STEAM_PROXY_PORT/MIXED_PROXY_PORT/CLASH_MIXED_PORT` 时，自动补入默认候选 `127.0.0.1:26561`。
   - 避免误走 25561 导致“代理不可达→直接连接”的错误判断。

2. **修正 OpenID 默认 Provider 策略**
   - 默认 Provider 改回 `https://steamcommunity.com/openid`（发现流程更稳定）。
   - 仍保留候选回退：`/openid` 与 `/openid/login` 双端点自动切换，遇到 discover 失败时自动尝试下一候选。

3. **修复交易链接读取超时路径**
   - axios 客户端统一设置 `proxy: false`，防止隐式继承系统环境代理。
   - 新增请求级“代理失败后直连重试”逻辑：当代理链路报 `ETIMEDOUT/ECONNRESET/ECONNREFUSED/EHOSTUNREACH/ENETUNREACH` 时，自动直连重试一次。

### 结果
- 默认端口与本地混合端口预期一致（26561）。
- OpenID 发现失败场景增加了更稳的默认端点和自动回退。
- 交易链接读取在代理不稳定时具备自动降级直连能力，降低 `ETIMEDOUT` 直接失败概率。
