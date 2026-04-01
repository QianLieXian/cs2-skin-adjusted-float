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
