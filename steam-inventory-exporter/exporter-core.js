(function (globalScope) {
  const APP_ID = 730;
  const CONTEXT_ID = 2;

  const EXTERIOR_TAGS = new Set([
    'Factory New',
    'Minimal Wear',
    'Field-Tested',
    'Well-Worn',
    'Battle-Scarred',
    '崭新出厂',
    '略有磨损',
    '久经沙场',
    '破损不堪',
    '战痕累累'
  ]);

  const INSPECT_API_CANDIDATES = [
    'https://api.csgofloat.com',
    'https://api.csfloat.com'
  ];

  function readProfileIdFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const profilesIndex = parts.indexOf('profiles');
    const idIndex = parts.indexOf('id');
    if (profilesIndex !== -1 && parts[profilesIndex + 1]) {
      return { type: 'steamid64', value: parts[profilesIndex + 1] };
    }
    if (idIndex !== -1 && parts[idIndex + 1]) {
      return { type: 'vanity', value: parts[idIndex + 1] };
    }
    return null;
  }

  function readSteamIdFromPage() {
    const globalCandidates = [
      window.g_steamID,
      window.g_rgProfileData?.steamid,
      window.g_rgProfileData?.steamID
    ];
    for (const candidate of globalCandidates) {
      const value = String(candidate || '').trim();
      if (/^\d{17}$/.test(value)) return value;
    }

    const html = document.documentElement?.innerHTML || '';
    const match = html.match(/(?:g_steamID|steamid)["'\s:=]+(\d{17})/i);
    return match?.[1] || null;
  }

  async function resolveVanityToSteamId(vanityId) {
    try {
      const response = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanityId)}/?xml=1`, {
        credentials: 'include'
      });
      if (!response.ok) return null;
      const text = await response.text();
      const match = text.match(/<steamID64>(\d{17})<\/steamID64>/i);
      return match?.[1] || null;
    } catch (_) {
      return null;
    }
  }

  function parseSteamIdFromText(text) {
    const body = String(text || '');
    const patterns = [
      /<steamID64>(\d{17})<\/steamID64>/i,
      /g_steamID\s*=\s*"(\d{17})"/i,
      /"steamid"\s*:\s*"(\d{17})"/i,
      /steamid["'\s:=]+(\d{17})/i
    ];
    for (const pattern of patterns) {
      const match = body.match(pattern);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  async function resolveVanityToSteamIdByProfile(vanityId) {
    try {
      const response = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanityId)}/?l=english`, {
        credentials: 'include'
      });
      if (!response.ok) return null;
      return parseSteamIdFromText(await response.text());
    } catch (_) {
      return null;
    }
  }

  async function collectSteamIdCandidates() {
    const fromUrl = readProfileIdFromUrl();
    const fromPage = readSteamIdFromPage();
    const candidates = [fromPage];
    if (fromUrl?.type === 'steamid64') {
      candidates.push(fromUrl.value);
    } else if (fromUrl?.type === 'vanity') {
      const resolved = await resolveVanityToSteamId(fromUrl.value) || await resolveVanityToSteamIdByProfile(fromUrl.value);
      if (resolved) candidates.push(resolved);
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  }

  async function fetchLegacyInventoryByVanity(vanityId) {
    const legacyUrl = new URL(`https://steamcommunity.com/id/${encodeURIComponent(vanityId)}/inventory/json/${APP_ID}/${CONTEXT_ID}`);
    legacyUrl.searchParams.set('l', 'schinese');
    legacyUrl.searchParams.set('count', '5000');
    const response = await fetch(legacyUrl.toString(), { credentials: 'include' });
    if (!response.ok) throw new Error(`库存接口异常: ${response.status}`);
    const payload = await response.json();
    const assets = Object.values(payload?.rgInventory ?? {}).map((asset) => ({
      appid: APP_ID,
      assetid: asset?.id ?? '',
      classid: asset?.classid ?? '',
      instanceid: asset?.instanceid ?? '0'
    }));
    const descriptions = Object.values(payload?.rgDescriptions ?? {});
    return { assets, descriptions };
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

  async function fetchInventoryPagesWithFallback() {
    const candidates = await collectSteamIdCandidates();
    if (!candidates.length) {
      throw new Error('未识别到 SteamID，请在个人库存页执行导出');
    }

    let lastError = null;
    for (const steamId of candidates) {
      try {
        const inventoryData = await fetchInventoryPages(steamId);
        return { steamId, inventoryData };
      } catch (error) {
        lastError = error;
        if (!/(400|404)/.test(String(error?.message || ''))) throw error;
      }
    }

    const fromUrl = readProfileIdFromUrl();
    if (fromUrl?.type === 'vanity') {
      try {
        const inventoryData = await fetchLegacyInventoryByVanity(fromUrl.value);
        return { steamId: readSteamIdFromPage() || fromUrl.value, inventoryData };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('库存接口异常: 400/404');
  }

  function readExterior(description) {
    const tags = Array.isArray(description?.tags) ? description.tags : [];
    const exteriorTag = tags.find((tag) => EXTERIOR_TAGS.has(tag?.name));
    return exteriorTag?.name || null;
  }

  function normalizeInspectLink(rawLink, ownerSteamId, assetId) {
    const link = String(rawLink || '').trim();
    if (!link) return null;
    return link
      .replace(/&amp;/g, '&')
      .replace(/%owner_steamid%/g, ownerSteamId)
      .replace(/%assetid%/g, assetId)
      .replace(/%25owner_steamid%25/gi, ownerSteamId)
      .replace(/%25assetid%25/gi, assetId);
  }

  function isInspectAction(action) {
    const name = String(action?.name || '');
    const link = String(action?.link || '');
    return (
      /Inspect in Game|在游戏中检视/i.test(name) ||
      /csgo_econ_action_preview/i.test(link) ||
      /steam:\/\/rungame\/730/i.test(link)
    );
  }

  function readInspectLink(description, ownerSteamId, assetId) {
    const actionGroups = [description?.owner_actions, description?.actions, description?.market_actions];
    for (const group of actionGroups) {
      if (!Array.isArray(group)) continue;
      const inspectAction = group.find((action) => isInspectAction(action));
      if (!inspectAction) continue;
      const normalized = normalizeInspectLink(inspectAction.link, ownerSteamId, assetId);
      if (normalized) return normalized;
    }
    return null;
  }

  function parseCooldown(description) {
    const ownerDescriptions = Array.isArray(description?.owner_descriptions) ? description.owner_descriptions : [];
    const text = ownerDescriptions.map((item) => item?.value || '').join('\n');
    const cooldown = /Tradable After|可交易日期|交易后|tradeable after|trade hold/i.test(text);
    const tradableAfter = text.match(/Tradable After[^\n]*/i)?.[0] || text.match(/可交易[^\n]*/i)?.[0] || null;
    return { cooldown, tradableAfter };
  }

  function normalizeFloatValue(raw) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    return value;
  }

  function formatFloat16(value) {
    return typeof value === 'number' ? value.toFixed(16) : null;
  }

  function parseFloatFromInspectResponse(payload) {
    if (payload && typeof payload === 'object' && payload.iteminfo && payload.iteminfo.error) {
      return null;
    }
    const candidates = [
      payload?.iteminfo?.float,
      payload?.iteminfo?.wear,
      payload?.iteminfo?.floatvalue,
      payload?.iteminfo?.float_value,
      payload?.item?.float,
      payload?.item?.wear,
      payload?.item?.floatvalue,
      payload?.item?.float_value,
      payload?.float,
      payload?.wear,
      payload?.floatvalue,
      payload?.float_value
    ];
    for (const raw of candidates) {
      const parsed = normalizeFloatValue(raw);
      if (typeof parsed === 'number') return parsed;
    }
    return null;
  }

  function readFloatValue(description) {
    const candidates = [
      description?.floatvalue,
      description?.float_value,
      description?.fraudwarnings?.find((v) => /^0\.\d+$/.test(String(v || '')))
    ];
    for (const raw of candidates) {
      const value = normalizeFloatValue(raw);
      if (typeof value === 'number') {
        return { floatValue: value, floatValue16: formatFloat16(value), floatSource: 'inventory_api' };
      }
    }
    return { floatValue: null, floatValue16: null, floatSource: 'missing' };
  }

  async function fetchInspectFloat(inspectLink) {
    if (!inspectLink) return null;

    for (const baseUrl of INSPECT_API_CANDIDATES) {
      try {
        const url = new URL(baseUrl);
        url.searchParams.set('url', inspectLink);
        const response = await fetch(url.toString(), { credentials: 'omit' });
        if (!response.ok) continue;
        const payload = await response.json();
        const parsed = parseFloatFromInspectResponse(payload);
        if (typeof parsed === 'number') return parsed;
      } catch (_) {
        // continue to next inspect api candidate
      }
    }

    return null;
  }

  async function enrichItemsWithExactFloats(items) {
    const groupedByInspect = new Map();
    items.forEach((item, index) => {
      if (typeof item.floatValue === 'number') return;
      if (!item.inspectLink) return;
      const key = String(item.inspectLink);
      const indexes = groupedByInspect.get(key) || [];
      indexes.push(index);
      groupedByInspect.set(key, indexes);
    });

    const links = [...groupedByInspect.keys()];
    const concurrency = 6;
    let cursor = 0;

    async function worker() {
      while (cursor < links.length) {
        const currentIndex = cursor;
        cursor += 1;
        const link = links[currentIndex];
        const floatValue = await fetchInspectFloat(link);
        if (typeof floatValue !== 'number') continue;
        const floatValue16 = formatFloat16(floatValue);
        for (const itemIndex of groupedByInspect.get(link) || []) {
          items[itemIndex] = {
            ...items[itemIndex],
            floatValue,
            floatValue16,
            floatSource: 'csfloat_inspect'
          };
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, links.length) }, () => worker()));
    return items;
  }

  function normalizeItem(asset, description, steamId) {
    const exterior = readExterior(description);
    const { cooldown, tradableAfter } = parseCooldown(description);
    const { floatValue, floatValue16, floatSource } = readFloatValue(description);

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
      floatValue16,
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

  async function buildExportPayload(steamId, inventoryData) {
    const descMap = new Map(inventoryData.descriptions.map((desc) => [`${desc.classid}_${desc.instanceid}`, desc]));
    const items = inventoryData.assets
      .filter((asset) => Number(asset?.appid) === APP_ID)
      .map((asset) => {
        const key = `${asset.classid}_${asset.instanceid}`;
        const desc = descMap.get(key);
        return desc ? normalizeItem(asset, desc, steamId) : null;
      })
      .filter(Boolean);

    await enrichItemsWithExactFloats(items);

    const exactFloatCount = items.filter((it) => typeof it.floatValue === 'number').length;
    const estimatedFloatCount = 0;

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
    const { steamId, inventoryData } = await fetchInventoryPagesWithFallback();
    const payload = await buildExportPayload(steamId, inventoryData);
    downloadAsJs(payload);
    return payload;
  }

  globalScope.CS2InventoryExporter = {
    exportInventory,
    buildExportPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
