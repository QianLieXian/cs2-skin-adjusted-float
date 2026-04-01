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
        floatValue: typeof it.floatvalue === 'number' ? it.floatvalue : 0.15
      }));

    res.json({
      note: 'Steam 官方库存接口通常不直接返回 float；你可将 floatvalue 字段替换为 CSFloat 检测结果。',
      inspectApi: `${CSFLOAT_INSPECT_API}/?url=<inspect_link>`,
      items: normalized
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch inventory',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
