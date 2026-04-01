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

  const fixedPorts = [
    STEAM_PROXY_PORT,
    MIXED_PROXY_PORT,
    CLASH_MIXED_PORT,
    STEAM_PROXY_PORT || MIXED_PROXY_PORT || CLASH_MIXED_PORT ? null : '26561'
  ]
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
  CSFLOAT_INSPECT_API = 'https://api.csfloat.com',
  PUBLIC_BASE_URL = ''
} = process.env;
const hasExplicitBaseUrl = Boolean(String(process.env.BASE_URL ?? '').trim());
const enforceCanonicalHost =
  String(process.env.ENFORCE_CANONICAL_HOST ?? '').toLowerCase() === 'true' || hasExplicitBaseUrl;

function normalizeOpenIdProvider(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'https://steamcommunity.com/openid';
  try {
    const url = new URL(value);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    if (normalizedPath === '/openid/login') {
      url.pathname = '/openid';
    }
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'https://steamcommunity.com/openid';
  }
}

function getOpenIdProviderCandidates(raw) {
  const primary = normalizeOpenIdProvider(raw);
  const candidates = [primary];
  const fallback = primary.endsWith('/openid')
    ? `${primary}/login`
    : primary.endsWith('/openid/login')
      ? primary.replace(/\/openid\/login$/, '/openid')
      : null;
  if (fallback && !candidates.includes(fallback)) candidates.push(fallback);
  return candidates;
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

if (!enforceCanonicalHost) {
  console.log('[INFO] Canonical host redirect disabled. Steam OpenID will use request host dynamically.');
}

if (!STEAM_API_KEY) {
  console.warn('[WARN] Missing STEAM_API_KEY. Steam login/inventory API will not work.');
}

const axiosConfig = {
  timeout: 25000,
  proxy: false
};

if (proxyUrl) {
  const proxyAgent = new ProxyAgent(proxyUrl);
  axiosConfig.httpAgent = proxyAgent;
  axiosConfig.httpsAgent = proxyAgent;
  axiosConfig.proxy = false;
}

const http = axios.create(axiosConfig);


async function getWithDirectFallback(url, config = {}) {
  try {
    return await http.get(url, config);
  } catch (error) {
    const code = String(error?.code ?? '');
    const isConnectionTimeout = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
    if (!proxyUrl || !isConnectionTimeout) throw error;
    console.warn(`[WARN] Request via proxy failed (${code}), retry direct connection: ${url}`);
    return axios.get(url, {
      ...config,
      timeout: axiosConfig.timeout,
      proxy: false
    });
  }
}

async function postWithDirectFallback(url, data, config = {}) {
  try {
    return await http.post(url, data, config);
  } catch (error) {
    const code = String(error?.code ?? '');
    const isConnectionTimeout = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
    if (!proxyUrl || !isConnectionTimeout) throw error;
    console.warn(`[WARN] Request via proxy failed (${code}), retry direct connection: ${url}`);
    return axios.post(url, data, {
      ...config,
      timeout: axiosConfig.timeout,
      proxy: false
    });
  }
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

function verifySteamProfile(_identifier, profile, done) {
  return done(null, {
    steamId: profile.id,
    personaName: profile.displayName
  });
}

function extractSteamIdFromClaimedId(claimedId) {
  const value = String(claimedId ?? '').trim();
  const match = value.match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/i);
  return match?.[1] ?? null;
}

function isReplayNonceError(error) {
  const raw = [
    error?.message,
    error?.openidError?.message,
    error?.cause?.message
  ]
    .filter(Boolean)
    .join(' | ')
    .toLowerCase();
  return raw.includes('replayed nonce') || raw.includes('invalid nonce');
}

async function verifySteamOpenIdAssertionManually(req) {
  const openIdPairs = Object.entries(req.query ?? {}).filter(([key]) => key.startsWith('openid.'));
  if (openIdPairs.length === 0) return null;

  const openidMode = String(req.query?.['openid.mode'] ?? '').trim();
  const openidNs = String(req.query?.['openid.ns'] ?? '').trim();
  const opEndpoint = String(req.query?.['openid.op_endpoint'] ?? '').trim();
  const claimedId = String(req.query?.['openid.claimed_id'] ?? '').trim();
  const returnTo = String(req.query?.['openid.return_to'] ?? '').trim();
  const steamId = extractSteamIdFromClaimedId(claimedId);
  const isKnownSteamEndpoint = [
    'https://steamcommunity.com/openid/login',
    'https://steamcommunity.com/openid'
  ].includes(opEndpoint);
  const expectedOptions = buildSteamAuthOptionsFromOpenIdReturnTo(req, buildSteamAuthOptions(req)) || buildSteamAuthOptions(req);
  const expectedReturnUrl = String(expectedOptions.returnURL ?? '').trim();

  if (
    openidMode !== 'id_res' ||
    openidNs !== 'http://specs.openid.net/auth/2.0' ||
    !steamId ||
    !isKnownSteamEndpoint ||
    !returnTo ||
    (expectedReturnUrl && returnTo !== expectedReturnUrl)
  ) {
    return null;
  }

  const payload = new URLSearchParams();
  for (const [key, rawValue] of openIdPairs) {
    if (rawValue == null) continue;
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) payload.append(key, String(item));
      continue;
    }
    payload.append(key, String(rawValue));
  }
  payload.set('openid.mode', 'check_authentication');

  const response = await postWithDirectFallback('https://steamcommunity.com/openid/login', payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const body = String(response.data ?? '');
  const isValid = /(?:^|\n)is_valid\s*:\s*true(?:\n|$)/i.test(body);
  if (!isValid) return null;

  return {
    steamId,
    personaName: `steam:${steamId}`
  };
}

function createSteamStrategy({ stateless = false } = {}) {
  return new SteamStrategy(
    {
      returnURL: STEAM_RETURN_URL || defaultSteamReturnUrl,
      realm: STEAM_REALM || defaultSteamRealm,
      apiKey: STEAM_API_KEY,
      providerURL: normalizeOpenIdProvider(STEAM_OPENID_PROVIDER),
      stateless
    },
    verifySteamProfile
  );
}

passport.use('steam', createSteamStrategy({ stateless: false }));
passport.use('steam-stateless', createSteamStrategy({ stateless: true }));

const openIdProviderCandidates = getOpenIdProviderCandidates(STEAM_OPENID_PROVIDER);
let currentProviderCandidateIndex = 0;

function getCurrentOpenIdProvider() {
  return openIdProviderCandidates[currentProviderCandidateIndex];
}

function trySwitchOpenIdProvider(error) {
  const message = String(error?.message ?? '');
  const isDiscoverError = message.includes('Failed to discover OP endpoint URL');
  const nextIndex = currentProviderCandidateIndex + 1;
  if (!isDiscoverError || nextIndex >= openIdProviderCandidates.length) return false;
  currentProviderCandidateIndex = nextIndex;
  const nextProvider = openIdProviderCandidates[currentProviderCandidateIndex];
  const strategyNames = ['steam', 'steam-stateless'];
  for (const strategyName of strategyNames) {
    const steamStrategy = passport._strategy?.(strategyName);
    if (steamStrategy) steamStrategy._providerURL = nextProvider;
  }
  console.warn(`[WARN] OpenID provider discover failed, switching to fallback provider: ${nextProvider}`);
  return true;
}

function applySteamAuthOptionsToStrategy(authOptions = {}) {
  const strategyNames = ['steam', 'steam-stateless'];
  const steamStrategies = strategyNames.map((name) => passport._strategy?.(name)).filter(Boolean);
  if (steamStrategies.length === 0) return;
  const nextReturnURL = String(authOptions.returnURL ?? '').trim();
  const nextRealm = String(authOptions.realm ?? '').trim();

  for (const steamStrategy of steamStrategies) {
    if (nextReturnURL && steamStrategy._relyingParty) {
      steamStrategy._relyingParty.returnUrl = nextReturnURL;
    }
    if (nextRealm && steamStrategy._relyingParty) {
      steamStrategy._relyingParty.realm = nextRealm;
    }
  }
}

function authenticateSteam(req, res, next, authOptions, callback, strategyName = 'steam') {
  applySteamAuthOptionsToStrategy(authOptions);
  const run = () => passport.authenticate(strategyName, authOptions, callback)(req, res, next);
  run();
}

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

app.use((req, _res, next) => {
  if (req.session?.steamClientOrigin) return next();
  const candidate = getHeaderBaseUrl(req.headers.origin) || getHeaderBaseUrl(req.headers.referer);
  if (candidate && !isLocalBaseUrl(candidate)) {
    req.session.steamClientOrigin = candidate;
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function isLocalHost(host) {
  const hostname = String(host ?? '').split(':')[0].trim().toLowerCase();
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function getHeaderBaseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function parseForwardedHeader(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const firstPart = value.split(',')[0] ?? '';
  const segments = firstPart.split(';').map((it) => it.trim());
  let proto = '';
  let host = '';
  for (const segment of segments) {
    const [k, v] = segment.split('=');
    if (!k || !v) continue;
    const key = k.trim().toLowerCase();
    const normalizedValue = v.trim().replace(/^"|"$/g, '');
    if (key === 'proto') proto = normalizedValue;
    if (key === 'host') host = normalizedValue;
  }
  if (!host) return null;
  const safeProto = proto || 'https';
  return `${safeProto}://${host}`;
}

function parseHeaderList(raw) {
  return String(raw ?? '')
    .split(',')
    .map((it) => it.trim())
    .filter(Boolean);
}

function pickPreferredHost(raw) {
  const hosts = parseHeaderList(raw);
  if (hosts.length === 0) return '';
  const nonLocal = hosts.find((host) => !isLocalHost(host));
  return nonLocal || hosts[0];
}

function pickPreferredProto(raw) {
  const protos = parseHeaderList(raw);
  return protos[0] || '';
}

function resolveClientOrigin(req) {
  const explicitOrigin = getHeaderBaseUrl(req.query.origin);
  if (explicitOrigin && !isLocalBaseUrl(explicitOrigin)) return explicitOrigin;
  if (req.session?.steamClientOrigin && !isLocalBaseUrl(req.session.steamClientOrigin)) {
    return req.session.steamClientOrigin;
  }

  const configuredPublicBaseUrl = getHeaderBaseUrl(PUBLIC_BASE_URL);
  if (configuredPublicBaseUrl && !isLocalBaseUrl(configuredPublicBaseUrl)) {
    return configuredPublicBaseUrl;
  }

  const forwardedBaseUrl = parseForwardedHeader(req.headers.forwarded);
  if (forwardedBaseUrl && !isLocalBaseUrl(forwardedBaseUrl)) return forwardedBaseUrl;

  const hostCandidates = [
    pickPreferredHost(req.headers['x-forwarded-host']),
    pickPreferredHost(req.headers['x-original-host']),
    pickPreferredHost(req.headers['x-real-host'])
  ].filter(Boolean);
  const protoCandidates = [
    pickPreferredProto(req.headers['x-forwarded-proto']),
    pickPreferredProto(req.headers['x-forwarded-protocol']),
    pickPreferredProto(req.headers['x-forwarded-scheme']),
    pickPreferredProto(req.headers['x-scheme']),
    req.protocol
  ].filter(Boolean);
  for (const host of hostCandidates) {
    if (isLocalHost(host)) continue;
    for (const proto of protoCandidates) {
      return `${proto}://${host}`;
    }
  }

  const refererBaseUrl = getHeaderBaseUrl(req.headers.referer);
  if (refererBaseUrl && !isLocalBaseUrl(refererBaseUrl)) return refererBaseUrl;

  const originBaseUrl = getHeaderBaseUrl(req.headers.origin);
  if (originBaseUrl && !isLocalBaseUrl(originBaseUrl)) return originBaseUrl;

  return null;
}

function resolveRequestBaseUrl(req) {
  const clientOrigin = resolveClientOrigin(req);
  if (clientOrigin) return clientOrigin;

  const forwardedProto = pickPreferredProto(req.headers['x-forwarded-proto']);
  const forwardedHost = pickPreferredHost(req.headers['x-forwarded-host']);
  const host = forwardedHost || req.get('host');
  const protocol = forwardedProto || req.protocol || 'http';

  if (host && !isLocalHost(host)) {
    return `${protocol}://${host}`;
  }

  const refererBaseUrl = getHeaderBaseUrl(req.headers.referer);
  if (refererBaseUrl) return refererBaseUrl;

  const originBaseUrl = getHeaderBaseUrl(req.headers.origin);
  if (originBaseUrl) return originBaseUrl;

  if (host) return `${protocol}://${host}`;
  return normalizedBaseUrl;
}

function isLocalBaseUrl(rawBaseUrl) {
  try {
    const url = new URL(rawBaseUrl);
    return isLocalHost(url.host);
  } catch {
    return false;
  }
}

function buildSteamAuthOptions(req, { persistForCallback = false } = {}) {
  const requestBaseUrl = resolveRequestBaseUrl(req);
  const runtimeRealm = `${requestBaseUrl}/`;
  const runtimeReturnUrl = `${requestBaseUrl}/api/auth/steam/return`;
  const envRealm = STEAM_REALM || defaultSteamRealm;
  const envReturnUrl = STEAM_RETURN_URL || defaultSteamReturnUrl;

  const hasExplicitSteamAuthUrl = Boolean(process.env.STEAM_REALM || process.env.STEAM_RETURN_URL);
  const explicitAuthTargetsLocalhost = isLocalBaseUrl(envRealm) && isLocalBaseUrl(envReturnUrl);
  const requestUsesPublicHost = !isLocalBaseUrl(requestBaseUrl);
  const shouldPreferRuntimeAuthUrl = hasExplicitSteamAuthUrl && explicitAuthTargetsLocalhost && requestUsesPublicHost;

  let realm = hasExplicitSteamAuthUrl && !shouldPreferRuntimeAuthUrl ? envRealm : runtimeRealm;
  let returnURL = hasExplicitSteamAuthUrl && !shouldPreferRuntimeAuthUrl ? envReturnUrl : runtimeReturnUrl;

  if (shouldPreferRuntimeAuthUrl) {
    console.warn('[WARN] STEAM_REALM/STEAM_RETURN_URL points to localhost but request is public host, using runtime host for Steam OpenID', {
      configuredRealm: envRealm,
      configuredReturnURL: envReturnUrl,
      runtimeRealm,
      runtimeReturnURL
    });
  }

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

function buildSteamAuthOptionsFromOpenIdReturnTo(req, authOptions = {}) {
  const openidReturnToRaw = String(req.query?.['openid.return_to'] ?? '').trim();
  if (!openidReturnToRaw) return null;
  try {
    const parsed = new URL(openidReturnToRaw);
    const realm = `${parsed.origin}/`;
    return {
      ...authOptions,
      realm,
      returnURL: openidReturnToRaw
    };
  } catch {
    return null;
  }
}

const canonicalBaseUrl = new URL(normalizedBaseUrl);
function getCanonicalRedirect(req) {
  if (!enforceCanonicalHost) return null;
  if (isLocalHost(canonicalBaseUrl.host)) return null;
  const host = String(req.get('host') ?? '').trim();
  if (!host) return null;
  if (host === canonicalBaseUrl.host) return null;
  const target = new URL(req.originalUrl || '/', canonicalBaseUrl);
  return target.toString();
}

app.get('/api/auth/steam', (req, res, next) => {
  if (req.session) {
    const clientOrigin = resolveClientOrigin(req);
    if (clientOrigin) req.session.steamClientOrigin = clientOrigin;
  }
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
    returnURL: authOptions.returnURL,
    providerURL: getCurrentOpenIdProvider()
  });
  authenticateSteam(req, res, next, authOptions);
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

  authenticateSteam(req, res, next, authOptions, (error, user) => {
    if (error) {
      const shouldManualFallbackFirst = isReplayNonceError(error) && !req.__steamRetriedWithManualAssertion;
      if (shouldManualFallbackFirst) {
        req.__steamRetriedWithManualAssertion = true;
        console.warn('[WARN] Steam OpenID callback failed with replay/invalid nonce, trying direct check_authentication fallback first', {
          expectedReturnURL: authOptions.returnURL,
          openidReturnTo: req.query['openid.return_to'] ?? null
        });
        return verifySteamOpenIdAssertionManually(req)
          .then((fallbackUser) => {
            if (!fallbackUser) return null;
            return req.logIn(fallbackUser, (loginError) => {
              if (loginError) {
                console.error('[ERROR] Failed to establish Steam session after manual nonce fallback', loginError);
                return next(loginError);
              }
              if (req.session?.steamAuth) delete req.session.steamAuth;
              if (req.session?.steamClientOrigin) delete req.session.steamClientOrigin;
              console.warn('[WARN] Steam OpenID callback accepted via manual nonce fallback', {
                steamId: fallbackUser.steamId
              });
              return res.redirect('/');
            });
          })
          .then((handled) => {
            if (handled !== null) return;
            if (trySwitchOpenIdProvider(error)) {
              return authenticateSteam(req, res, next, authOptions);
            }
            return res.status(401).json({
              error: 'Steam OpenID callback failed',
              details: error.message,
              cause: error?.openidError?.message ?? error?.cause?.message ?? null,
              expectedReturnURL: authOptions.returnURL,
              expectedRealm: authOptions.realm,
              openidReturnTo: req.query['openid.return_to'] ?? null
            });
          })
          .catch((fallbackError) => {
            console.error('[ERROR] Steam OpenID manual nonce fallback failed', fallbackError);
            return res.status(401).json({
              error: 'Steam OpenID callback failed',
              details: error.message,
              cause: error?.openidError?.message ?? error?.cause?.message ?? null,
              expectedReturnURL: authOptions.returnURL,
              expectedRealm: authOptions.realm,
              openidReturnTo: req.query['openid.return_to'] ?? null
            });
          });
      }

      const shouldRetryWithOpenIdReturnTo =
        /Failed to verify assertion/i.test(String(error.message ?? '')) &&
        !req.__steamRetriedWithOpenIdReturnTo;
      if (shouldRetryWithOpenIdReturnTo) {
        const retryAuthOptions = buildSteamAuthOptionsFromOpenIdReturnTo(req, authOptions);
        if (retryAuthOptions) {
          req.__steamRetriedWithOpenIdReturnTo = true;
          console.warn('[WARN] Steam OpenID callback verify assertion failed, retry with openid.return_to + stateless strategy', {
            previousReturnURL: authOptions.returnURL,
            retryReturnURL: retryAuthOptions.returnURL,
            previousRealm: authOptions.realm,
            retryRealm: retryAuthOptions.realm
          });
          return authenticateSteam(req, res, next, retryAuthOptions, (retryError, retryUser) => {
            if (retryError) {
              error = retryError;
              user = retryUser;
            } else {
              error = null;
              user = retryUser;
            }
            if (!error) {
              if (!user) {
                console.warn('[WARN] Steam OpenID callback retry returned no user');
                return res.redirect('/');
              }
              return req.logIn(user, (loginError) => {
                if (loginError) {
                  console.error('[ERROR] Failed to establish Steam session after retry', loginError);
                  return next(loginError);
                }
                if (req.session?.steamAuth) delete req.session.steamAuth;
                if (req.session?.steamClientOrigin) delete req.session.steamClientOrigin;
                return res.redirect('/');
              });
            }
            if (trySwitchOpenIdProvider(error)) {
              return authenticateSteam(req, res, next, authOptions);
            }
            console.error('[ERROR] Steam OpenID callback failed after retry', {
              message: error.message,
              cause: error?.openidError?.message ?? error?.cause?.message ?? null,
              stack: error.stack,
              openidReturnTo: req.query['openid.return_to'] ?? null,
              expectedReturnURL: retryAuthOptions.returnURL,
              expectedRealm: retryAuthOptions.realm
            });
            return verifySteamOpenIdAssertionManually(req)
              .then((fallbackUser) => {
                if (!fallbackUser) {
                  return res.status(401).json({
                    error: 'Steam OpenID callback failed',
                    details: error.message,
                    cause: error?.openidError?.message ?? error?.cause?.message ?? null,
                    expectedReturnURL: retryAuthOptions.returnURL,
                    expectedRealm: retryAuthOptions.realm,
                    openidReturnTo: req.query['openid.return_to'] ?? null
                  });
                }
                console.warn('[WARN] Steam OpenID callback accepted via manual check_authentication fallback', {
                  steamId: fallbackUser.steamId,
                  expectedReturnURL: retryAuthOptions.returnURL,
                  openidReturnTo: req.query['openid.return_to'] ?? null
                });
                return req.logIn(fallbackUser, (loginError) => {
                  if (loginError) {
                    console.error('[ERROR] Failed to establish Steam session after manual fallback', loginError);
                    return next(loginError);
                  }
                  if (req.session?.steamAuth) delete req.session.steamAuth;
                  if (req.session?.steamClientOrigin) delete req.session.steamClientOrigin;
                  return res.redirect('/');
                });
              })
              .catch((fallbackError) => {
                console.error('[ERROR] Steam OpenID manual fallback failed', fallbackError);
                return res.status(401).json({
                  error: 'Steam OpenID callback failed',
                  details: error.message,
                  cause: error?.openidError?.message ?? error?.cause?.message ?? null,
                  expectedReturnURL: retryAuthOptions.returnURL,
                  expectedRealm: retryAuthOptions.realm,
                  openidReturnTo: req.query['openid.return_to'] ?? null
                });
              });
          }, 'steam-stateless');
        }
      }
      if (trySwitchOpenIdProvider(error)) {
        return authenticateSteam(req, res, next, authOptions);
      }
      console.error('[ERROR] Steam OpenID callback failed', {
        message: error.message,
        cause: error?.openidError?.message ?? error?.cause?.message ?? null,
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
      if (req.session?.steamClientOrigin) delete req.session.steamClientOrigin;
      return res.redirect('/');
    });
  });
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
    const response = await getWithDirectFallback(invUrl, {
      params: baseParams,
      headers: baseHeaders
    });
    data = response.data;
  } catch (error) {
    const statusCode = error?.response?.status;
    if (statusCode === 400 && parsed.token) {
      try {
        const retryResponse = await getWithDirectFallback(invUrl, {
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
