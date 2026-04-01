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
  authStatus: document.getElementById('authStatus'),
  result: document.getElementById('result'),
  dataSummary: document.getElementById('dataSummary'),
  inventoryMeta: document.getElementById('inventoryMeta')
};

let skinData = null;
let inventoryItems = [];

const COLLECTION_ZH = {
  'The Harlequin Collection': '哈乐昆收藏品',
  'The Ascent Collection': '攀升收藏品',
  'The Boreal Collection': '寒带收藏品',
  'The Radiant Collection': '热辐射收藏品',
  'The Graphic Design Collection': '墨彩收藏品'
};

const fmt16 = (n) => Number(n).toFixed(16);

function parseTargetFloat(raw) {
  if (!/^0(?:\.\d{1,16})?$|^1(?:\.0{1,16})?$/.test(raw.trim())) return null;
  return Number(raw);
}

function calcTradeupOutput(avgInputFloat, outputSkin) {
  const range = outputSkin.maxFloat - outputSkin.minFloat;
  return outputSkin.minFloat + range * avgInputFloat;
}

function getSkinRangeMap(skins) {
  return new Map(
    skins.map((skin) => [
      skin.name.toLowerCase(),
      { minFloat: skin.minFloat, maxFloat: skin.maxFloat }
    ])
  );
}

function normalizeInputFloat(item, skinRangeMap) {
  if (typeof item.floatValue !== 'number') return null;
  const range = skinRangeMap.get((item.marketHashName ?? '').toLowerCase());
  if (!range) return item.floatValue;
  const width = range.maxFloat - range.minFloat;
  if (width <= 0) return item.floatValue;
  const normalized = (item.floatValue - range.minFloat) / width;
  return Math.max(0, Math.min(1, normalized));
}

function bestCandidates(targetFloat, skins, inventory, topN = 15) {
  if (!inventory.length) return [];
  const withFloat = inventory.filter((x) => typeof x.floatValue === 'number');
  if (!withFloat.length) return [];
  const skinRangeMap = getSkinRangeMap(skins);
  const normalizedValues = withFloat
    .map((item) => normalizeInputFloat(item, skinRangeMap))
    .filter((v) => typeof v === 'number');
  if (!normalizedValues.length) return [];
  const avgInputFloat = normalizedValues.reduce((s, x) => s + x, 0) / normalizedValues.length;
  return skins
    .map((skin) => {
      const output = calcTradeupOutput(avgInputFloat, skin);
      return {
        skin,
        avgInputFloat,
        outputFloat: output,
        delta: Math.abs(output - targetFloat),
        usedInputCount: withFloat.length
      };
    })
    .sort((a, b) => a.delta - b.delta)
    .slice(0, topN);
}

async function loadSkinData() {
  skinData = await fetch('./data/collection_skins.json').then((r) => r.json());
  ui.dataSummary.innerHTML = `
    <p>已加载 <strong>${skinData.totalSkins}</strong> 个饰品（含全部稀有度/品质条目），覆盖收藏品：</p>
    <ul>${skinData.collections.map((c) => `<li>${COLLECTION_ZH[c] ?? c}</li>`).join('')}</ul>
    <p class="tip">数据源：ByMykel/CSGO-API（脚本可重复拉取更新）</p>
  `;
}

function renderResult(rows, targetFloat) {
  if (!rows.length) {
    ui.result.innerHTML = '<p class="warn">未检测到可用的 float 材料。请先加载示例库存，或通过后端接入 inspect 接口后再计算。</p>';
    return;
  }
  const htmlRows = rows.map((row, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${row.skin.name}</td>
      <td>${row.skin.weapon}</td>
      <td>${row.skin.rarity}</td>
      <td>${row.skin.collections.map((c) => COLLECTION_ZH[c] ?? c).join(' / ')}</td>
      <td>${fmt16(row.skin.minFloat)} ~ ${fmt16(row.skin.maxFloat)}</td>
      <td>${fmt16(row.outputFloat)}</td>
      <td class="${row.delta <= 0.00000001 ? 'good' : ''}">${fmt16(row.delta)}</td>
    </tr>
  `).join('');

  ui.result.innerHTML = `
    <p>目标磨损：<strong>${fmt16(targetFloat)}</strong></p>
    <p>当前参与计算材料数：<strong>${rows[0].usedInputCount}</strong> 件；归一化后的平均值：<strong>${fmt16(rows[0].avgInputFloat)}</strong></p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th><th>饰品</th><th>武器</th><th>品质</th><th>收藏品</th><th>磨损范围</th><th>预计输出</th><th>差值</th>
          </tr>
        </thead>
        <tbody>${htmlRows}</tbody>
      </table>
    </div>
  `;
}

function loadDemoInventory() {
  inventoryItems = [
    0.1212345678901234,
    0.1100000000000012,
    0.1299999999000001,
    0.1033333333333333,
    0.0999999999999999,
    0.1300000000000001,
    0.1400000000000001,
    0.0800000000000001,
    0.1177777777777777,
    0.101010101010101
  ].map((f, idx) => ({ id: `demo-${idx}`, floatValue: f, marketHashName: '' }));
  ui.authStatus.textContent = `示例库存已加载：${inventoryItems.length} 件材料`;
  renderInventoryMeta({
    source: 'demo',
    total: inventoryItems.length,
    cooldownCount: 0
  });
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
  const listHtml = inventoryItems.slice(0, 40).map((it) => `
    <div class="inv-row ${it.cooldown ? 'cooldown' : ''}">
      <div>${it.cooldown ? '⏳' : '✅'}</div>
      <div>
        ${it.marketHashName || '未知饰品'}
        ${it.cooldown ? '<span class="tag warn">冷却/限制</span>' : '<span class="tag">可交易</span>'}
        ${Array.isArray(it.cooldownText) && it.cooldownText.length ? `<div class="tip">${it.cooldownText[0]}</div>` : ''}
      </div>
    </div>
  `).join('');
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
    if (!resp.ok) {
      throw new Error(data?.details || data?.error || '读取失败');
    }
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
ui.calculateBtn.addEventListener('click', () => {
  const target = parseTargetFloat(ui.targetFloat.value);
  if (target === null) {
    ui.result.innerHTML = '<p class="warn">请输入 0~1 之间、最多 16 位小数的磨损值。</p>';
    return;
  }
  const candidates = bestCandidates(target, skinData.skins, inventoryItems, 20);
  renderResult(candidates, target);
});

await loadSkinData();
await tryLoadSession();
