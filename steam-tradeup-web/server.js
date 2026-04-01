import dotenv from 'dotenv';
import net from 'node:net';

dotenv.config();

function normalizeProxyUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;

  const withProtocol = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;

  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname || !parsed.port) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveSteamProxyCandidates() {
  const {
    STEAM_PROXY_URL,
    STEAM_PROXY_HOST,
    STEAM_PROXY_PORT,
    MIXED_PROXY_PORT,
    CLASH_MIXED_PORT,
    STEAM_USE_SYSTEM_PROXY,
    HTTPS_PROXY,
    HTTP_PROXY,
    ALL_PROXY,
    https_proxy,
    http_proxy,
    all_proxy,
    npm_config_proxy,
    npm_config_https_proxy
  } = process.env;

  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) return;
    if (candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  const explicit = normalizeProxyUrl(STEAM_PROXY_URL);
  if (explicit) pushCandidate(explicit);

  const systemProxyValues = [
    HTTPS_PROXY,
    HTTP_PROXY,
    ALL_PROXY,
    https_proxy,
    http_proxy,
    all_proxy,
    npm_config_https_proxy,
    npm_config_proxy
  ];

  // 默认优先尝试用户侧代理环境变量（例如 Clash/系统代理），避免写死“内部代理”。
  for (const value of systemProxyValues) {
    pushCandidate(value);
  }

  const fixedPorts = [STEAM_PROXY_PORT, MIXED_PROXY_PORT, CLASH_MIXED_PORT]
    .map((it) => String(it ?? '').trim())
    .filter(Boolean);

  for (const port of fixedPorts) {
    const host = String(STEAM_PROXY_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
    pushCandidate(`http://${host}:${port}`);
  }

  const allowSystemProxy = String(STEAM_USE_SYSTEM_PROXY ?? '').toLowerCase() === 'true';
  if (allowSystemProxy) {
    for (const value of systemProxyValues) {
      pushCandidate(value);
    }
  }

  return candidates;
}

async function isProxyReachable(proxy) {
  if (!proxy) return false;

  try {
    const parsed = new URL(proxy);
    const host = parsed.hostname;
    const port = Number(parsed.port);
    if (!host || !Number.isInteger(port) || port <= 0) return false;

    await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout'));
      }, 1200);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return true;
  } catch {
    return false;
  }
}

const resolvedProxyCandidates = resolveSteamProxyCandidates();
let proxyUrl = null;

for (const candidate of resolvedProxyCandidates) {
  // eslint-disable-next-line no-await-in-loop
  if (await isProxyReachable(candidate)) {
    proxyUrl = candidate;
    break;
  }
}

if (resolvedProxyCandidates.length > 0 && !proxyUrl) {
  console.warn(`[WARN] Steam/OpenID proxy is unreachable, fallback to direct connection: ${resolvedProxyCandidates.join(', ')}`);
}

if (proxyUrl) {
  process.env.GLOBAL_AGENT_HTTP_PROXY = proxyUrl;
  process.env.GLOBAL_AGENT_HTTPS_PROXY = proxyUrl;
  await import('global-agent/bootstrap.js');
  console.log(`[INFO] Global proxy enabled for Steam/OpenID requests: ${proxyUrl}`);
} else if (
  process.env.STEAM_PROXY_URL ||
  process.env.STEAM_PROXY_PORT ||
  process.env.MIXED_PROXY_PORT ||
  process.env.CLASH_MIXED_PORT ||
  process.env.STEAM_USE_SYSTEM_PROXY === 'true'
) {
  console.warn('[WARN] Proxy env is set but invalid. Expected format like http://127.0.0.1:7897');
}

// 注意：不再清理用户的代理环境变量，避免破坏用户本机代理链路。

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import axios from 'axios';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 5173,
  BASE_URL = 'http://localhost:5173',
  SESSION_SECRET = 'dev-secret',
  STEAM_API_KEY,
  STEAM_REALM = `${BASE_URL}/`,
  STEAM_RETURN_URL = `${BASE_URL}/api/auth/steam/return`,
  STEAM_OPENID_PROVIDER = 'https://steamcommunity.com/openid',
  STEAM_WEB_API = 'https://api.steampowered.com',
  CSFLOAT_INSPECT_API = 'https://api.csfloat.com'
} = process.env;

if (!STEAM_API_KEY) {
  console.warn('[WARN] Missing STEAM_API_KEY. Steam login/inventory API will not work.');
}

const proxyConfig = proxyUrl
  ? (() => {
      try {
        const parsed = new URL(proxyUrl);
        return {
          protocol: parsed.protocol.replace(':', ''),
          host: parsed.hostname,
          port: Number(parsed.port)
        };
      } catch {
        return undefined;
      }
    })()
  : undefined;

const http = axios.create({
  timeout: 25000,
  proxy: proxyConfig
});

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new SteamStrategy(
    {
      returnURL: STEAM_RETURN_URL,
      realm: STEAM_REALM,
      apiKey: STEAM_API_KEY,
      providerURL: STEAM_OPENID_PROVIDER,
      stateless: true
    },
    (_identifier, profile, done) => {
      return done(null, {
        steamId: profile.id,
        personaName: profile.displayName
      });
    }
  )
);

const app = express();
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 3600 * 1000 }
  })
);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));
app.get('/api/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), (_req, res) => {
  res.redirect('/');
});

app.get('/api/session', (req, res) => {
  if (!req.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.user });
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function accountIdToSteamId64(accountId) {
  const num = Number(accountId);
  if (!Number.isInteger(num) || num <= 0) return null;
  return String(BigInt(num) + 76561197960265728n);
}

function parseTradeUrl(raw) {
  try {
    const url = new URL(raw);
    if (!/steamcommunity\.com$/.test(url.hostname) || !url.pathname.includes('/tradeoffer/new')) return null;
    const partner = url.searchParams.get('partner');
    const token = url.searchParams.get('token');
    const steamId = accountIdToSteamId64(partner);
    if (!steamId) return null;
    return {
      steamId,
      partnerAccountId: partner,
      token
    };
  } catch {
    return null;
  }
}

function extractCooldownText(desc = []) {
  return desc
    .filter((d) => d?.value && /trade|交易|冷却|hold|available|可交易/i.test(d.value))
    .map((d) => d.value.replace(/<[^>]*>/g, '').trim())
    .filter(Boolean);
}

function normalizeInventory(items = []) {
  return items.map((it) => ({
    id: String(it.id),
    marketHashName: it.marketHashName ?? '',
    iconUrl: it.iconUrl ?? '',
    inspectLink: it.inspectLink ?? '',
    tradable: it.tradable,
    cooldown: it.cooldown,
    cooldownText: it.cooldownText,
    floatValue: typeof it.floatValue === 'number' ? it.floatValue : null
  }));
}

async function fetchInventory(steamId) {
  const url = `${STEAM_WEB_API}/IEconItems_730/GetPlayerItems/v1/`;
  const { data } = await http.get(url, {
    params: {
      key: STEAM_API_KEY,
      steamid: steamId
    }
  });
  return data?.result?.items ?? [];
}

app.get('/api/inventory', requireAuth, async (req, res) => {
  try {
    const items = await fetchInventory(req.user.steamId);
    const normalized = items
      .filter((it) => it.inventory > 0)
      .slice(0, 10)
      .map((it) => ({
        id: String(it.id),
        marketHashName: it.market_hash_name ?? '',
        floatValue: typeof it.floatvalue === 'number' ? it.floatvalue : null,
        tradable: true,
        cooldown: false,
        cooldownText: []
      }));

    res.json({
      note: 'Steam 官方库存接口通常不直接返回 float；你可将 floatvalue 字段替换为 CSFloat 检测结果。',
      inspectApi: `${CSFLOAT_INSPECT_API}/?url=<inspect_link>`,
      source: 'auth',
      items: normalizeInventory(normalized)
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch inventory',
      details: error.message
    });
  }
});

async function fetchPublicInventoryByTradeUrl(tradeUrl) {
  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) {
    const err = new Error('Invalid trade offer URL');
    err.code = 400;
    throw err;
  }

  const invUrl = `https://steamcommunity.com/inventory/${parsed.steamId}/730/2`;
  const { data } = await http.get(invUrl, {
    params: {
      l: 'english',
      count: 5000
    }
  });

  const descriptions = new Map(
    (data?.descriptions ?? []).map((d) => [`${d.classid}_${d.instanceid}`, d])
  );

  const items = (data?.assets ?? []).map((asset) => {
    const key = `${asset.classid}_${asset.instanceid}`;
    const desc = descriptions.get(key) ?? {};
    const inspectAction = (desc.actions ?? []).find((a) => /Inspect in Game/i.test(a.name));
    const inspectLink = (inspectAction?.link ?? '')
      .replace('%owner_steamid%', parsed.steamId)
      .replace('%assetid%', asset.assetid);
    const cooldownText = extractCooldownText([...(desc.owner_descriptions ?? []), ...(desc.descriptions ?? [])]);
    const tradable = Number(desc.tradable ?? 1) === 1;
    return {
      id: String(asset.assetid),
      marketHashName: desc.market_hash_name ?? '',
      iconUrl: desc.icon_url ? `https://community.fastly.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : '',
      inspectLink,
      tradable,
      cooldown: !tradable || cooldownText.length > 0,
      cooldownText,
      floatValue: null
    };
  });

  return {
    source: 'trade_url',
    steamId: parsed.steamId,
    token: parsed.token ?? null,
    total: items.length,
    cooldownCount: items.filter((it) => it.cooldown).length,
    items: normalizeInventory(items)
  };
}

app.get('/api/inventory/public', async (req, res) => {
  try {
    const tradeUrl = String(req.query.tradeUrl ?? '');
    if (!tradeUrl) {
      return res.status(400).json({ error: 'Missing tradeUrl query parameter' });
    }
    const result = await fetchPublicInventoryByTradeUrl(tradeUrl);
    res.json(result);
  } catch (error) {
    const status = error.code === 400 ? 400 : 500;
    res.status(status).json({
      error: 'Failed to fetch public inventory',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
