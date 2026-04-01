import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 5173,
  BASE_URL = 'http://localhost:5173',
  SESSION_SECRET = 'dev-secret',
  STEAM_API_KEY,
  STEAM_REALM = `${BASE_URL}/`,
  STEAM_RETURN_URL = `${BASE_URL}/api/auth/steam/return`,
  STEAM_WEB_API = 'https://api.steampowered.com',
  CSFLOAT_INSPECT_API = 'https://api.csfloat.com'
} = process.env;

if (!STEAM_API_KEY) {
  console.warn('[WARN] Missing STEAM_API_KEY. Steam login/inventory API will not work.');
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(
  new SteamStrategy(
    {
      returnURL: STEAM_RETURN_URL,
      realm: STEAM_REALM,
      apiKey: STEAM_API_KEY
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
  const { data } = await axios.get(url, {
    params: {
      key: STEAM_API_KEY,
      steamid: steamId
    },
    timeout: 20000
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
  const { data } = await axios.get(invUrl, {
    params: {
      l: 'english',
      count: 5000
    },
    timeout: 25000
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
