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
  const explicitCandidates = [];
  const fixedPortCandidates = [];
  const systemCandidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) return;
    if (candidates.includes(normalized)) return;
    candidates.push(normalized);
  };
  const pushExplicitCandidate = (value) => {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) return;
    if (explicitCandidates.includes(normalized)) return;
    explicitCandidates.push(normalized);
  };
  const pushFixedPortCandidate = (value) => {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) return;
    if (fixedPortCandidates.includes(normalized)) return;
    fixedPortCandidates.push(normalized);
  };
  const pushSystemCandidate = (value) => {
    const normalized = normalizeProxyUrl(value);
    if (!normalized) return;
    if (systemCandidates.includes(normalized)) return;
    systemCandidates.push(normalized);
  };

  const explicit = normalizeProxyUrl(STEAM_PROXY_URL);
  if (explicit) pushExplicitCandidate(explicit);

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

  const fixedPorts = [STEAM_PROXY_PORT, MIXED_PROXY_PORT, CLASH_MIXED_PORT]
    .map((it) => String(it ?? '').trim())
    .filter(Boolean);

  for (const port of fixedPorts) {
    const host = String(STEAM_PROXY_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
    pushFixedPortCandidate(`http://${host}:${port}`);
  }

  const allowSystemProxy = String(STEAM_USE_SYSTEM_PROXY ?? '').toLowerCase() === 'true';
  if (allowSystemProxy || (explicitCandidates.length === 0 && fixedPortCandidates.length === 0)) {
    for (const value of systemProxyValues) {
      pushSystemCandidate(value);
    }
  }

  for (const value of explicitCandidates) pushCandidate(value);
  for (const value of fixedPortCandidates) pushCandidate(value);
  for (const value of systemCandidates) pushCandidate(value);

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
  console.warn('[WARN] Proxy env is set but invalid. Expected formats like http://127.0.0.1:25561 or socks5://127.0.0.1:25561');
}

// 注意：不再清理用户的代理环境变量，避免破坏用户本机代理链路。

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import axios from 'axios';
import { ProxyAgent } from 'proxy-agent';
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

function normalizeOpenIdProvider(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'https://steamcommunity.com/openid';
  try {
    const url = new URL(value);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (normalizedPath === '/openid/login') {
      url.pathname = '/openid';
      url.search = '';
      url.hash = '';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'https://steamcommunity.com/openid';
  }
}

function normalizeBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'http://localhost:5173';
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '';
    } else {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'http://localhost:5173';
  }
}

const normalizedBaseUrl = normalizeBaseUrl(BASE_URL);
const defaultSteamRealm = `${normalizedBaseUrl}/`;
const defaultSteamReturnUrl = `${normalizedBaseUrl}/api/auth/steam/return`;

if (!STEAM_API_KEY) {
  console.warn('[WARN] Missing STEAM_API_KEY. Steam login/inventory API will not work.');
}

const axiosConfig = {
  timeout: 25000
};

if (proxyUrl) {
  const proxyAgent = new ProxyAgent(proxyUrl);
  axiosConfig.httpAgent = proxyAgent;
  axiosConfig.httpsAgent = proxyAgent;
  axiosConfig.proxy = false;
}

const http = axios.create(axiosConfig);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new SteamStrategy(
    {
      returnURL: STEAM_RETURN_URL || defaultSteamReturnUrl,
      realm: STEAM_REALM || defaultSteamRealm,
      apiKey: STEAM_API_KEY,
      providerURL: normalizeOpenIdProvider(STEAM_OPENID_PROVIDER),
      stateless: false
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
app.set('trust proxy', true);
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

function resolveRequestBaseUrl(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
  const host = forwardedHost || req.get('host');
  const protocol = forwardedProto || req.protocol || 'http';
  if (!host) return normalizedBaseUrl;
  return `${protocol}://${host}`;
}

function buildSteamAuthOptions(req, { persistForCallback = false } = {}) {
  const requestBaseUrl = resolveRequestBaseUrl(req);
  const runtimeRealm = `${requestBaseUrl}/`;
  const runtimeReturnUrl = `${requestBaseUrl}/api/auth/steam/return`;
  const envRealm = STEAM_REALM || defaultSteamRealm;
  const envReturnUrl = STEAM_RETURN_URL || defaultSteamReturnUrl;

  const hasExplicitSteamAuthUrl = Boolean(process.env.STEAM_REALM || process.env.STEAM_RETURN_URL);
  let realm = hasExplicitSteamAuthUrl ? envRealm : runtimeRealm;
  let returnURL = hasExplicitSteamAuthUrl ? envReturnUrl : runtimeReturnUrl;

  if (persistForCallback && req.session) {
    req.session.steamAuth = {
      realm,
      returnURL,
      createdAt: Date.now()
    };
  } else if (!persistForCallback && req.session?.steamAuth) {
    realm = req.session.steamAuth.realm || realm;
    returnURL = req.session.steamAuth.returnURL || returnURL;
  }

  return {
    failureRedirect: '/',
    realm,
    returnURL
  };
}

const canonicalBaseUrl = new URL(normalizedBaseUrl);
function getCanonicalRedirect(req) {
  const host = String(req.get('host') ?? '').trim();
  if (!host) return null;
  if (host === canonicalBaseUrl.host) return null;
  const target = new URL(req.originalUrl || '/', canonicalBaseUrl);
  return target.toString();
}

app.get('/api/auth/steam', (req, res, next) => {
  const canonicalRedirect = getCanonicalRedirect(req);
  if (canonicalRedirect) {
    console.warn('[WARN] Steam OpenID start host mismatch, redirecting to canonical host', {
      currentHost: req.get('host'),
      canonicalHost: canonicalBaseUrl.host,
      redirect: canonicalRedirect
    });
    return res.redirect(canonicalRedirect);
  }
  const authOptions = buildSteamAuthOptions(req, { persistForCallback: true });
  console.log('[INFO] Steam OpenID start', {
    host: req.get('host'),
    forwardedHost: req.headers['x-forwarded-host'] ?? null,
    forwardedProto: req.headers['x-forwarded-proto'] ?? null,
    realm: authOptions.realm,
    returnURL: authOptions.returnURL
  });
  passport.authenticate('steam', authOptions)(req, res, next);
});

app.get('/api/auth/steam/return', (req, res, next) => {
  const canonicalRedirect = getCanonicalRedirect(req);
  if (canonicalRedirect) {
    console.warn('[WARN] Steam OpenID return host mismatch, redirecting to canonical host', {
      currentHost: req.get('host'),
      canonicalHost: canonicalBaseUrl.host,
      redirect: canonicalRedirect
    });
    return res.redirect(canonicalRedirect);
  }
  const authOptions = buildSteamAuthOptions(req);
  console.log('[INFO] Steam OpenID return', {
    host: req.get('host'),
    forwardedHost: req.headers['x-forwarded-host'] ?? null,
    forwardedProto: req.headers['x-forwarded-proto'] ?? null,
    realm: authOptions.realm,
    returnURL: authOptions.returnURL,
    openidReturnTo: req.query['openid.return_to'] ?? null,
    openidClaimedId: req.query['openid.claimed_id'] ?? null,
    openidMode: req.query['openid.mode'] ?? null
  });

  passport.authenticate('steam', authOptions, (error, user) => {
    if (error) {
      console.error('[ERROR] Steam OpenID callback failed', {
        message: error.message,
        stack: error.stack,
        openidReturnTo: req.query['openid.return_to'] ?? null,
        expectedReturnURL: authOptions.returnURL,
        expectedRealm: authOptions.realm
      });
      return res.status(401).json({
        error: 'Steam OpenID callback failed',
        details: error.message,
        expectedReturnURL: authOptions.returnURL,
        expectedRealm: authOptions.realm,
        openidReturnTo: req.query['openid.return_to'] ?? null
      });
    }
    if (!user) {
      console.warn('[WARN] Steam OpenID callback returned no user');
      return res.redirect('/');
    }
    req.logIn(user, (loginError) => {
      if (loginError) {
        console.error('[ERROR] Failed to establish Steam session', loginError);
        return next(loginError);
      }
      if (req.session?.steamAuth) delete req.session.steamAuth;
      return res.redirect('/');
    });
  })(req, res, next);
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
    const decoded = decodeURIComponent(String(raw ?? '').trim());
    const normalized = /^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`;
    const url = new URL(normalized);
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
  const baseParams = {
    l: 'english',
    count: 5000
  };
  const baseHeaders = {
    Referer: 'https://steamcommunity.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };
  let data;
  try {
    const response = await http.get(invUrl, {
      params: baseParams,
      headers: baseHeaders
    });
    data = response.data;
  } catch (error) {
    const statusCode = error?.response?.status;
    if (statusCode === 400 && parsed.token) {
      try {
        const retryResponse = await http.get(invUrl, {
          params: {
            ...baseParams,
            trade_offer_access_token: parsed.token
          },
          headers: {
            ...baseHeaders,
            Referer: tradeUrl
          }
        });
        data = retryResponse.data;
      } catch (retryError) {
        if (retryError?.response?.status === 400) {
          const err = new Error('Steam 返回 400：交易链接无效，或该账户库存不可公开访问。');
          err.code = 400;
          throw err;
        }
        throw retryError;
      }
    } else if (statusCode === 400) {
      const err = new Error('Steam 返回 400：交易链接无效，或该账户库存不可公开访问。');
      err.code = 400;
      throw err;
    } else {
      throw error;
    }
  }

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
