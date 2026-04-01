const API = {
  steamLogin: '/api/auth/steam',
  session: '/api/session',
  inventory: '/api/inventory',
  publicInventory: '/api/inventory/public'
};

const ui = {
  steamLoginBtn: document.getElementById('steamLoginBtn'),
  loadDemoBtn: document.getElementById('loadDemoBtn'),
  loadByTradeUrlBtn: document.getElementById('loadByTradeUrlBtn'),
  tradeUrlInput: document.getElementById('tradeUrlInput'),
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

const COLLECTION_ZH = {
  'The Harlequin Collection': '哈乐昆收藏品',
  'The Ascent Collection': '攀升收藏品',
  'The Boreal Collection': '寒带收藏品',
  'The Radiant Collection': '热辐射收藏品',
  'The Graphic Design Collection': '墨彩收藏品'
};

const RARITY_ZH = {
  Consumer: '消费级',
  Industrial: '工业级',
  MilSpec: '军规级',
  Restricted: '受限',
  Classified: '保密',
  Covert: '隐秘'
};

const RARITY_CLASS = {
  Consumer: 'rarity-consumer',
  Industrial: 'rarity-industrial',
  MilSpec: 'rarity-milspec',
  Restricted: 'rarity-restricted',
  Classified: 'rarity-classified',
  Covert: 'rarity-covert'
};

const fmt16 = (n) => Number(n).toFixed(16);

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

function makeBreadcrumb(skin) {
  const collection = COLLECTION_ZH[skin.collections?.[0]] ?? skin.collections?.[0] ?? '未知收藏';
  const rarity = RARITY_ZH[skin.rarity] ?? skin.rarity;
  return `${collection} / ${rarity} / ${skin.name}`;
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
  const rarities = [...new Set(skinData.skins.filter((s) => (s.collections || []).includes(c)).map((s) => s.rarity))];
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
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
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

  const skinRangeMap = new Map(skinData.skins.map((s) => [s.name.toLowerCase(), { minFloat: s.minFloat, maxFloat: s.maxFloat }]));

  const candidates = inventory
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
  skinsByName = new Map(skinData.skins.map((s) => [s.name.toLowerCase(), s]));
  ui.dataSummary.innerHTML = `
    <p>已加载 <strong>${skinData.totalSkins}</strong> 个饰品（含全部稀有度/品质条目），覆盖收藏品：</p>
    <ul>${skinData.collections.map((c) => `<li>${COLLECTION_ZH[c] ?? c}</li>`).join('')}</ul>
  `;
  buildSelectors();
}

function renderResult(rows, targetFloat, outputSkin, recipeCount) {
  if (!rows.length) {
    ui.result.innerHTML = '<p class="warn">暂无可计算结果：请确认库存里有浮点值、且数量满足配方件数，并且目标磨损在该目标饰品范围内。</p>';
    return;
  }

  const htmlRows = rows.map((row, i) => {
    const exact = row.delta <= 1e-12;
    const itemList = row.items.map((it) => {
      const skin = skinsByName.get((it.marketHashName || '').toLowerCase());
      const breadcrumb = skin ? makeBreadcrumb(skin) : `未知收藏 / 未知品质 / ${it.marketHashName || '未知饰品'}`;
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
    const session = await fetch(API.session).then((r) => r.json());
    if (!session?.loggedIn) {
      ui.authStatus.textContent = '未登录';
      return;
    }
    ui.authStatus.textContent = `已登录 Steam: ${session.user.personaName} (${session.user.steamId})`;
    const invResp = await fetch(API.inventory).then((r) => r.json());
    inventoryItems = invResp.items || [];
    ui.authStatus.textContent += `\n已读取库存材料 ${inventoryItems.length} 件`;
    renderInventoryMeta(invResp);
  } catch {
    ui.authStatus.textContent = '未部署后端，当前仅可使用示例库存。';
  }
}

function renderInventoryMeta(meta) {
  if (!meta) {
    ui.inventoryMeta.innerHTML = '';
    return;
  }
  const cooldownCount = Number(meta.cooldownCount ?? inventoryItems.filter((it) => it.cooldown).length);
  const total = Number(meta.total ?? inventoryItems.length);
  const listHtml = inventoryItems.slice(0, 40).map((it) => {
    const skin = skinsByName.get((it.marketHashName || '').toLowerCase());
    const rarityClass = skin ? (RARITY_CLASS[skin.rarity] ?? '') : '';
    const breadcrumb = skin ? makeBreadcrumb(skin) : `未知收藏 / 未知品质 / ${it.marketHashName || '未知饰品'}`;
    return `
      <div class="inv-row ${it.cooldown ? 'cooldown' : ''}">
        <div>${it.cooldown ? '⏳' : '✅'}</div>
        <div class="${rarityClass}">
          ${breadcrumb}
          <span class="tag">${typeof it.floatValue === 'number' ? `float ${fmt16(it.floatValue)}` : 'float 缺失'}</span>
          ${it.cooldown ? '<span class="tag warn">冷却/限制</span>' : '<span class="tag">可交易</span>'}
        </div>
      </div>
    `;
  }).join('');
  ui.inventoryMeta.innerHTML = `
    <div class="meta">
      库存来源：<strong>${meta.source ?? 'unknown'}</strong>，总数：<strong>${total}</strong>，
      冷却/限制物品：<strong class="cooldown">${cooldownCount}</strong>
    </div>
    ${listHtml ? `<div class="inv-list">${listHtml}</div>` : ''}
  `;
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
    const resp = await fetch(`${API.publicInventory}?${query.toString()}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.details || data?.error || '读取失败');
    inventoryItems = data.items || [];
    ui.authStatus.textContent = `读取成功：SteamID ${data.steamId}，库存 ${inventoryItems.length} 件`;
    renderInventoryMeta(data);
  } catch (error) {
    ui.authStatus.textContent = `交易链接读取失败：${error.message}`;
  }
}

ui.steamLoginBtn.addEventListener('click', () => {
  window.location.href = API.steamLogin;
});
ui.loadDemoBtn.addEventListener('click', loadDemoInventory);
ui.loadByTradeUrlBtn.addEventListener('click', loadByTradeUrl);
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
await tryLoadSession();
