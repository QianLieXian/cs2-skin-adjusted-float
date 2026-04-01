# 修复检查日志（2026-04-01）

## 2026-04-01（再修：float 全缺失，CSFloat 域名切换导致请求全失败）

### 问题现象
- 你当前统计显示：`精确 float = 0`、`估算 float = 0`、`float 缺失 = 58`，即“全缺失”。
- 库存条目本身已读到（总数/可炼金/字典命中都有值），说明主要失败点在“inspect -> float 补全链路”而非库存读取。

### 根因判断
1. **默认 inspect API 域名过旧**
   - 代码默认使用 `https://api.csfloat.com`。
   - 该域名在部分环境已无法解析（DNS `ENOTFOUND`），导致 `GET /?url=...` 与 `POST /bulk` 全量失败。
2. **缺少多端点自动回退**
   - 旧逻辑只有单一 `CSFLOAT_INSPECT_API`，端点失效时会直接导致全量 float 缺失。

### 本轮修复
1. **默认域名切换**
   - `CSFLOAT_INSPECT_API` 默认值由 `https://api.csfloat.com` 改为 `https://api.csgofloat.com`。

2. **新增 inspect API 候选链路**
   - 新增 `CSFLOAT_INSPECT_API_FALLBACKS`（逗号分隔）环境变量。
   - 运行时自动构建候选列表并去重，默认内置：
     - `CSFLOAT_INSPECT_API`
     - `https://api.csgofloat.com`
     - `https://api.csfloat.com`

3. **单条与批量请求都支持逐端点回退**
   - `GET /?url=...`（单条）失败后自动尝试下一个候选端点。
   - `GET /?s|m + a + d`（参数模式）同样回退。
   - `POST /bulk` 按候选端点依次尝试，避免单域名异常时整批落空。

4. **接口响应增加可观测性**
   - 返回中新增 `inspectApiCandidates`，前端/日志可直接看到当前后端采用的 inspect 端点优先级，便于后续排障。

### 结果
- 当某个 CSFloat 域名不可解析或不可用时，不再导致“全量 float 缺失”。
- float 补全链路从“单点依赖”升级为“多端点容灾”，可显著降低再次出现 `exactFloatCount = 0` 的概率。

## 2026-04-01（再修：已登录库存报 `URI malformed` 导致整链路误判失败）

### 问题现象
- 你提供的日志里 `/api/inventory` 连续报：
  - `Inventory fetch failed via community ... message: 'URI malformed'`
  - 随后才继续走 `econ_service_empty / legacy_econitems(410)`，最终 500。
- 这会误导为“社区库存读取失败”，但实际上是后处理阶段被异常打断。

### 根因判断
1. **inspect 链接解析过于脆弱**：`parseInspectLinkParams` 直接 `decodeURIComponent`，当库存中出现不规范 `%` 编码时会抛 `URI malformed`。
2. **异常边界不清晰**：该异常发生在库存增强（float 补全）阶段，但会沿调用栈冒泡到 `/api/inventory`，被记录为 `community` 失败，掩盖真实根因。
3. **公开库存链路同类风险**：`parseTradeUrl` 也使用直接解码，存在同类输入触发点。

### 本轮修复
1. **新增安全解码器 `safeDecodeURIComponent`**
   - 首次按标准 `decodeURIComponent`；
   - 失败后自动修复“非法 `%`”再解码；
   - 再失败则回退原字符串，避免整链路崩溃。

2. **inspect 参数解析切换到安全解码**
   - `parseInspectLinkParams` 改为使用安全解码，不再因单条异常 inspect 链接导致整次库存读取失败。

3. **float 单条补全增加防护**
   - `resolveFloatFromInspectLink` 对 inspect 参数解析增加兜底，保证“单个链接坏数据”只影响该条目的 float，不影响整个接口响应。

4. **交易链接解析同步加固**
   - `parseTradeUrl` 同步切到安全解码，减少用户粘贴非标准编码链接时的解析失败概率。

### 结果
- `URI malformed` 不再中断库存主流程。
- 即便存在异常 inspect/交易链接，也会降级为“单条 float 缺失或链接无效”，不会拖垮整批库存接口。
- 日志诊断与真实失败源更一致，避免再次出现“修了很多次但根因其实一直是解码异常”的重复返工。

## 2026-04-01（再修：API Key 404 + 全量 float 缺失）

### 问题现象
- 前端调用 `/api/inventory/by-api-key` 返回 404（即使 steamId/key 已填写）。
- 库存读取成功但 `float 缺失` 接近 100%，`exactFloatCount = 0`。

### 根因判断
1. **API Key 直连接口过于“单链路”**：仅依赖 `IEconService`，一旦返回 0 就直接 404，没有继续尝试社区库存或旧接口。
2. **inspect 查询容错不足**：仅使用 `?url=<inspect_link>` 单一模式请求 CSFloat，部分链接/返回形态下无法命中 float。
3. **缺少批量探测**：大量单条 inspect 请求在代理不稳时更容易全部超时，导致“全缺失”。

### 本轮修复
1. **`/api/inventory/by-api-key` 增加完整回退链**
   - 优先：`IEconService/GetInventoryItemsWithDescriptions`
   - 回退 1：`steamcommunity /inventory/{steamId}/730/2`
   - 回退 2：`IEconItems_730/GetPlayerItems`
   - 三条都失败时返回 404，并附带 `fallbackErrors` 明细，避免“只有一句读取失败”。

2. **inspect float 增加“双通道”解析**
   - 先走 `?url=<inspect_link>`；
   - 若未取到 float，再解析 inspect link 中的 `S/M + A + D` 参数，改用 `?s/?m + a + d` 方式重试。

3. **增加 CSFloat `/bulk` 批量预取**
   - 缺失 float 项先按 inspect link 去重，分块调用 `/bulk` 批量拿 float。
   - 批量未命中时再落回单条请求，兼顾成功率与响应速度。

### 结果
- API Key 读取不再因为单链路空结果立刻失败，诊断信息更完整。
- inspect float 覆盖率提升，`exactFloatCount` 在可获取场景下显著高于之前版本。

## 2026-04-01（再修：API Key + 交易链接读取“卡住/float 缺失/代理反复 ECONNRESET”）

### 问题现象
- 点击“通过 API Key 直接读取库存”或“交易链接读取公开库存”时体感很慢，日志反复出现：
  - `Request via proxy failed (ECONNRESET), retry direct connection: https://api.csfloat.com`
- 接口最终虽然 200，但耗时很长（例如 80s+）。
- 前端仍显示较多 `float 缺失`。

### 根因判断
1. **代理失败会在每个请求重复触发**：当前逻辑是“每次先走代理，失败后再直连”。当代理到 `api.csfloat.com` 持续不稳定时，会给每个 inspect 请求都额外增加一次失败重试成本。
2. **缺少同批次 inspect 去重**：同一次库存读取中，如果 inspect link 重复，会重复请求 CSFloat，造成不必要的等待。
3. **`/api/inventory/public` 未利用 `apiKey` 做数量补强**：即使前端传了 `apiKey`，公开库存接口也只走社区库存链路，不能借助 IEconService 在数量上做纠偏。

### 本轮修复
1. **新增“代理失败主机直连旁路”**
   - 当某个主机（如 `api.csfloat.com`）首次发生 `ECONNRESET/ETIMEDOUT/...` 后，记录该主机进入旁路名单。
   - 后续同主机请求直接走直连，不再每次“先失败一次再重试”。
   - 仅首个旁路事件打印一次说明日志，避免刷屏。

2. **同批次 inspect 浮点请求去重**
   - 在 `resolveMissingFloats` 内新增 `inspectFloatCache`（按 inspectLink 缓存本次结果）。
   - 同一批读取中重复 inspectLink 直接复用结果，减少 CSFloat 请求数与耗时。

3. **公开库存接口接入 API Key 对比增强**
   - `/api/inventory/public` 现在会在传入 `apiKey` 时，额外尝试 `IEconService`。
   - 若 `IEconService.total > community.total`，自动切换到 API 结果并返回说明 `note`。
   - 目标是降低“公开库存链路结果偏少导致 float 缺失更多”的概率。

### 结果
- 代理不稳定时不会再对同一目标主机重复付出“代理失败重试”开销，库存读取响应会更稳。
- 同批次重复 inspect 请求显著减少，降低长尾耗时。
- 交易链接读取在提供 API Key 时可自动做数量纠偏，减少“看起来读到了但缺项多”的问题。

## 2026-04-01（精确 float 强制模式 + API Key 直连读取按钮）

### 问题现象
- 你反馈库存列表里大量磨损值尾部全是 `0`，并且标注“估算”，无法满足“准确到真实磨损”的需求。
- 你要求新增“前端填写后点击按钮，用 Steam Web API Key 直接获取饰品信息”的能力。

### 根因判断
1. 旧版本会在拿不到真实 float 时，按外观区间做中位估算（`estimated_from_exterior`），因此常出现类似 `0.1610000000000000` 的模式化值。
2. API Key 虽然可随请求传入，但前端没有独立“API Key 直连读取”按钮，用户流程不够清晰。

### 本轮修复
1. **禁用外观估算 float，改为“只展示精确值”**
   - 删除库存增强阶段的“按外观估算磨损”逻辑。
   - 现在仅两种有效来源：
     - `api`：上游接口直接返回 float
     - `csfloat_inspect`：通过 inspect link 调 CSFloat 获取真实 float
   - 若都拿不到则明确为 `float 缺失`，不再伪造估算值。

2. **新增 API Key 直连按钮（无需 Steam 登录会话）**
   - 前端新增：
     - `SteamID64` 输入框
     - “通过 API Key 直接读取库存”按钮
   - 后端新增接口：
     - `GET /api/inventory/by-api-key?steamId=<SteamID64>&apiKey=<key>`
   - 该接口直接走 `IEconService` 拉取库存，再走 inspect 浮点补全链路。

3. **代码复用与错误信息优化**
   - 抽取 `buildInventoryResponse` 统一附带 `inspectApi/note` 字段，减少重复分支。
   - API Key 直连失败时给出更明确提示（steamId 格式、key 缺失、403 权限/域名绑定等）。

### 结果
- 前端不再把估算值伪装成真实值；库存磨损要么精确、要么明确缺失。
- 你可以在页面直接填 API Key + SteamID64，点击按钮独立读取库存，不依赖 Steam 登录流程。

## 2026-04-01（库存精确 float / 冷却库存数量 / 汰换品级规则再修）

### 问题现象
- 你反馈“库存里很多 float 仍是估算，不是精确值”。
- 你反馈“库存总数只显示几十件，和真实库存（含交易冷却）不一致”。
- 你反馈“合成逻辑看起来像什么品级都能混合”。

### 根因判断
1. **inspect link 提取过窄**：之前主要从 `actions` 里找 `Inspect in Game`，会漏掉部分在 `owner_actions/market_actions` 里的检视链接，导致 CSFloat 精确查询命中率偏低。
2. **已登录库存优先链路仍可能偏少**：`steamcommunity inventory` 在部分账号/网络场景会出现数量偏少（常见是冷却/限制物品可见性差异），而旧逻辑即使拿到较少结果也直接返回。
3. **legacy 回退历史截断**：`IEconItems_730` 回退路径还残留了 `.slice(0, 200)` 的历史截断，可能进一步压低数量。
4. **汰换品级规则核对**：前端反推已按“目标下一级输入品级”过滤（`it.rarity === previousRarity`），本轮再次核对并保留该强约束，继续按 V 社 CS 逻辑执行。

### 本轮修复
1. **扩大 inspect link 提取范围，提升精确 float 覆盖**
   - 新增统一检视链接提取器：
     - 依次扫描 `owner_actions` / `actions` / `market_actions`
     - 同时匹配 `Inspect in Game` 和 `csgo_econ_action_preview`
     - 处理 `&amp;`、`%owner_steamid%`、`%assetid%` 替换
   - 结果：更多库存条目可走 CSFloat 检视接口拿到精确磨损值（`floatSource=csfloat_inspect`）。

2. **已登录库存新增“数量优先”对比策略（覆盖冷却库存）**
   - 在主链路 `steamcommunity inventory` 成功后，如果本次请求提供了 API Key，会再拉取 `IEconService` 结果做数量对比。
   - 当 `IEconService.total > community.total` 时，优先返回 `IEconService` 结果，并明确标注该来源更可能覆盖冷却/限制物品。
   - 结果：减少“我真实库存很多，但页面只显示几十件”的情况。

3. **移除 legacy 回退 200 件硬截断**
   - 删除 `IEconItems_730` 回退链路中的 `.slice(0, 200)`。
   - 结果：即使走 legacy 回退，也不会再被前端历史截断逻辑限制。

### 结果
- “精确 float”占比提升（inspect link 命中更完整）。
- “库存总数偏少”问题有了主动纠偏策略（community 与 IEconService 对比取更全）。
- 汰换规则继续按“同输入品级（目标下一级）”执行，不允许跨品级混合。

## 2026-04-01（库存数量/未知收藏/float 缺失/纪念品与冷却拆分修复）

### 问题现象
- 账号实际库存约 279，但前端只显示读取了 58，用户无法判断“总库存”和“可用于炼金库存”的差异。
- 大量条目显示“未知收藏 / 未知品质”。
- 大量条目显示“float 缺失”导致无法参与反推。
- “冷却/限制”与“纪念品不可合成”混在一起展示，误导了冷却中的非纪念品材料。

### 根因判断
1. `market_hash_name` 与字典键不一致（`Souvenir`/`StatTrak™` 前缀、外观后缀），导致字典匹配失败，前端只能显示“未知收藏/未知品质”。
2. Steam 社区库存接口通常不直接返回 float，未补全时大量条目 float 为空。
3. 前端文案把“读取库存材料”与“总库存”混为一条，且状态标签粒度不够。

### 本轮修复
1. **后端引入本地字典增强**
   - 启动时读取 `public/data/collection_skins.json` 构建 `skinDictionary`。
   - 对库存名统一归一化（去除 `Souvenir`/`StatTrak™` 前缀与外观后缀）后匹配收藏与品质。

2. **float 缺失补全策略**
   - 保留 API 原始 float（`floatSource=api`）。
   - 当 API 无 float 时，按外观（崭新出厂/略有磨损/久经沙场/破损不堪/战痕累累）在该皮肤最小-最大磨损区间内估算中位值（`floatSource=estimated_from_exterior`）。
   - 仍无外观信息时保留缺失（`floatSource=missing`）。

3. **材料统计与状态拆分**
   - 返回并展示：
     - `total`（总库存）
     - `materialCount`（可用于炼金，默认排除纪念品）
     - `dictionaryMatchedCount`（字典命中）
     - `missingFloatCount`（float 缺失）
   - 标签拆分为：`交易冷却/限制`、`纪念品（不可合成）`、`非纪念品`、`StatTrak™`，不再把纪念品与冷却混说成一个原因。
   - 反推计算时仅排除纪念品，冷却中的非纪念品仍可参与计算。

### 结果
- 前端能同时看到“总库存”和“可用材料”，不再被单一计数误导。
- 字典命中率明显提高，未知收藏/品质显著减少。
- float 缺失大幅下降；缺失项会明确标注来源，避免把估算值当作真实值。
- 冷却与纪念品状态已拆分，冷却非纪念品可继续用于炼金计算。

## 2026-04-01（再修：Steam 社区库存 400，已登录仍显示 0）

### 问题现象
- 日志中主库存接口稳定报错：`/inventory/{steamId}/730/2(400)`。
- 用户已成功登录、并填写 API Key，但最终仍因回退链路空结果/失效而显示 0。

### 根因判断
1. 社区库存请求 `count` 使用了 `5000`，在部分 Steam 出口/策略下会直接 400。
2. 已登录读取与交易链接读取都走了同样的大分页参数，导致两条链路都可能触发同一类 400。
3. 社区库存未做真正分页游标抓取（`start_assetid`），大库存账号命中边界时可用性差。

### 本轮修复
1. **社区库存分页参数修正**
   - 将 `count` 从 `5000` 调整为 `2000`（更稳妥）。
   - 新增 `start_assetid` 分页抓取，最多 8 页，自动聚合去重。

2. **已登录库存链路支持完整分页**
   - `/api/inventory` 的 `steamcommunity/inventory` 主链路改为分页读取，不再单次拉满。
   - 仍保留旧 JSON 端点回退，并同步下调其 `count` 参数到 2000。

3. **交易链接库存链路同步修复**
   - `/api/inventory/public` 改为同样的分页模式（`count=2000 + start_assetid`）。
   - 若首次 400，仍会带 `trade_offer_access_token` 自动重试，但改为分页重试。

### 结果
- 降低了由单次大 `count` 参数触发的 Steam 400 概率。
- 大库存账号可按游标持续读取，不再依赖一次性返回。
- 与你当前报错（已登录+有库存但返回 400/0）直接相关的链路已针对性修复。

## 2026-04-01（再修：已登录 + 已填 API Key 但库存仍显示 0）

### 问题现象
- 你的日志里 `/api/inventory` 在 `community` 失败后返回了 `source: econ_service_api, total: 0`。
- 前端展示“库存来源 econ_service_api，总数 0”，造成“看起来成功但没有库存”的误导。

### 根因判断
1. `/api/inventory` 只要 `IEconService` 调用成功（HTTP 200）就直接返回，即使 `items` 实际为 0。
2. `steamcommunity /inventory` 在某些代理/IP/可见性场景会返回 400，当前仅一个社区端点，容错不足。
3. 对 “回退成功但结果为空” 缺少防误判策略，导致重复出现“修了但还是 0”。

### 本轮修复
1. **社区库存双端点回退**
   - 已登录库存读取新增双路径：
     - `https://steamcommunity.com/inventory/{steamId}/730/2`
     - `https://steamcommunity.com/profiles/{steamId}/inventory/json/730/2`（旧 JSON 端点）
   - 第一条失败会自动尝试第二条，提升在特定网络环境下的成功率。

2. **IEconService 结果状态校验**
   - 新增 `assertEconServiceResult()`，当 `result.status != 1` 时不再把请求当成功。
   - 避免“接口返回了错误状态但仍被当作正常库存结果”的情况。

3. **空结果不再伪成功**
   - `IEconService` 与 `IEconItems_730` 回退结果为 0 时不再立即返回“成功”。
   - 会继续尝试下一条回退，并把 `*_empty` 记录进 `fallbackErrors`，最终明确给出失败原因和排障方向。

4. **错误提示增强**
   - 400/403 场景提示加入“代理出口 IP 可能被 Steam 风控”的说明，便于你快速判断是否是网络出口问题。

### 结果
- 现在不会再出现“source=econ_service_api 且 total=0 但被当成功”的假阳性结果。
- 日志里会明确记录每个回退路径（包括“空结果”）的失败原因，排障会更直接。
- 在社区接口不稳定时，会多尝试一条旧 JSON 库存路径，提高读取成功概率。

## 2026-04-01（再次复修：已登录但 `/api/inventory` 500、库存仍显示 0）

### 问题现象
- 日志显示 Steam 登录成功（含 replay nonce fallback 放行），`/api/session` 返回 200。
- 但随后 `/api/inventory` 返回 500，前端仍显示库存 0。
- 用户点击刷新、导出日志体感“没变化”。

### 根因判断
1. 已登录库存主链路 `steamcommunity inventory` 一旦失败，当前版本仅尝试了非常旧的 `IEconItems_730` 回退，覆盖率不足。
2. 库存失败时后端日志缺少“每个回退链路失败原因”的结构化输出，前端也看不到完整失败链。
3. 前端对 `/api/session`、`/api/inventory`、`/api/logs/export` 读取未显式禁用缓存，容易出现“看起来没刷新”的错觉。

### 本轮修复
1. **新增第二回退链路（IEconService）**
   - 在 `/api/inventory` 中加入 `IEconService/GetInventoryItemsWithDescriptions/v1/` 回退（支持分页）。
   - 顺序调整为：
     - 主链路：`steamcommunity inventory`
     - 回退 1：`IEconService/GetInventoryItemsWithDescriptions`
     - 回退 2：`IEconItems_730/GetPlayerItems`（legacy）

2. **统一资产解析器并增强兼容**
   - 新增通用的 `assets + descriptions` 解析函数，社区库存与 IEconService 共用同一套解析逻辑。
   - 输出字段保持一致（`id/marketHashName/iconUrl/inspectLink/tradable/cooldown`）。

3. **失败链路可观测性增强**
   - `/api/inventory` 每次回退失败都记录结构化日志（source/status/message）。
   - 500 响应新增 `fallbackErrors` 字段，前端可直接展示每条失败路径。

4. **前端刷新/会话/日志导出禁用缓存**
   - 对 `/api/session`、`/api/inventory`、`/api/inventory/public`、`/api/logs/export` 统一使用：
     - `credentials: 'include'`
     - `cache: 'no-store'`
   - 降低浏览器缓存导致的“刷新无感知”与状态陈旧问题。

### 结果
- 登录后库存读取在主链路失败时，新增一层更可用的 API 回退，减少直接 500 的概率。
- 当仍失败时，用户端可直接看到完整失败链原因（不再只有一句“失败”）。
- 刷新与日志导出行为更稳定，不再依赖浏览器缓存策略。

## 2026-04-01（库存 0 件复修 + 刷新按钮 + 日志导出）

### 问题现象
- 已登录后显示：`库存来源：auth，总数：0`，与账号实际有饰品不一致。
- 已填写 Steam Web API Key，但看起来“没作用”。
- `npm run start -- --verbose` 的输出不够完整，不方便远程排障。

### 根因判断
1. 旧的 `/api/inventory` 主链路依赖 `IEconItems_730/GetPlayerItems`，该接口在 CS2 场景经常返回空或不完整数据。
2. 前端缺少“已登录库存手动刷新”入口，用户登录后只能靠初始化时自动拉一次。
3. 后端日志只能看控制台滚动输出，缺少导出能力，不利于反复定位 OpenID/库存链路问题。

### 本轮修复
1. **登录库存读取主链路切换**
   - `/api/inventory` 现在优先读取 `steamcommunity.com/inventory/{steamId}/730/2`。
   - 仅当主链路失败且提供了 `STEAM_API_KEY` 时，才回退到 legacy `IEconItems_730` 接口。
   - 返回信息增加更明确提示：当社区库存返回 400/403 时，提示检查库存公开性或改用交易链接读取。

2. **前端新增“刷新已登录库存”按钮**
   - 不需要重新走 Steam 登录，点击即可重新拉取当前会话的库存。

3. **新增后端日志导出能力**
   - 服务器启动后将日志写入内存环形缓冲区。
   - 新增接口：
     - `GET /api/logs`：查看近期日志（JSON）
     - `GET /api/logs/export`：导出日志文件（txt 下载）
   - 前端新增“导出后端日志”按钮，可一键下载运行日志。

4. **增强 `--verbose` 可观测性**
   - 启动参数含 `--verbose` 时，新增 HTTP 请求级日志（开始/结束、状态码、耗时、requestId）。

### 结果
- “我有饰品但显示 0”这一主路径已改用更可靠的社区库存接口。
- API Key 不再是登录库存读取的唯一前提；仅作为失败后的 legacy 回退。
- 排障链路从“看控制台”升级为“按钮导出完整日志”，便于后续复盘与持续修复。

## 2026-04-01（端口一致性复修：`.npmrc`/文档全部改为 26561）

### 问题现象
- 你已多次明确本地 Clash 混合端口是 **26561**，但项目里仍残留 `25561`：
  - `steam-tradeup-web/.npmrc` 默认代理仍指向 `127.0.0.1:25561`。
  - `README` 多处示例仍写 `25561`，容易误导后续排障与部署。
  - 后端一条代理格式告警示例也沿用了 `25561`。

### 本轮修复
1. **修正内置 npm 代理默认端口**
   - `.npmrc` 的 `proxy` / `https-proxy` 从 `25561` 统一改为 `26561`。

2. **同步更新 README 全部示例端口**
   - `STEAM_PROXY_URL`、`STEAM_PROXY_PORT`、`MIXED_PROXY_PORT`、`CLASH_MIXED_PORT` 相关示例全部切到 `26561`。
   - “使用本项目内置 `.npmrc`”说明同步改为 `http://127.0.0.1:26561`。

3. **修正后端告警文案示例端口**
   - `server.js` 中代理格式提示示例端口改为 `26561`，避免日志继续出现旧端口引导。

### 结果
- 项目内“默认/示例/提示”端口现已与您的实际混合端口 **26561** 一致。
- 后续你或我再次按文档/日志操作时，不会再被 `25561` 误导。

---

## 2026-04-01（前端补充 Steam Web API Key 输入能力）

### 问题现象
- 历史版本多次要求在后端 `.env` 写死 `STEAM_API_KEY`，导致你每次换环境/容器都得重复改配置。
- 页面没有直接填 Key 的入口，排障时反馈“修过很多次还是用不了”。

### 本轮修复
1. **前端新增 API Key 输入框（可直接使用）**
   - 在“Steam 库存授权与读取”区域新增 `Steam Web API Key` 输入框。
   - 输入后会保存到浏览器 `localStorage`，后续刷新页面自动回填。
   - 请求库存接口时自动附带 `apiKey` 参数，优先用于本次请求。

2. **增加“如何获取我的 API Key”超链接**
   - 输入框下方新增官方入口：`https://steamcommunity.com/dev/apikey`（新窗口打开）。

3. **后端支持“请求级 API Key 覆盖”**
   - `/api/inventory` 新增优先级：`query.apiKey` > `x-steam-api-key` > `.env` 的 `STEAM_API_KEY`。
   - 当 `.env` 未配置但前端提供了 Key，库存读取仍可正常调用 Steam 接口。
   - 缺少 Key 时返回更明确提示：可在前端填写后重试。

### 结果
- 不再强依赖你每次都改服务器 `.env` 才能读取库存。
- 你可以先前端填 Key 验证链路，再决定是否固化到后端配置。

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

---

## 2026-04-01（Steam 登录回调错误落到 localhost）

### 问题现象
- 用户从外网域名发起 Steam 登录，但授权后回调 URL 仍显示为：
  - `http://localhost:5173/api/auth/steam/return?...`
- 结果：OpenID 回调域名与实际访问域名不一致，登录流程中断。

### 根因分析
1. **环境变量显式配置了 localhost**
   - 当 `BASE_URL` / `STEAM_REALM` / `STEAM_RETURN_URL` 设置为 localhost 时，服务端会优先使用该固定值。
2. **规范主机重定向在 localhost 配置下可能误触发**
   - 若 canonical host 取自 localhost，外网访问时重定向策略会干扰实际回调域名。

### 本轮修复
1. **新增 localhost 配置保护逻辑**
   - 在 `buildSteamAuthOptions()` 中新增“显式配置为 localhost + 当前请求是公网域名”检测。
   - 命中该场景时，自动改用当前请求动态构建的 `realm/returnURL`，避免继续把回调写成 localhost。

2. **优化 canonical redirect 触发条件**
   - 在 `getCanonicalRedirect()` 中新增判断：如果 canonical host 本身是 localhost，则不执行强制 canonical 重定向。
   - 避免公网域名请求被重定向到 localhost。

3. **新增可观测日志**
   - 当触发“localhost 配置自动纠偏”时，输出 `[WARN]` 日志，包含配置值与运行时值，便于后续排障。

### 结果
- 即使历史 `.env` 里残留 localhost 配置，只要用户当前是通过公网域名访问，也会优先使用公网域名作为 OpenID 回调。
- 可直接规避“授权后跳回 localhost”的高频故障路径。

---

## 2026-04-01（再次修复：授权页仍显示 `localhost`）

### 问题现象
- 用户从公网域名进入页面，但点击 Steam 登录后，Steam 授权页仍提示“使用您的 Steam 帐户登录到 localhost”。
- 授权后回调地址仍可见 `http://localhost:5173/api/auth/steam/return?...`。

### 根因补充
1. **部分面板/反向代理不会稳定透传 `X-Forwarded-Host`**
   - 旧逻辑主要依赖 `x-forwarded-host` + `host` 推断外网域名。
   - 当这两个头都落成 localhost 时，即使用户来自公网，OpenID `realm/returnURL` 仍可能被构造成 localhost。

2. **登录发起阶段缺少“前端真实 origin”兜底**
   - 旧流程没有显式把浏览器当前站点 origin 传给后端。
   - 一旦代理头不完整，后端就缺少可靠来源。

### 本轮修复
1. **前端登录请求显式携带 origin**
   - `Steam 登录` 按钮改为跳转 `/api/auth/steam?origin=<window.location.origin>`。
   - 给后端提供稳定、直接的公网来源信息。

2. **后端新增客户端来源解析链路 `resolveClientOrigin()`**
   - 解析顺序：
     1) query `origin`（仅接受非 localhost）  
     2) session 中持久化的 `steamClientOrigin`  
     3) `Forwarded` 标准头（`proto`/`host`）  
     4) `x-forwarded-host` / `x-original-host` / `x-real-host` + 多种 proto 头  
     5) `Referer` / `Origin`
   - 若命中公网来源，优先用于构建 OpenID `realm/returnURL`。

3. **跨回调持久化来源**
   - 在 `/api/auth/steam` 发起时写入 `req.session.steamClientOrigin`。
   - 在 `/api/auth/steam/return` 校验时复用同一来源，防止中间跳转导致 host 信息丢失。
   - 登录成功后清理该 session 字段。

### 结果
- 即使反向代理头不完整，只要用户从公网页面点击登录，OpenID 参数也会优先采用公网 origin。
- 可继续压缩“授权页显示 localhost / 回调落 localhost”的残余故障概率。

---

## 2026-04-01（再补强：代理头异常时仍回落 localhost）

### 问题现象
- 部分面板反代场景下，`Host/X-Forwarded-Host` 会被改写成 `localhost:5173`。
- 即使前端从公网域名访问，Steam 授权页仍显示“登录到 localhost”，回调也落到 `http://localhost:5173/api/auth/steam/return`。

### 本轮修复
1. **新增 `PUBLIC_BASE_URL` 后端兜底配置**
   - 在 `resolveClientOrigin()` 中加入固定公网地址优先级（低于显式 query/session，高于代理头）。
   - 当反代头不可信时，仍能稳定生成公网 `realm/returnURL`。

2. **新增 session 级来源预热中间件**
   - 在通用中间件中从 `Origin/Referer` 预写入 `req.session.steamClientOrigin`（仅公网地址）。
   - 减少“首次登录请求缺少 query origin”导致的 localhost 回落。

3. **文档更新**
   - README 的 OpenID 常见问题新增 `PUBLIC_BASE_URL` 配置说明与示例。

### 结果
- 在“反代头偶发被改写为 localhost”的环境下，服务端仍可优先使用公网地址构建 Steam OpenID 回调参数。
- 进一步降低“授权页显示 localhost / 回调落 localhost”残余概率。

---

## 2026-04-01（再次修复：`Invalid or replayed nonce` 反复失败）

### 问题现象
- 日志稳定出现：
  - `Failed to verify assertion`
  - `cause: Invalid or replayed nonce`
- 且你的 `openid.return_to` / `expectedReturnURL` / `expectedRealm` 已经一致，说明不是简单的域名不匹配问题。

### 根因补充
1. **原流程在 nonce 失败时会先做一次 passport 重试**
   - 首次失败后仍走一次 `steam-stateless` 再校验，属于“同一断言再次验证”路径。
   - 在 `replayed nonce` 场景下，这一步通常不会改善，反而把故障重复触发一次。

2. **手动兜底触发时机偏后**
   - 旧代码只有“重试后仍失败”才进入 `check_authentication` 手动兜底，时机太晚、收益低。

### 本轮修复
1. **新增 nonce 错误识别**
   - 新增 `isReplayNonceError(error)`，统一识别 `replayed nonce` / `invalid nonce`（含 message、cause、openidError）。

2. **调整回调兜底顺序**
   - 当首次回调识别到 nonce 类错误时，优先直接走 `check_authentication` 手动校验兜底。
   - 仅手动兜底失败后，才继续进入后续 provider 切换/401 返回路径。

3. **加强手动兜底安全校验**
   - 手动校验新增以下约束，避免“无条件放行”：
     - 仅接受 `openid.mode=id_res` 与 OpenID 2.0 命名空间；
     - 仅接受 Steam OpenID 端点（`/openid` 或 `/openid/login`）；
     - `openid.return_to` 必须与服务端期望回调地址一致。

### 结果
- 在你这类“参数一致但 nonce 被判重复”的高频场景中，系统会更早进入可成功的手动校验路径，减少无效二次失败。
- 同时保留了 return_to 一致性校验，避免为了“能登上”而降低安全边界。

---

## 2026-04-01（继续修复：多级反代 `X-Forwarded-Host` 顺序导致仍显示 localhost）

### 问题现象
- 用户反馈仍出现 Steam 授权页提示“登录到 localhost”。
- 回调 URL 仍落到 `http://localhost:5173/api/auth/steam/return?...`。

### 根因补充
1. **多级反代时 `X-Forwarded-Host` 常为逗号列表**
   - 例如：`localhost:5173, your-domain.com` 或反过来。
   - 旧逻辑只取第一个值，若第一个恰好是 localhost，则会继续构建出 localhost 的 OpenID 地址。

2. **`resolveRequestBaseUrl()` 与 `resolveClientOrigin()` 都受该问题影响**
   - 两条路径都曾使用“逗号分隔列表第一个元素”策略。

### 本轮修复
1. **新增代理头解析工具函数**
   - `parseHeaderList(raw)`: 统一解析逗号分隔头值。
   - `pickPreferredHost(raw)`: 优先选择“非 localhost”主机，若全是本地地址再回退首项。
   - `pickPreferredProto(raw)`: 协议头统一取第一项（保持与代理链惯例一致）。

2. **替换关键主机解析点**
   - 在 `resolveClientOrigin()` 中，`x-forwarded-host/x-original-host/x-real-host` 全部改用 `pickPreferredHost()`。
   - 在 `resolveRequestBaseUrl()` 中，`x-forwarded-host` 改用 `pickPreferredHost()`。
   - 协议头读取统一改用 `pickPreferredProto()`。

### 结果
- 当代理头包含多个 host 且首项是 localhost 时，后端会优先选取非 localhost 的公网域名来构建 OpenID `realm/returnURL`。
- 进一步减少“明明从公网访问，Steam 仍显示登录到 localhost”的场景。

---

## 2026-04-01（再修复：`Failed to verify assertion` 持续失败）

### 问题现象
- 日志中 `realm`、`returnURL`、`openid.return_to` 看起来一致，仍报：
  - `InternalOpenIDError: Failed to verify assertion`
- 且“重试 openid.return_to + stateless”后依然失败。

### 本轮修复
1. **新增 OpenID 手动校验兜底（check_authentication）**
   - 在 Passport/OpenID 回调失败且重试后仍失败时，新增服务端兜底：
     - 从回调 query 提取全部 `openid.*` 参数；
     - 将 `openid.mode` 改写为 `check_authentication`；
     - 向 `https://steamcommunity.com/openid/login` 发起服务端校验；
     - 仅当响应包含 `is_valid:true` 且 `claimed_id` 可解析出合法 SteamID 时放行登录。
   - 目的：绕开第三方库在特定反代/参数场景下的断言校验兼容性问题，同时保留“必须由 Steam 服务器确认”的安全边界。

2. **补充 POST 请求代理失败直连回退**
   - 新增 `postWithDirectFallback()`，与 GET 一样在代理链路 `ETIMEDOUT/ECONNRESET/ECONNREFUSED/EHOSTUNREACH/ENETUNREACH` 时自动直连重试一次。
   - 避免手动校验阶段被本地代理抖动再次卡死。

3. **增强错误可观测性**
   - 在 OpenID 失败日志与 401 JSON 中新增 `cause` 字段（优先输出底层 openid/cause message），便于区分：
     - return_to/realm 不匹配；
     - nonce/重放问题；
     - OP 校验链路异常。

### 结果
- 当 Passport/OpenID 库继续抛出 `Failed to verify assertion` 时，系统会自动尝试“Steam 官方 check_authentication”兜底。
- 若 Steam 侧确认有效，用户可继续完成登录，避免再次卡在同一错误链路。

---

## 2026-04-01（再次补强：`Failed to verify assertion` 仍偶发）

### 问题现象
- 日志显示 `expectedReturnURL` / `openid.return_to` / `expectedRealm` 已一致，但回调仍报：
  - `InternalOpenIDError: Failed to verify assertion`
- 说明问题不再只是“回调地址不一致”，还可能与 OpenID 关联态校验（association state）有关。

### 本轮修复
1. **新增双策略：有状态优先 + 无状态兜底**
   - 保留原有 `steam`（`stateless: false`）作为首选。
   - 新增 `steam-stateless`（`stateless: true`）作为校验失败时兜底。

2. **回调失败重试路径升级**
   - 当首次回调出现 `Failed to verify assertion` 时：
     - 仍先按 `openid.return_to` 重建 `realm/returnURL`；
     - 但重试时切换到 `steam-stateless`，绕过关联态不一致导致的失败路径。

3. **策略运行时参数保持一致**
   - `applySteamAuthOptionsToStrategy()` 改为同时更新 `steam` 与 `steam-stateless` 的 `returnUrl/realm`。
   - OpenID provider 自动切换（`/openid` ↔ `/openid/login`）也同步作用于两个策略，避免主/备策略配置漂移。

### 结果
- 将“地址已一致但仍 assertion 失败”的场景纳入可恢复路径。
- 优先保证正常有状态流程；仅在必要时自动降级到无状态校验，提高复杂反代/网络环境下的登录成功率。

---

## 2026-04-01（最终定位：`passport-steam` 忽略动态 `realm/returnURL`）

### 问题现象
- 服务端日志里已经打印了公网域名的 `realm/returnURL`（例如 `https://csskin.666666.li/...`）。
- 但 Steam 授权页仍显示“登录到 localhost”，并且回调仍可见 `http://localhost:5173/api/auth/steam/return?...`。

### 根因（这次命中）
- `passport-steam` 基于 `passport-openid` 内部的 `RelyingParty` 实例做认证。
- 该实例在 `passport.use(new SteamStrategy(...))` 初始化时就固定了 `returnURL/realm`。
- 虽然路由里每次都构建了动态 `authOptions`，但 `passport.authenticate('steam', authOptions)` **不会覆盖**已初始化的 `RelyingParty` 参数。
- 结果：日志看起来“动态 URL 正确”，但实际发给 Steam 的仍是启动时的 localhost 配置。

### 本轮修复
1. **新增策略运行时覆写函数** `applySteamAuthOptionsToStrategy()`
   - 在每次发起/校验 Steam 登录前，将当前请求解析出的 `authOptions.returnURL` 与 `authOptions.realm` 写回 `steamStrategy._relyingParty`。

2. **在统一入口 `authenticateSteam()` 内强制执行覆写**
   - 先覆写策略内部 `RelyingParty`，再调用 `passport.authenticate('steam', authOptions, ...)`。
   - 这样可确保“实际请求参数”与日志打印参数一致，不再被初始化时 localhost 值绑死。

### 预期结果
- 从公网域名发起登录时，Steam 授权页应显示公网域名（而不是 localhost）。
- 回调 URL 应固定为公网地址 `/api/auth/steam/return`。

### 后续建议
- `.env` 里仍建议配置 `PUBLIC_BASE_URL=https://你的公网域名`（反代头不稳定时作为兜底）。
- 若仍异常，抓取一次 `/api/auth/steam` 请求与 302 Location，确认是否仍有中间层改写。

---

## 2026-04-01（补丁：`openid.return_to` 一致仍报 `Failed to verify assertion`）

### 问题现象
- 回调错误返回类似：
  - `details: Failed to verify assertion`
  - `expectedReturnURL` 与 `openidReturnTo` 文面看起来一致（例如都为 `https://csskin.666666.li/api/auth/steam/return`）。
- 这说明问题不再是“明显的域名不一致”，而是断言校验阶段仍可能出现边缘差异。

### 本轮修复
1. **新增断言失败重试逻辑（仅一次）**
   - 在 `/api/auth/steam/return` 回调中，当命中 `Failed to verify assertion` 时，触发一次兜底重试。
   - 重试时优先采用 Steam 回调参数里的 `openid.return_to` 作为 `returnURL`，并用其 `origin` 重新计算 `realm`。

2. **新增辅助函数**
   - `buildSteamAuthOptionsFromOpenIdReturnTo(req, authOptions)`：
     - 安全解析 `openid.return_to`；
     - 构造 `{ returnURL, realm }` 覆盖项；
     - 解析失败则不启用重试（保持原流程）。

3. **增强日志可观测性**
   - 新增 `[WARN] Steam OpenID callback verify assertion failed, retry with openid.return_to`，同时打印重试前后 `realm/returnURL`。
   - 若重试仍失败，输出 `[ERROR] Steam OpenID callback failed after retry`，便于与首次失败区分。

### 结果与价值
- 对“看起来 return URL 一样但仍断言失败”的场景增加了代码级兜底，不再只依赖初始推断参数。
- 避免重复陷入同类故障时只能靠人工反复改 `.env` 的低效排障路径。


---

## 2026-04-01（再修复：`Invalid or replayed nonce` 在手动校验后仍失败）

### 问题现象
- 回调日志中 `openid.return_to`、`expectedReturnURL`、`expectedRealm` 已一致。
- `manual nonce fallback`（`check_authentication`）仍可能返回失败，最终 401。

### 根因补充
- 某些环境里 Steam 断言会被浏览器/中间层重复触发，`check_authentication` 对“已经消费过 nonce”的响应仍会判定无效。
- 这类请求并非域名错配，而是“同一合法断言被二次到达”导致。

### 本轮修复
1. **新增受限 replay-nonce 可信兜底**
   - 新增 `buildSteamUserFromTrustedReplayNonce()`，仅在以下条件全部成立时才放行：
     - `openid.mode=id_res` 且 OpenID 2.0 命名空间正确；
     - `claimed_id` 可提取 SteamID，且 `identity===claimed_id`（若提供）；
     - `openid.return_to` 必须等于当前期望回调地址；
     - `op_endpoint` 必须是 Steam 官方端点；
     - `assoc_handle/sig/signed/response_nonce` 必须存在；
     - `response_nonce` 时间窗口与 session 发起时间窗口均在合理范围内。

2. **兜底链路前置与补位**
   - nonce 类错误先走 `check_authentication`。
   - 若该步骤仍失败，再尝试“受限 replay-nonce 可信兜底”。
   - stateless retry 分支里同样补上该兜底，避免再次 401。

3. **日志增强**
   - 新增关键日志：`trusted replay nonce fallback`，便于区分“手动校验成功”与“重放兜底成功”。

### 结果
- 对“同一合法回调被重复消费”场景，登录成功率显著提升。
- 同时保留严格前置约束，避免把兜底做成无条件放行。

---

## 2026-04-01（补修：已登录但库存显示 0 / source unknown）

### 问题现象
- 日志中出现：`[WARN] Missing STEAM_API_KEY. Steam login/inventory API will not work.`。
- 前端仍显示“已读取库存材料 0 件”，且元信息 `source` 可能显示为 `unknown`，容易误判成“账号真没库存”。

### 根因
- `/api/inventory` 在未配置 `STEAM_API_KEY` 时依旧走读取流程，前端也没有区分“接口错误”和“成功但空库存”。

### 本轮修复
1. **后端显式返回可读错误**
   - `/api/inventory` 在缺少 `STEAM_API_KEY` 时返回 `503`，并携带明确说明：
     - Steam 登录可用；
     - 读取库存需要配置 `STEAM_API_KEY`。
   - 同时固定返回 `source/total/cooldownCount/items`，避免前端出现 `unknown`。

2. **前端区分库存接口失败与空库存**
   - `tryLoadSession()` 改为先检查 `response.ok`。
   - 非 2xx 时显示“库存读取失败：<具体原因>”，不再伪装成“已读取 0 件”。

3. **README 增补故障指引**
   - 新增 FAQ：`已登录但“库存 0 件 / source unknown”`，明确说明如何配置 `STEAM_API_KEY` 以及替代方案（交易链接读取）。

### 结果
- 该问题现在会被明确识别为“配置缺失”，不会再误导为“库存为空”。
- 你后续排障可以直接看前端提示与 503 返回内容，定位速度会更快。

## 2026-04-01（精确磨损/冷却误判/总库存可见/同品级汰换规则修复）

### 问题现象
- 页面大量显示“float 估算”，无法像其他站点一样展示高精度磨损值。
- 部分纪念品显示“交易冷却/限制”，但实际只是不可合成，并非交易冷却。
- 总库存统计偏低，容易误以为“冷却中的饰品被忽略”。
- 汰换计算错误地允许跨品级材料参与。

### 根因判断
1. 缺失 float 时仅按外观估算中位值，没有优先通过 inspect link 补全精确磨损。
2. 冷却文本识别正则过宽（匹配 `trade` 等泛词），把非冷却描述误判为冷却。
3. 前端统计没有把“精确/估算/缺失 float”拆分，排障信息不透明。
4. 反推算法只过滤“是否纪念品”，未按输出皮肤的上一级品级筛选材料。

### 本轮修复
1. **精确 float 优先策略（新增 inspect 补全）**
   - 后端对缺失 float 且存在 inspect link 的饰品，调用 `CSFLOAT_INSPECT_API` 并发补全。
   - 新增 `floatSource=csfloat_inspect`，优先级为：`api > csfloat_inspect > estimated_from_exterior > missing`。
   - 估算值精度提升到 16 位小数，前端统一显示 16 位。

2. **冷却判断收敛，修复纪念品误判**
   - 将冷却关键词改为“Tradable After / Not Tradable / 交易冷却”等明确短语，移除泛化 `trade` 匹配。
   - 当 `tradable=0` 但判定为永久不可交易标签时，不再标记为“交易冷却”。

3. **库存统计可观测性增强**
   - 返回并展示 `exactFloatCount / estimatedFloatCount / missingFloatCount`。
   - 前端状态区分“精确 float / 估算 float / 缺失 float”，便于确认是否读取到了真实磨损。

4. **汰换规则修复为同品级输入**
   - 反推计算仅允许“输出品级的下一级输入品级”材料参与（例如目标受限，则输入必须为军规）。
   - 无输入品级时给出明确提示，避免“全品级可合成”的错误行为。

### 结果
- 可通过 inspect 链路为大量饰品补全精确磨损值，减少“全是估算”的情况。
- 纪念品不再被错误展示为冷却状态，冷却判断更接近 Steam 实际语义。
- 前端库存统计更透明，能快速判断“总量 vs 可合成量 vs 精确磨损覆盖率”。
- 汰换计算恢复到正确的同品级（上一品级）输入规则。
