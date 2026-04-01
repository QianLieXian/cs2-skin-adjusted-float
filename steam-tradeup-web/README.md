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
