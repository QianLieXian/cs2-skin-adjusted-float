const API = {
  steamLogin: '/api/auth/steam',
  session: '/api/session',
  inventory: '/api/inventory',
  publicInventory: '/api/inventory/public'
};

const ui = {
  steamLoginBtn: document.getElementById('steamLoginBtn'),
  refreshInventoryBtn: document.getElementById('refreshInventoryBtn'),
  loadDemoBtn: document.getElementById('loadDemoBtn'),
  exportLogsBtn: document.getElementById('exportLogsBtn'),
  loadByTradeUrlBtn: document.getElementById('loadByTradeUrlBtn'),
  loadByApiKeyBtn: document.getElementById('loadByApiKeyBtn'),
  tradeUrlInput: document.getElementById('tradeUrlInput'),
  steamApiKeyInput: document.getElementById('steamApiKeyInput'),
  steamIdInput: document.getElementById('steamIdInput'),
  calculateBtn: document.getElementById('calculateBtn'),
  targetFloat: document.getElementById('targetFloat'),
  collectionSelect: document.getElementById('collectionSelect'),
  raritySelect: document.getElementById('raritySelect'),
  skinSelect: document.getElementById('skinSelect'),
  recipeCount: document.getElementById('recipeCount'),
  selectedSkinHint: document.getElementById('selectedSkinHint'),
  authStatus: document.getElementById('authStatus'),
  result: document.getElementById('result'),
  dataSummary: document.getElementById('dataSummary'),
  inventoryMeta: document.getElementById('inventoryMeta')
};

let skinData = null;
let inventoryItems = [];
let skinsByName = new Map();
const API_KEY_STORAGE_KEY = 'steam_web_api_key';
const STEAM_ID_STORAGE_KEY = 'steam_id_64';

const COLLECTION_ZH = {
  'The Harlequin Collection': '哈乐昆收藏品',
  'The Ascent Collection': '攀升收藏品',
  'The Boreal Collection': '寒带收藏品',
  'The Radiant Collection': '热辐射收藏品',
  'The Graphic Design Collection': '墨彩收藏品'
};

const RARITY_ZH = {
  'Consumer Grade': '消费级',
  Consumer: '消费级',
  'Industrial Grade': '工业级',
  Industrial: '工业级',
  'Mil-Spec Grade': '军规级',
  MilSpec: '军规级',
  Restricted: '受限',
  Classified: '保密',
  Covert: '隐秘'
};

const RARITY_CLASS = {
  'Consumer Grade': 'rarity-consumer',
  Consumer: 'rarity-consumer',
  'Industrial Grade': 'rarity-industrial',
  Industrial: 'rarity-industrial',
  'Mil-Spec Grade': 'rarity-milspec',
  MilSpec: 'rarity-milspec',
  Restricted: 'rarity-restricted',
  Classified: 'rarity-classified',
  Covert: 'rarity-covert'
};

const RARITY_ORDER = [
  'Consumer Grade',
  'Industrial Grade',
  'Mil-Spec Grade',
  'Restricted',
  'Classified',
  'Covert'
];

const WEAPON_ZH = {
  'AK-47': 'AK-47',
  AUG: 'AUG',
  AWP: 'AWP',
  'CZ75-Auto': 'CZ75 自动手枪',
  'Desert Eagle': '沙漠之鹰',
  'Dual Berettas': '双持贝瑞塔',
  FAMAS: '法玛斯',
  'Five-SeveN': 'FN57',
  G3SG1: 'G3SG1',
  'Galil AR': '加利尔 AR',
  'Glock-18': '格洛克 18 型',
  M249: 'M249',
  'M4A1-S': 'M4A1 消音型',
  M4A4: 'M4A4',
  'MAC-10': 'MAC-10',
  'MAG-7': 'MAG-7',
  'MP5-SD': 'MP5-SD',
  MP7: 'MP7',
  MP9: 'MP9',
  Negev: '内格夫',
  Nova: '新星',
  P2000: 'P2000',
  P250: 'P250',
  P90: 'P90',
  'PP-Bizon': 'PP-野牛',
  'R8 Revolver': 'R8 左轮手枪',
  'SCAR-20': 'SCAR-20',
  'SG 553': 'SG 553',
  'SSG 08': 'SSG 08',
  'Sawed-Off': '截短霰弹枪',
  'Tec-9': 'Tec-9',
  'UMP-45': 'UMP-45',
  'USP-S': 'USP 消音版',
  XM1014: 'XM1014',
  'Zeus x27': '宙斯 x27'
};

const fmt16 = (n) => Number(n).toFixed(16);
const sanitizeApiKey = (value) => String(value ?? '').trim();
const API_FETCH_OPTIONS = { credentials: 'include', cache: 'no-store' };

function getSteamApiKey() {
  return sanitizeApiKey(ui.steamApiKeyInput?.value);
}

function getSteamId64() {
  return String(ui.steamIdInput?.value ?? '').trim();
}

function parseTargetFloat(raw) {
  const v = raw.trim();
  if (!/^0\.\d{9,16}$/.test(v) && !/^1(?:\.0{9,16})?$/.test(v)) return null;
  return Number(v);
}

function normalizeInputFloat(item, skinRangeMap) {
  if (typeof item.floatValue !== 'number') return null;
  const range = skinRangeMap.get((item.marketHashName ?? '').toLowerCase());
  if (!range) return null;
  const width = range.maxFloat - range.minFloat;
  if (width <= 0) return null;
  const normalized = (item.floatValue - range.minFloat) / width;
  return Math.max(0, Math.min(1, normalized));
}

function normalizeSkinLookupName(raw = '') {
  return String(raw ?? '')
    .replace(/^StatTrak™\s*/i, '')
    .replace(/^Souvenir\s+/i, '')
    .replace(/\s+\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, '')
    .trim();
}

function localizeSkinName(rawName = '') {
  const [weapon, finish] = rawName.split(' | ');
  const zhWeapon = WEAPON_ZH[weapon] ?? weapon;
  return finish ? `${zhWeapon} | ${finish}` : zhWeapon;
}

function makeBreadcrumb(skin) {
  const collection = COLLECTION_ZH[skin.collections?.[0]] ?? skin.collections?.[0] ?? '未知收藏';
  const rarity = RARITY_ZH[skin.rarity] ?? skin.rarity;
  return `${collection} / ${rarity} / ${localizeSkinName(skin.name)}`;
}

function buildSelectors() {
  const collections = [...new Set(skinData.skins.flatMap((s) => s.collections || []))];
  ui.collectionSelect.innerHTML = collections
    .map((c) => `<option value="${c}">${COLLECTION_ZH[c] ?? c}</option>`)
    .join('');
  refreshRarityOptions();
}

function refreshRarityOptions() {
  const c = ui.collectionSelect.value;
  const rarities = [...new Set(skinData.skins.filter((s) => (s.collections || []).includes(c)).map((s) => s.rarity))]
    .sort((a, b) => {
      const ai = RARITY_ORDER.indexOf(a);
      const bi = RARITY_ORDER.indexOf(b);
      const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      return av - bv || a.localeCompare(b);
    });
  ui.raritySelect.innerHTML = rarities
    .map((r) => `<option value="${r}">${RARITY_ZH[r] ?? r}</option>`)
    .join('');
  refreshSkinOptions();
}

function refreshSkinOptions() {
  const c = ui.collectionSelect.value;
  const r = ui.raritySelect.value;
  const skins = skinData.skins.filter((s) => (s.collections || []).includes(c) && s.rarity === r);
  ui.skinSelect.innerHTML = skins
    .map((s) => `<option value="${s.id}">${localizeSkinName(s.name)}</option>`)
    .join('');
  refreshSelectedHint();
}

function refreshSelectedHint() {
  const selected = skinData.skins.find((s) => s.id === ui.skinSelect.value);
  if (!selected) {
    ui.selectedSkinHint.textContent = '';
    return;
  }
  ui.selectedSkinHint.textContent = `当前目标：${makeBreadcrumb(selected)}；输出磨损范围 ${fmt16(selected.minFloat)} ~ ${fmt16(selected.maxFloat)}`;
}

function evaluateCandidate(indices, items, targetNormalized) {
  const vals = indices.map((idx) => items[idx].normalized);
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  return { indices, avg, deltaNorm: Math.abs(avg - targetNormalized) };
}

function improveCandidate(candidate, items, poolIndices, targetNormalized) {
  const chosen = new Set(candidate.indices);
  let sum = candidate.indices.reduce((s, idx) => s + items[idx].normalized, 0);
  let improved = true;

  while (improved) {
    improved = false;
    let bestSwap = null;
    for (const inIdx of [...chosen]) {
      for (const outIdx of poolIndices) {
        if (chosen.has(outIdx)) continue;
        const nextSum = sum - items[inIdx].normalized + items[outIdx].normalized;
        const nextAvg = nextSum / chosen.size;
        const gain = Math.abs(candidate.avg - targetNormalized) - Math.abs(nextAvg - targetNormalized);
        if (gain > 1e-12 && (!bestSwap || gain > bestSwap.gain)) {
          bestSwap = { inIdx, outIdx, nextSum, nextAvg, gain };
        }
      }
    }
    if (bestSwap) {
      chosen.delete(bestSwap.inIdx);
      chosen.add(bestSwap.outIdx);
      sum = bestSwap.nextSum;
      candidate = {
        indices: [...chosen],
        avg: bestSwap.nextAvg,
        deltaNorm: Math.abs(bestSwap.nextAvg - targetNormalized)
      };
      improved = true;
    }
  }
  return candidate;
}

function reverseTradeup(targetFloat, outputSkin, inventory, recipeCount, topN = 5) {
  const outputWidth = outputSkin.maxFloat - outputSkin.minFloat;
  if (outputWidth <= 0) return [];

  const targetNormalized = (targetFloat - outputSkin.minFloat) / outputWidth;
  if (targetNormalized < 0 || targetNormalized > 1) return [];

  const skinRangeMap = new Map(
    skinData.skins.map((s) => [normalizeSkinLookupName(s.name).toLowerCase(), { minFloat: s.minFloat, maxFloat: s.maxFloat }])
  );
  const previousRarity = RARITY_ORDER[RARITY_ORDER.indexOf(outputSkin.rarity) - 1];
  if (!previousRarity) return [];

  const candidates = inventory
    .filter((it) => it.eligibleForTradeup !== false && it.rarity === previousRarity)
    .map((it) => {
      const normalized = normalizeInputFloat(it, skinRangeMap);
      return normalized === null ? null : { ...it, normalized };
    })
    .filter(Boolean);

  if (candidates.length < recipeCount) return [];

  const scored = candidates
    .map((it, idx) => ({ ...it, idx, dist: Math.abs(it.normalized - targetNormalized) }))
    .sort((a, b) => a.dist - b.dist);

  const pool = scored.slice(0, Math.min(140, scored.length)).map((x) => x.idx);
  const solutions = [];

  const starts = [
    scored.slice(0, recipeCount).map((x) => x.idx),
    scored.slice(Math.max(0, Math.floor(scored.length / 2) - Math.floor(recipeCount / 2)), Math.max(0, Math.floor(scored.length / 2) - Math.floor(recipeCount / 2)) + recipeCount).map((x) => x.idx)
  ].filter((arr) => arr.length === recipeCount);

  for (let i = 0; i < 16; i += 1) {
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, recipeCount);
    if (shuffled.length === recipeCount) starts.push(shuffled);
  }

  for (const start of starts) {
    let c = evaluateCandidate(start, candidates, targetNormalized);
    c = improveCandidate(c, candidates, pool, targetNormalized);
    const outputFloat = outputSkin.minFloat + c.avg * outputWidth;
    solutions.push({
      outputFloat,
      delta: Math.abs(outputFloat - targetFloat),
      avgNormalized: c.avg,
      items: c.indices.map((idx) => candidates[idx])
    });
  }

  return solutions
    .sort((a, b) => a.delta - b.delta)
    .filter((s, idx, arr) => idx === 0 || Math.abs(s.outputFloat - arr[idx - 1].outputFloat) > 1e-12)
    .slice(0, topN);
}

async function loadSkinData() {
  skinData = await fetch('./data/collection_skins.json').then((r) => r.json());
  skinsByName = new Map(skinData.skins.map((s) => [normalizeSkinLookupName(s.name).toLowerCase(), s]));
  ui.dataSummary.innerHTML = `
    <p>已加载 <strong>${skinData.totalSkins}</strong> 个饰品（含全部稀有度/品质条目），覆盖收藏品：</p>
    <ul>${skinData.collections.map((c) => `<li>${COLLECTION_ZH[c] ?? c}</li>`).join('')}</ul>
  `;
  buildSelectors();
}

function renderResult(rows, targetFloat, outputSkin, recipeCount) {
  const previousRarity = RARITY_ORDER[RARITY_ORDER.indexOf(outputSkin.rarity) - 1];
  const rarityRuleText = previousRarity
    ? `汰换规则：仅使用同一输入品级（${RARITY_ZH[previousRarity] ?? previousRarity}）材料。`
    : '汰换规则：该目标品级无可用下一级输入材料。';
  if (!rows.length) {
    const rarityHint = previousRarity
      ? `当前目标品级需要使用同一输入品级（${RARITY_ZH[previousRarity] ?? previousRarity}）材料。`
      : '该目标品级没有可用于汰换的下一级输入材料。';
    ui.result.innerHTML = `<p class="warn">暂无可计算结果：请确认库存里有浮点值、数量满足配方件数，且输入材料品级符合汰换规则。${rarityHint}</p>`;
    return;
  }

  const htmlRows = rows.map((row, i) => {
    const exact = row.delta <= 1e-12;
    const itemList = row.items.map((it) => {
      const skin = skinsByName.get(normalizeSkinLookupName(it.marketHashName || '').toLowerCase());
      const breadcrumb = skin ? makeBreadcrumb(skin) : `未知收藏 / 未知品质 / ${localizeSkinName(it.marketHashName || '未知饰品')}`;
      const rarityClass = skin ? (RARITY_CLASS[skin.rarity] ?? '') : '';
      return `<li class="${rarityClass}">${breadcrumb}（float: ${fmt16(it.floatValue)}，归一化: ${fmt16(it.normalized)}）</li>`;
    }).join('');

    return `
      <tr>
        <td>${i + 1}</td>
        <td>${fmt16(row.outputFloat)}</td>
        <td class="${exact ? 'good' : ''}">${fmt16(row.delta)} ${exact ? '（完全匹配）' : ''}</td>
        <td>${fmt16(row.avgNormalized)}</td>
        <td><details><summary>查看 ${recipeCount} 件材料</summary><ol class="material-list">${itemList}</ol></details></td>
      </tr>
    `;
  }).join('');

  ui.result.innerHTML = `
    <p>目标饰品：<strong class="${RARITY_CLASS[outputSkin.rarity] ?? ''}">${makeBreadcrumb(outputSkin)}</strong></p>
    <p>目标磨损：<strong>${fmt16(targetFloat)}</strong>（范围 ${fmt16(outputSkin.minFloat)} ~ ${fmt16(outputSkin.maxFloat)}）</p>
    <p>${rarityRuleText}</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>#</th><th>预计输出</th><th>差值</th><th>平均归一化</th><th>材料明细</th></tr>
        </thead>
        <tbody>${htmlRows}</tbody>
      </table>
    </div>
  `;
}

function loadDemoInventory() {
  const demoNames = [
    'MP9 | Bee-Tron', 'R8 Revolver | Mauve Aside', 'CZ75-Auto | Honey Paisley', 'SG 553 | Safari Print',
    'PP-Bizon | Thermal Currents', 'Sawed-Off | Crimson Batik', 'FAMAS | Byproduct', 'Tec-9 | Blue Blast',
    'MP9 | Buff Blue', 'R8 Revolver | Cobalt Grip', 'P90 | Blue Tac', 'Sawed-Off | Runoff'
  ];

  inventoryItems = demoNames.map((name, idx) => ({
    id: `demo-${idx}`,
    marketHashName: name,
    floatValue: [0.1212345678912345, 0.1100000000012345, 0.1299999999111111, 0.1033333333333333, 0.0999999999999999, 0.1300000000000001, 0.1400000000000001, 0.0800000000000001, 0.1177777777777777, 0.1010101010101010, 0.1323232323232323, 0.1499999999999999][idx]
  }));

  ui.authStatus.textContent = `示例库存已加载：${inventoryItems.length} 件材料（全部附带 float）`;
  renderInventoryMeta({ source: 'demo', total: inventoryItems.length, cooldownCount: 0 });
}

async function tryLoadSession() {
  try {
    const session = await fetch(API.session, API_FETCH_OPTIONS).then((r) => r.json());
    if (!session?.loggedIn) {
      ui.authStatus.textContent = '未登录';
      return;
    }
    await loadAuthedInventory(session.user);
  } catch {
    ui.authStatus.textContent = '未部署后端，当前仅可使用示例库存。';
  }
}

async function loadAuthedInventory(user) {
  const displayName = user?.personaName || 'Unknown';
  const steamId = user?.steamId || '';
  ui.authStatus.textContent = `已登录 Steam: ${displayName} (${steamId})\n正在刷新库存...`;
  const query = new URLSearchParams();
  const apiKey = getSteamApiKey();
  if (apiKey) query.set('apiKey', apiKey);
  const inventoryUrl = query.size > 0 ? `${API.inventory}?${query.toString()}` : API.inventory;
  const invRes = await fetch(inventoryUrl, API_FETCH_OPTIONS);
  const invResp = await invRes.json();
  inventoryItems = invResp.items || [];
  if (!invRes.ok) {
    const fallbackErrors = Array.isArray(invResp?.fallbackErrors)
      ? `；回退链路：${invResp.fallbackErrors.map((it) => `${it.source}(${it.status ?? 'n/a'}): ${it.message}`).join(' | ')}`
      : '';
    const reason = `${invResp?.details || invResp?.error || '读取失败'}${fallbackErrors}`;
    ui.authStatus.textContent = `已登录 Steam: ${displayName} (${steamId})\n库存读取失败：${reason}`;
    renderInventoryMeta(invResp);
    return;
  }
  const materialCount = Number(invResp.materialCount ?? inventoryItems.filter((it) => it.eligibleForTradeup !== false).length);
  ui.authStatus.textContent = `已登录 Steam: ${displayName} (${steamId})\n已读取库存总数 ${inventoryItems.length} 件，可用于炼金 ${materialCount} 件`;
  renderInventoryMeta(invResp);
}

function renderInventoryMeta(meta) {
  if (!meta) {
    ui.inventoryMeta.innerHTML = '';
    return;
  }
  const cooldownCount = Number(meta.cooldownCount ?? inventoryItems.filter((it) => it.cooldown).length);
  const total = Number(meta.total ?? inventoryItems.length);
  const materialCount = Number(meta.materialCount ?? inventoryItems.filter((it) => it.eligibleForTradeup !== false).length);
  const missingFloatCount = Number(meta.missingFloatCount ?? inventoryItems.filter((it) => typeof it.floatValue !== 'number').length);
  const exactFloatCount = Number(meta.exactFloatCount ?? inventoryItems.filter((it) => ['api', 'csfloat_inspect'].includes(it.floatSource)).length);
  const estimatedFloatCount = Number(meta.estimatedFloatCount ?? inventoryItems.filter((it) => it.floatSource === 'estimated_from_exterior').length);
  const dictionaryMatchedCount = Number(meta.dictionaryMatchedCount ?? inventoryItems.filter((it) => it.collection && it.rarity).length);
  const listHtml = inventoryItems.slice(0, 40).map((it) => {
    const skin = skinsByName.get(normalizeSkinLookupName(it.marketHashName || '').toLowerCase());
    const rarityClass = skin ? (RARITY_CLASS[skin.rarity] ?? '') : '';
    const breadcrumb = skin ? makeBreadcrumb(skin) : `未知收藏 / 未知品质 / ${localizeSkinName(it.marketHashName || '未知饰品')}`;
    const floatLabel = typeof it.floatValue === 'number'
      ? `float ${fmt16(it.floatValue)}${it.floatSource === 'estimated_from_exterior' ? '（估算）' : '（精确）'}`
      : 'float 缺失';
    const stateTags = [
      it.cooldown ? '<span class="tag warn">交易冷却/限制</span>' : '<span class="tag">可交易</span>',
      it.isSouvenir ? '<span class="tag warn">纪念品（不可合成）</span>' : '<span class="tag">非纪念品</span>',
      it.isStatTrak ? '<span class="tag">StatTrak™</span>' : ''
    ].filter(Boolean).join('');
    return `
      <div class="inv-row ${it.cooldown ? 'cooldown' : ''}">
        <div>${it.cooldown ? '⏳' : '✅'}</div>
        <div class="${rarityClass}">
          ${breadcrumb}
          <span class="tag">${floatLabel}</span>
          ${stateTags}
        </div>
      </div>
    `;
  }).join('');
  ui.inventoryMeta.innerHTML = `
    <div class="meta">
      库存来源：<strong>${meta.source ?? 'unknown'}</strong>，总数：<strong>${total}</strong>，
      可用于炼金：<strong>${materialCount}</strong>，
      冷却/限制物品：<strong class="cooldown">${cooldownCount}</strong>，
      字典命中：<strong>${dictionaryMatchedCount}</strong>，
      精确 float：<strong>${exactFloatCount}</strong>，
      估算 float：<strong>${estimatedFloatCount}</strong>，
      float 缺失：<strong>${missingFloatCount}</strong>
    </div>
    ${listHtml ? `<div class="inv-list">${listHtml}</div>` : ''}
  `;
}

async function loadByApiKeyDirect() {
  const apiKey = getSteamApiKey();
  const steamId = getSteamId64();
  if (!apiKey) {
    ui.authStatus.textContent = '请先填写 Steam Web API Key。';
    return;
  }
  if (!/^\d{17}$/.test(steamId)) {
    ui.authStatus.textContent = '请填写 17 位 SteamID64。';
    return;
  }
  ui.authStatus.textContent = `正在通过 API Key 读取库存... (${steamId})`;
  try {
    const query = new URLSearchParams({ apiKey, steamId });
    const resp = await fetch(`/api/inventory/by-api-key?${query.toString()}`, API_FETCH_OPTIONS);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.details || data?.error || '读取失败');
    inventoryItems = data.items || [];
    ui.authStatus.textContent = `API Key 读取成功：SteamID ${steamId}，库存 ${inventoryItems.length} 件`;
    renderInventoryMeta(data);
  } catch (error) {
    ui.authStatus.textContent = `API Key 读取失败：${error.message}`;
  }
}

async function loadByTradeUrl() {
  const tradeUrl = ui.tradeUrlInput.value.trim();
  if (!tradeUrl) {
    ui.authStatus.textContent = '请先粘贴交易链接。';
    return;
  }
  ui.authStatus.textContent = '正在通过交易链接读取公开库存...';
  try {
    const query = new URLSearchParams({ tradeUrl });
    const apiKey = getSteamApiKey();
    if (apiKey) query.set('apiKey', apiKey);
    const resp = await fetch(`${API.publicInventory}?${query.toString()}`, API_FETCH_OPTIONS);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.details || data?.error || '读取失败');
    inventoryItems = data.items || [];
    ui.authStatus.textContent = `读取成功：SteamID ${data.steamId}，库存 ${inventoryItems.length} 件`;
    renderInventoryMeta(data);
  } catch (error) {
    ui.authStatus.textContent = `交易链接读取失败：${error.message}`;
  }
}

async function refreshInventory() {
  try {
    const session = await fetch(API.session, API_FETCH_OPTIONS).then((r) => r.json());
    if (!session?.loggedIn) {
      ui.authStatus.textContent = '请先登录 Steam，再刷新库存。';
      return;
    }
    await loadAuthedInventory(session.user);
  } catch (error) {
    ui.authStatus.textContent = `刷新库存失败：${error.message}`;
  }
}

async function exportServerLogs() {
  ui.authStatus.textContent = '正在导出后端日志...';
  try {
    const response = await fetch('/api/logs/export', API_FETCH_OPTIONS);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.details || payload?.error || '导出失败');
    }
    const content = await response.text();
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    anchor.href = href;
    anchor.download = `steam-tradeup-server-logs-${stamp}.log`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    ui.authStatus.textContent = '日志导出成功，文件已下载到浏览器默认下载目录。';
  } catch (error) {
    ui.authStatus.textContent = `日志导出失败：${error.message}`;
  }
}

function initApiKeyInput() {
  const saved = window.localStorage.getItem(API_KEY_STORAGE_KEY);
  if (saved) ui.steamApiKeyInput.value = saved;
  const savedSteamId = window.localStorage.getItem(STEAM_ID_STORAGE_KEY);
  if (savedSteamId) ui.steamIdInput.value = savedSteamId;
  ui.steamApiKeyInput.addEventListener('change', () => {
    const value = sanitizeApiKey(ui.steamApiKeyInput.value);
    if (value) {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  });
  ui.steamIdInput.addEventListener('change', () => {
    const value = getSteamId64();
    if (value) {
      window.localStorage.setItem(STEAM_ID_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(STEAM_ID_STORAGE_KEY);
    }
  });
}

ui.steamLoginBtn.addEventListener('click', () => {
  const loginUrl = new URL(API.steamLogin, window.location.origin);
  loginUrl.searchParams.set('origin', window.location.origin);
  window.location.href = loginUrl.toString();
});
ui.refreshInventoryBtn.addEventListener('click', refreshInventory);
ui.loadDemoBtn.addEventListener('click', loadDemoInventory);
ui.loadByTradeUrlBtn.addEventListener('click', loadByTradeUrl);
ui.loadByApiKeyBtn.addEventListener('click', loadByApiKeyDirect);
ui.exportLogsBtn.addEventListener('click', exportServerLogs);
ui.collectionSelect.addEventListener('change', refreshRarityOptions);
ui.raritySelect.addEventListener('change', refreshSkinOptions);
ui.skinSelect.addEventListener('change', refreshSelectedHint);

ui.calculateBtn.addEventListener('click', () => {
  const target = parseTargetFloat(ui.targetFloat.value);
  if (target === null) {
    ui.result.innerHTML = '<p class="warn">请输入 0~1 且 9-16 位小数（例如 0.13989789148739）。</p>';
    return;
  }

  const outputSkin = skinData.skins.find((s) => s.id === ui.skinSelect.value);
  if (!outputSkin) {
    ui.result.innerHTML = '<p class="warn">请先选择目标饰品。</p>';
    return;
  }

  const recipeCount = Number(ui.recipeCount.value);
  const candidates = reverseTradeup(target, outputSkin, inventoryItems, recipeCount, 5);
  renderResult(candidates, target, outputSkin, recipeCount);
});

await loadSkinData();
initApiKeyInput();
await tryLoadSession();
