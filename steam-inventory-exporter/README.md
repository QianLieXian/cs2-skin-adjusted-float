# CS2 Steam 库存导出工具（油猴 + 浏览器插件）

这个目录提供两种方式：

- `cs2-inventory-exporter.user.js`：Tampermonkey 油猴脚本。
- `extension/`：Chrome/Edge 手动加载扩展（Manifest V3）。

## 功能

在你的 Steam 库存页面（CS2 物品）右下角注入一个 **“导出 CS2 库存（JS）”** 按钮，点击后会导出：

- 物品名称、稀有度、收藏品、是否纪念品/StatTrak；
- 7 天交易限制相关标记（`cooldown` + `tradableAfter` 文本）；
- `inspectLink`（用于后续更精确磨损补全）；
- float：
  - 若页面里有直接值则记为 `inspect_link`；
  - 否则按 Exterior 做区间中位估算（`estimated_from_exterior`）；
  - 还拿不到则标记 `missing`。

导出文件为 `window.CS2_INVENTORY_EXPORT = {...};` 格式，可直接导入本项目前端。

## 1) 安装油猴脚本

1. 安装 Tampermonkey。
2. 新建脚本并粘贴 `cs2-inventory-exporter.user.js` 内容。
3. 保存后打开 Steam 库存页面：
   - `https://steamcommunity.com/profiles/<SteamID64>/inventory`
   - 或 `https://steamcommunity.com/id/<自定义ID>/inventory`
4. 点击右下角按钮导出 JS 文件。

## 2) 安装浏览器扩展

1. 打开 Chrome/Edge 扩展页，启用“开发者模式”。
2. “加载已解压的扩展程序”，选择 `steam-inventory-exporter/extension`。
3. 打开 Steam 库存页面并点击右下角导出按钮。

## 3) 导入到本项目前端

1. 打开 `steam-tradeup-web` 前端页面。
2. 在“Steam 库存授权与读取”区域找到“离线导入”。
3. 选择导出的 `.js` 文件并点击“导入本地库存文件”。
4. 成功后即可使用该库存做反向炼金磨损计算。

## 导出数据示例

```js
window.CS2_INVENTORY_EXPORT = {
  version: 1,
  source: 'steam_inventory_exporter',
  createdAt: '2026-04-02T06:00:00.000Z',
  steamId: '7656119xxxxxxxxxx',
  total: 58,
  cooldownCount: 7,
  items: [
    {
      id: '1234567890',
      marketHashName: 'AK-47 | Slate (Field-Tested)',
      floatValue: 0.265,
      floatSource: 'estimated_from_exterior',
      cooldown: true,
      tradableAfter: 'Tradable After Apr 08, 2026 (7:00:00) GMT',
      inspectLink: 'steam://rungame/730/...',
      eligibleForTradeup: true
    }
  ]
};
```
