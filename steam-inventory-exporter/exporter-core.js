(function (globalScope) {
  const APP_ID = 730;
  const CONTEXT_ID = 2;

  const EXTERIOR_MIDPOINT = {
    'Factory New': 0.035,
    'Minimal Wear': 0.11,
    'Field-Tested': 0.265,
    'Well-Worn': 0.415,
    'Battle-Scarred': 0.725,
    '崭新出厂': 0.035,
    '略有磨损': 0.11,
    '久经沙场': 0.265,
    '破损不堪': 0.415,
    '战痕累累': 0.725
  };

  const EXTERIOR_TAGS = new Set(Object.keys(EXTERIOR_MIDPOINT));

  function readSteamIdFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const profilesIndex = parts.indexOf('profiles');
    const idIndex = parts.indexOf('id');
    if (profilesIndex !== -1 && parts[profilesIndex + 1]) return parts[profilesIndex + 1];
    if (idIndex !== -1 && parts[idIndex + 1]) return parts[idIndex + 1];
    return null;
  }

  function buildInventoryUrl(steamId, startAssetId) {
    const url = new URL(`https://steamcommunity.com/inventory/${steamId}/${APP_ID}/${CONTEXT_ID}`);
    url.searchParams.set('l', 'schinese');
    url.searchParams.set('count', '5000');
    if (startAssetId) url.searchParams.set('start_assetid', String(startAssetId));
    return url.toString();
  }

  async function fetchInventoryPages(steamId) {
    const merged = { assets: [], descriptions: [] };
    let more = true;
    let startAssetId = null;

    while (more) {
      const response = await fetch(buildInventoryUrl(steamId, startAssetId), { credentials: 'include' });
      if (!response.ok) throw new Error(`库存接口异常: ${response.status}`);
      const payload = await response.json();
      merged.assets.push(...(payload.assets || []));
      merged.descriptions.push(...(payload.descriptions || []));
      more = Boolean(payload.more_items);
      startAssetId = payload.last_assetid || null;
    }

    return merged;
  }

  function readExterior(description) {
    const tags = Array.isArray(description?.tags) ? description.tags : [];
    const exteriorTag = tags.find((tag) => EXTERIOR_TAGS.has(tag?.name));
    return exteriorTag?.name || null;
  }

  function readInspectLink(description, ownerSteamId, assetId) {
    const actions = Array.isArray(description?.actions) ? description.actions : [];
    const inspectAction = actions.find((action) => /Inspect in Game/i.test(action?.name || ''));
    const rawLink = String(inspectAction?.link || '');
    if (!rawLink) return null;
    return rawLink
      .replace(/%owner_steamid%/g, ownerSteamId)
      .replace(/%assetid%/g, assetId)
      .replace(/&amp;/g, '&');
  }

  function parseCooldown(description) {
    const ownerDescriptions = Array.isArray(description?.owner_descriptions) ? description.owner_descriptions : [];
    const text = ownerDescriptions.map((item) => item?.value || '').join('\n');
    const cooldown = /Tradable After|可交易日期|交易后|tradeable after|trade hold/i.test(text);
    const tradableAfter = text.match(/Tradable After[^\n]*/i)?.[0] || text.match(/可交易[^\n]*/i)?.[0] || null;
    return { cooldown, tradableAfter };
  }

  function readFloatValue(description, exterior) {
    const candidates = [
      description?.floatvalue,
      description?.float_value,
      description?.fraudwarnings?.find((v) => /^0\.\d+$/.test(String(v || '')))
    ];
    for (const raw of candidates) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0 && value <= 1) {
        return { floatValue: value, floatSource: 'inspect_link' };
      }
    }

    if (exterior && EXTERIOR_MIDPOINT[exterior] !== undefined) {
      return { floatValue: EXTERIOR_MIDPOINT[exterior], floatSource: 'estimated_from_exterior' };
    }

    return { floatValue: null, floatSource: 'missing' };
  }

  function normalizeItem(asset, description, steamId) {
    const exterior = readExterior(description);
    const { cooldown, tradableAfter } = parseCooldown(description);
    const { floatValue, floatSource } = readFloatValue(description, exterior);

    const marketHashName = description?.market_hash_name || description?.name || 'Unknown Item';
    const isSouvenir = /Souvenir|纪念品/i.test(marketHashName);
    const isStatTrak = /StatTrak/i.test(marketHashName);
    const rarity = description?.tags?.find((tag) => tag?.category === 'Rarity')?.name || null;
    const collection = description?.tags?.find((tag) => tag?.category === 'ItemSet')?.name || null;

    return {
      id: asset.assetid,
      classid: asset.classid,
      instanceid: asset.instanceid,
      marketHashName,
      floatValue,
      floatSource,
      exterior,
      cooldown,
      tradableAfter,
      inspectLink: readInspectLink(description, steamId, asset.assetid),
      eligibleForTradeup: !isSouvenir,
      isSouvenir,
      isStatTrak,
      rarity,
      collection
    };
  }

  function buildExportPayload(steamId, inventoryData) {
    const descMap = new Map(inventoryData.descriptions.map((desc) => [`${desc.classid}_${desc.instanceid}`, desc]));
    const items = inventoryData.assets
      .filter((asset) => Number(asset?.appid) === APP_ID)
      .map((asset) => {
        const key = `${asset.classid}_${asset.instanceid}`;
        const desc = descMap.get(key);
        return desc ? normalizeItem(asset, desc, steamId) : null;
      })
      .filter(Boolean);

    const exactFloatCount = items.filter((it) => typeof it.floatValue === 'number' && it.floatSource === 'inspect_link').length;
    const estimatedFloatCount = items.filter((it) => it.floatSource === 'estimated_from_exterior').length;

    return {
      version: 1,
      source: 'steam_inventory_exporter',
      createdAt: new Date().toISOString(),
      steamId,
      total: items.length,
      cooldownCount: items.filter((it) => it.cooldown).length,
      exactFloatCount,
      estimatedFloatCount,
      missingFloatCount: items.filter((it) => typeof it.floatValue !== 'number').length,
      items
    };
  }

  function downloadAsJs(payload) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `cs2_inventory_export_${payload.steamId}_${stamp}.js`;
    const content = `window.CS2_INVENTORY_EXPORT = ${JSON.stringify(payload, null, 2)};\n`;
    const blob = new Blob([content], { type: 'text/javascript;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 2000);
  }

  async function exportInventory() {
    const steamId = readSteamIdFromUrl();
    if (!steamId) throw new Error('当前页面 URL 不包含 SteamID，请在个人库存页执行导出');
    const inventoryData = await fetchInventoryPages(steamId);
    const payload = buildExportPayload(steamId, inventoryData);
    downloadAsJs(payload);
    return payload;
  }

  globalScope.CS2InventoryExporter = {
    exportInventory,
    buildExportPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
