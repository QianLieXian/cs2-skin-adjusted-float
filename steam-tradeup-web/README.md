# CS2 炼金磨损匹配 Web 工具

该目录是**独立子项目**，不会改动你原来的 Python 项目逻辑。

## 功能

- 支持目标磨损输入（0~1，最多 16 位小数）。
- 内置哈乐昆 / 攀升 / 寒带 / 热辐射 / 墨彩收藏品全部饰品数据（共 120 条，含每个饰品的最小/最大磨损）。
- 根据库存材料平均磨损，计算最接近目标值的输出饰品候选。
- 提供 Steam 登录与库存读取接口（需要配置 Steam API Key）。

## 快速启动

```bash
cd steam-tradeup-web
cp .env.example .env
npm install
npm run start
```

打开 `http://localhost:5173`。

## Steam 对接说明

1. 到 Steam 申请 Web API Key，填入 `.env` 的 `STEAM_API_KEY`。
2. 在 Steam OpenID 回调配置中，填写：
   - Realm: `http://localhost:5173/`
   - Return URL: `http://localhost:5173/api/auth/steam/return`
3. 点击页面 `Steam 登录（需后端）` 完成授权。

> 注意：Steam 官方库存 API 不稳定提供 float 值，因此 `server.js` 里已预留 CSFloat inspect 对接位。生产环境建议你把每件皮肤 inspect link 送去 CSFloat 接口，回填真实 float。

## 数据更新

```bash
npm run generate:data
```

脚本会从 `ByMykel/CSGO-API` 拉取最新 `skins.json` 并重建 `public/data/collection_skins.json`。
