import dotenv from 'dotenv';
import net from 'node:net';

dotenv.config();

const LOG_BUFFER_LIMIT = Number(process.env.LOG_BUFFER_LIMIT ?? 2000);
const logBuffer = [];
const runtimeVerbose = process.argv.includes('--verbose') || String(process.env.VERBOSE ?? '').toLowerCase() === 'true';
const rawConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function pushLogEntry(level, args) {
  const rendered = args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
  const entry = `[${new Date().toISOString()}] [${level}] ${rendered}`;
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
  }
}

console.log = (...args) => {
  pushLogEntry('INFO', args);
  rawConsole.log(...args);
};
console.info = (...args) => {
  pushLogEntry('INFO', args);
  rawConsole.info(...args);
};
console.warn = (...args) => {
  pushLogEntry('WARN', args);
  rawConsole.warn(...args);
};
console.error = (...args) => {
  pushLogEntry('ERROR', args);
  rawConsole.error(...args);
};

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
  console.warn('[WARN] Proxy env is set but invalid. Expected formats like http://127.0.0.1:26561 or socks5://127.0.0.1:26561');
}

// 注意：不再清理用户的代理环境变量，避免破坏用户本机代理链路。

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as SteamStrategy } from 'passport-steam';
import axios from 'axios';
import { decodeLink as decodeCs2InspectLink } from '@csfloat/cs2-inspect-serializer';
import { ProxyAgent } from 'proxy-agent';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COLLECTION_DATA_PATH = path.join(__dirname, 'public', 'data', 'collection_skins.json');

const {
  PORT = 5173,
  BASE_URL = 'http://localhost:5173',
  SESSION_SECRET = 'dev-secret',
  STEAM_API_KEY,
  STEAM_REALM = `${BASE_URL}/`,
  STEAM_RETURN_URL = `${BASE_URL}/api/auth/steam/return`,
  STEAM_OPENID_PROVIDER = 'https://steamcommunity.com/openid',
  STEAM_WEB_API = 'https://api.steampowered.com',
  CSFLOAT_INSPECT_API = 'https://api.csgofloat.com',
  CSFLOAT_INSPECT_API_FALLBACKS = '',
  STEAMDT_API_BASE = 'https://open.steamdt.com',
  STEAMDT_API_KEY = '',
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
  console.warn('[WARN] Missing STEAM_API_KEY in .env. You can still provide apiKey from frontend query/header per request.');
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
const proxyBypassHosts = new Set();
const proxyBypassNoticeHosts = new Set();

function extractHostnameFromUrl(rawUrl) {
  try {
    return new URL(String(rawUrl ?? '')).hostname;
  } catch {
    return '';
  }
}

function shouldBypassProxy(url) {
  const host = extractHostnameFromUrl(url);
  if (!host) return false;
  return proxyBypassHosts.has(host);
}

function markProxyBypass(url, code) {
  const host = extractHostnameFromUrl(url);
  if (!host) return;
  proxyBypassHosts.add(host);
  if (proxyBypassNoticeHosts.has(host)) return;
  proxyBypassNoticeHosts.add(host);
  console.warn(`[WARN] Proxy unstable for ${host} (${code}), subsequent requests will use direct connection.`);
}

function normalizeMarketHashName(raw = '') {
  return String(raw ?? '')
    .replace(/^StatTrak™\s*/i, '')
    .replace(/^Souvenir\s+/i, '')
    .replace(/\s+\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i, '')
    .trim();
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
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0 && num <= 1) return num;
  }
  return null;
}

function parseFloatFromSteamDtResponse(payload) {
  const candidates = [
    payload?.data?.itemPreviewData?.paintwear,
    payload?.data?.itemPreviewData?.floatWear,
    payload?.data?.paintwear,
    payload?.data?.floatWear
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0 && num <= 1) return num;
  }
  return null;
}

function collectEncodedInspectLinkCandidates(rawInspectLink = '') {
  const raw = String(rawInspectLink ?? '').trim();
  if (!raw) return [];

  const candidates = [];
  const push = (value) => {
    const normalized = String(value ?? '').trim();
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  push(raw);
  const decodedOnce = safeDecodeURIComponent(raw);
  push(decodedOnce);

  const extractPreviewPayload = (value = '') => {
    const text = String(value ?? '').trim();
    if (!text) return;
    const previewMatch = text.match(/csgo_econ_action_preview(?:\s+|%20)([0-9a-f]{18,})/i);
    if (!previewMatch) return;
    push(`steam://rungame/730/76561202255233023/+csgo_econ_action_preview ${previewMatch[1].toUpperCase()}`);
  };

  extractPreviewPayload(raw);
  extractPreviewPayload(decodedOnce);

  for (const value of [raw, decodedOnce]) {
    try {
      const parsed = new URL(value);
      const wrapped = parsed.searchParams.get('url');
      if (wrapped) {
        push(wrapped);
        push(safeDecodeURIComponent(wrapped));
        extractPreviewPayload(wrapped);
      }
    } catch {
      // ignore non-url variants
    }
  }

  return candidates;
}

function parseFloatFromEncodedInspectLink(rawInspectLink = '') {
  const candidates = collectEncodedInspectLinkCandidates(rawInspectLink);
  if (candidates.length === 0) return null;

  for (const inspectLink of candidates) {
    try {
      const decoded = decodeCs2InspectLink(inspectLink);
      const values = [decoded?.paintwear, decoded?.floatvalue, decoded?.float];
      for (const value of values) {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0 && num <= 1) return num;
      }
    } catch {
      // ignore parse failures for legacy inspect links
    }
  }

  return null;
}

function safeDecodeURIComponent(raw = '') {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURIComponent(value.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
    } catch {
      return value;
    }
  }
}

function parseInspectLinkParams(rawInspectLink = '') {
  const raw = String(rawInspectLink ?? '').trim();
  if (!raw) return null;
  const variants = [raw];
  const decoded = safeDecodeURIComponent(raw);
  if (decoded && decoded !== raw) variants.push(decoded);

  const parseVariant = (value) => {
    const normalized = String(value ?? '').replace(/\+/g, ' ');
    const previewMatch = normalized.match(/(?:csgo_econ_action_preview(?:\s+|%20))([SM])(\d+)A(\d+)D(\d+)/i);
    if (previewMatch) {
      const [, type, ownerOrMarketId, assetId, d] = previewMatch;
      const params = { a: assetId, d };
      if (type.toUpperCase() === 'S') params.s = ownerOrMarketId;
      if (type.toUpperCase() === 'M') params.m = ownerOrMarketId;
      return params;
    }

    const query = normalized.match(/[?&]a=(\d+).*?[?&]d=(\d+)/i);
    if (query) {
      const [, a, d] = query;
      const params = { a, d };
      const s = normalized.match(/[?&]s=(\d+)/i);
      const m = normalized.match(/[?&]m=(\d+)/i);
      if (s) params.s = s[1];
      if (m) params.m = m[1];
      return params;
    }
    return null;
  };

  for (const variant of variants) {
    const parsed = parseVariant(variant);
    if (parsed) return parsed;
  }
  return null;
}

function resolveInspectApiCandidates() {
  const rawEnvList = String(CSFLOAT_INSPECT_API_FALLBACKS ?? '')
    .split(',')
    .map((it) => String(it ?? '').trim())
    .filter(Boolean);
  const rawCandidates = [CSFLOAT_INSPECT_API, ...rawEnvList, 'https://api.csgofloat.com', 'https://api.csfloat.com'];
  const normalized = [];
  for (const raw of rawCandidates) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      const normalizedUrl = parsed.toString().replace(/\/+$/, '');
      if (normalized.includes(normalizedUrl)) continue;
      normalized.push(normalizedUrl);
    } catch {
      // ignore malformed candidate
    }
  }
  return normalized;
}

const INSPECT_API_CANDIDATES = resolveInspectApiCandidates();
const inspectApiRuntime = {
  blocked: false,
  reason: ''
};

function detectInspectApiBlocked(error) {
  const status = Number(error?.response?.status ?? 0);
  const data = error?.response?.data;
  const message = String(data?.error ?? data?.message ?? error?.message ?? '').toLowerCase();
  const code = Number(data?.code ?? 0);
  return (status === 429 && (code === 16 || message.includes('temporarily not allowed'))) || message.includes('rate limit');
}

function markInspectApiBlocked(error) {
  if (inspectApiRuntime.blocked) return;
  inspectApiRuntime.blocked = true;
  inspectApiRuntime.reason = String(error?.response?.data?.error ?? error?.message ?? 'Inspect API temporarily blocked');
  console.warn('[WARN] Inspect API appears temporarily blocked, will skip repetitive remote inspect requests for this process.', {
    reason: inspectApiRuntime.reason
  });
}

async function getInspectFloatByUrl(inspectLink) {
  if (inspectApiRuntime.blocked) return null;
  for (const baseUrl of INSPECT_API_CANDIDATES) {
    try {
      const response = await getWithDirectFallback(baseUrl, {
        params: { url: inspectLink },
        timeout: 5500
      });
      const parsed = parseFloatFromInspectResponse(response?.data);
      if (typeof parsed === 'number') return parsed;
    } catch (error) {
      if (detectInspectApiBlocked(error)) {
        markInspectApiBlocked(error);
        return null;
      }
      // try next candidate
    }
  }
  return null;
}

async function getInspectFloatBySteamDt(inspectLink, steamDtApiKey = '') {
  const key = String(steamDtApiKey ?? '').trim();
  if (!key || !inspectLink) return null;
  const endpoint = `${String(STEAMDT_API_BASE).replace(/\/+$/, '')}/open/cs2/v1/wear`;
  try {
    const response = await postWithDirectFallback(endpoint, { inspectUrl: inspectLink }, {
      timeout: 6500,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    });
    return parseFloatFromSteamDtResponse(response?.data);
  } catch (error) {
    const message = String(error?.response?.data?.errorMsg ?? error?.response?.data?.message ?? error?.message ?? '');
    console.warn('[WARN] SteamDT inspect request failed', { message });
    return null;
  }
}

async function resolveFloatByInspectParams(params) {
  if (!params?.a || !params?.d) return null;
  if (inspectApiRuntime.blocked) return null;
  for (const baseUrl of INSPECT_API_CANDIDATES) {
    try {
      const response = await getWithDirectFallback(baseUrl, {
        params,
        timeout: 6500
      });
      const parsed = parseFloatFromInspectResponse(response?.data);
      if (typeof parsed === 'number') return parsed;
    } catch (error) {
      if (detectInspectApiBlocked(error)) {
        markInspectApiBlocked(error);
        return null;
      }
      // try next candidate
    }
  }
  return null;
}

function buildSkinDictionary() {
  try {
    const raw = fs.readFileSync(COLLECTION_DATA_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const skin of parsed?.skins ?? []) {
      const key = normalizeMarketHashName(skin.name).toLowerCase();
      if (!key) continue;
      map.set(key, {
        name: skin.name,
        rarity: skin.rarity,
        collections: skin.collections ?? [],
        minFloat: Number(skin.minFloat ?? 0),
        maxFloat: Number(skin.maxFloat ?? 1)
      });
    }
    return map;
  } catch (error) {
    console.error('[ERROR] Failed to load local skin dictionary', error);
    return new Map();
  }
}

const skinDictionary = buildSkinDictionary();

async function resolveFloatFromInspectLink(item = {}, steamDtApiKey = '') {
  if (typeof item.floatValue === 'number') return item.floatValue;
  if (!item.inspectLink) return null;
  const inspectCandidates = buildInspectLinkCandidates(item.inspectLink);
  if (inspectCandidates.length === 0) return null;

  for (const inspectLink of inspectCandidates) {
    const decodedFromInspectLink = parseFloatFromEncodedInspectLink(inspectLink);
    if (typeof decodedFromInspectLink === 'number') return decodedFromInspectLink;

    let inspectParams = null;
    try {
      inspectParams = parseInspectLinkParams(inspectLink);
    } catch {
      inspectParams = null;
    }
    if (inspectParams) {
      const parsedByParams = await resolveFloatByInspectParams(inspectParams);
      if (typeof parsedByParams === 'number') return parsedByParams;
    }

    const parsedBySteamDt = await getInspectFloatBySteamDt(inspectLink, steamDtApiKey);
    if (typeof parsedBySteamDt === 'number') return parsedBySteamDt;

    const parsedByUrl = await getInspectFloatByUrl(inspectLink);
    if (typeof parsedByUrl === 'number') return parsedByUrl;
  }
  return null;
}

async function resolveMissingFloatsByBulkInspect(items = []) {
  if (inspectApiRuntime.blocked) return items;
  const pending = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => typeof item.floatValue !== 'number' && item.inspectLink);
  if (pending.length === 0) return items;

  const byInspectLink = new Map();
  for (const entry of pending) {
    const key = String(entry.item.inspectLink);
    const list = byInspectLink.get(key) ?? [];
    list.push(entry.index);
    byInspectLink.set(key, list);
  }

  const uniqueLinks = [...byInspectLink.keys()];
  const chunkSize = 40;
  for (let offset = 0; offset < uniqueLinks.length; offset += chunkSize) {
    const chunkLinks = uniqueLinks.slice(offset, offset + chunkSize);
    for (const baseUrl of INSPECT_API_CANDIDATES) {
      try {
        const response = await postWithDirectFallback(`${baseUrl}/bulk`, {
          links: chunkLinks.map((link) => ({ link }))
        }, {
          timeout: 12000
        });
        const payload = response?.data;
        if (!payload || typeof payload !== 'object') continue;
        const parsedByLink = parseBulkInspectFloat(payload);
        for (const link of chunkLinks) {
          const linkParams = parseInspectLinkParams(link);
          const exactFloat = parsedByLink.get(link) ?? parsedByLink.get(`asset:${linkParams?.a ?? ''}`);
          if (typeof exactFloat !== 'number') continue;
          for (const index of byInspectLink.get(link) ?? []) {
            items[index] = {
              ...items[index],
              floatValue: exactFloat,
              floatSource: 'csfloat_inspect'
            };
          }
        }
        break;
      } catch (error) {
        if (detectInspectApiBlocked(error)) {
          markInspectApiBlocked(error);
          return items;
        }
        // try next candidate
      }
    }
  }
  return items;
}

function parseBulkInspectFloat(payload) {
  const byLink = new Map();
  const byAssetId = new Map();

  const addEntry = (entry = {}, keyHint = '') => {
    const exactFloat = parseFloatFromInspectResponse(entry);
    if (typeof exactFloat !== 'number') return;
    const link = String(entry?.inspectLink ?? entry?.link ?? entry?.url ?? keyHint ?? '').trim();
    const assetId = String(entry?.assetId ?? entry?.assetid ?? entry?.a ?? '').trim();
    if (link) byLink.set(link, exactFloat);
    if (assetId) byAssetId.set(assetId, exactFloat);
  };

  if (Array.isArray(payload)) {
    for (const entry of payload) addEntry(entry);
  } else if (payload && typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) {
        for (const nested of value) addEntry(nested, key);
      } else {
        addEntry(value, key);
      }
    }
  }

  const resolved = new Map();
  for (const [link, exactFloat] of byLink.entries()) {
    resolved.set(link, exactFloat);
  }
  for (const [assetId, exactFloat] of byAssetId.entries()) {
    resolved.set(`asset:${assetId}`, exactFloat);
    for (const [link] of byLink.entries()) {
      const linkParams = parseInspectLinkParams(link);
      if (linkParams?.a === assetId && !resolved.has(link)) {
        resolved.set(link, exactFloat);
      }
    }
  }
  return resolved;
}

const exteriorFloatRanges = {
  'Factory New': [0.0, 0.07],
  'Minimal Wear': [0.07, 0.15],
  'Field-Tested': [0.15, 0.38],
  'Well-Worn': [0.38, 0.45],
  'Battle-Scarred': [0.45, 1.0]
};

function estimateFloatFromExterior(exterior, minFloat, maxFloat) {
  const range = exteriorFloatRanges[String(exterior ?? '').trim()];
  if (!range) return null;
  const min = Number(minFloat);
  const max = Number(maxFloat);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const lower = Math.max(min, range[0]);
  const upper = Math.min(max, range[1]);
  if (upper < lower) return null;
  return (lower + upper) / 2;
}

async function resolveMissingFloats(items = [], steamDtApiKey = '') {
  await resolveMissingFloatsByBulkInspect(items);
  const inspectFloatCache = new Map();
  const queue = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => typeof item.floatValue !== 'number' && item.inspectLink);
  const concurrency = 6;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }).map(async () => {
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current) break;
      const cacheKey = String(current.item.inspectLink);
      if (inspectFloatCache.has(cacheKey)) {
        const cachedFloat = inspectFloatCache.get(cacheKey);
        if (typeof cachedFloat === 'number') {
          items[current.index] = {
            ...items[current.index],
            floatValue: cachedFloat,
            floatSource: 'csfloat_inspect'
          };
        }
        continue;
      }
      const exactFloat = await resolveFloatFromInspectLink(current.item, steamDtApiKey);
      inspectFloatCache.set(cacheKey, exactFloat);
      if (typeof exactFloat === 'number') {
        items[current.index] = {
          ...items[current.index],
          floatValue: exactFloat,
          floatSource: String(steamDtApiKey ?? '').trim() ? 'steamdt_inspect' : 'csfloat_inspect'
        };
      }
    }
  });
  await Promise.all(workers);
  return items;
}

function enrichInventoryItem(item = {}) {
  const originalName = String(item.marketHashName ?? '').trim();
  const normalizedName = normalizeMarketHashName(originalName);
  const skinMeta = skinDictionary.get(normalizedName.toLowerCase()) ?? null;
  const isSouvenir = /^Souvenir\s+/i.test(originalName);
  const isStatTrak = /^StatTrak™\s*/i.test(originalName);
  const hasExactFloat = typeof item.floatValue === 'number';
  const estimatedFloat = !hasExactFloat
    ? estimateFloatFromExterior(item.exterior, skinMeta?.minFloat ?? 0, skinMeta?.maxFloat ?? 1)
    : null;
  const floatValue = hasExactFloat ? item.floatValue : estimatedFloat;
  const floatSource = hasExactFloat ? 'api' : typeof estimatedFloat === 'number' ? 'estimated_from_exterior' : 'missing';
  return {
    ...item,
    marketHashName: normalizedName || originalName,
    originalMarketHashName: originalName || normalizedName,
    floatValue,
    floatSource,
    exterior: item.exterior ?? null,
    isSouvenir,
    isStatTrak,
    collection: skinMeta?.collections?.[0] ?? null,
    rarity: skinMeta?.rarity ?? null,
    eligibleForTradeup: !isSouvenir
  };
}

async function enrichInventory(items = [], steamDtApiKey = '') {
  const baseItems = items.map(enrichInventoryItem);
  await resolveMissingFloats(baseItems, steamDtApiKey);
  return baseItems;
}

async function withInventoryMeta(result = {}, steamDtApiKey = '') {
  const enrichedItems = await enrichInventory(result.items ?? [], steamDtApiKey);
  const materialCount = enrichedItems.filter((it) => it.eligibleForTradeup).length;
  const missingFloatCount = enrichedItems.filter((it) => typeof it.floatValue !== 'number').length;
  const dictionaryMatchedCount = enrichedItems.filter((it) => it.collection && it.rarity).length;
  const exactFloatCount = enrichedItems.filter((it) => ['api', 'csfloat_inspect', 'steamdt_inspect'].includes(it.floatSource)).length;
  const estimatedFloatCount = enrichedItems.filter((it) => it.floatSource === 'estimated_from_exterior').length;
  return {
    ...result,
    total: enrichedItems.length,
    items: enrichedItems,
    materialCount,
    missingFloatCount,
    dictionaryMatchedCount,
    exactFloatCount,
    estimatedFloatCount
  };
}

async function buildInventoryResponse(rawResult, note, steamDtApiKey = '') {
  const inspectNote = inspectApiRuntime.blocked
    ? ` Inspect API blocked: ${inspectApiRuntime.reason}. Float 缺失项已使用外观区间估算兜底。`
    : '';
  return await withInventoryMeta({
    ...rawResult,
    inspectApi: `${INSPECT_API_CANDIDATES[0] ?? CSFLOAT_INSPECT_API}/?url=<inspect_link>`,
    inspectApiSteamDt: `${String(STEAMDT_API_BASE).replace(/\/+$/, '')}/open/cs2/v1/wear`,
    inspectApiCandidates: INSPECT_API_CANDIDATES,
    inspectApiBlocked: inspectApiRuntime.blocked,
    note: `${note ?? ''}${inspectNote}`.trim()
  }, steamDtApiKey);
}


async function getWithDirectFallback(url, config = {}) {
  if (shouldBypassProxy(url)) {
    return axios.get(url, {
      ...config,
      timeout: config.timeout ?? axiosConfig.timeout,
      proxy: false
    });
  }
  try {
    return await http.get(url, config);
  } catch (error) {
    const code = String(error?.code ?? '');
    const isConnectionTimeout = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
    if (!proxyUrl || !isConnectionTimeout) throw error;
    console.warn(`[WARN] Request via proxy failed (${code}), retry direct connection: ${url}`);
    markProxyBypass(url, code);
    return axios.get(url, {
      ...config,
      timeout: config.timeout ?? axiosConfig.timeout,
      proxy: false
    });
  }
}

async function postWithDirectFallback(url, data, config = {}) {
  if (shouldBypassProxy(url)) {
    return axios.post(url, data, {
      ...config,
      timeout: config.timeout ?? axiosConfig.timeout,
      proxy: false
    });
  }
  try {
    return await http.post(url, data, config);
  } catch (error) {
    const code = String(error?.code ?? '');
    const isConnectionTimeout = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
    if (!proxyUrl || !isConnectionTimeout) throw error;
    console.warn(`[WARN] Request via proxy failed (${code}), retry direct connection: ${url}`);
    markProxyBypass(url, code);
    return axios.post(url, data, {
      ...config,
      timeout: config.timeout ?? axiosConfig.timeout,
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

function parseOpenIdNonceTimestamp(rawNonce) {
  const value = String(rawNonce ?? '').trim();
  if (!value) return null;
  const [timestamp] = value.split('Z');
  if (!timestamp) return null;
  const parsed = Date.parse(`${timestamp}Z`);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function buildSteamUserFromTrustedReplayNonce(req, authOptions = {}) {
  const openidMode = String(req.query?.['openid.mode'] ?? '').trim();
  const openidNs = String(req.query?.['openid.ns'] ?? '').trim();
  const opEndpoint = String(req.query?.['openid.op_endpoint'] ?? '').trim();
  const claimedId = String(req.query?.['openid.claimed_id'] ?? '').trim();
  const identity = String(req.query?.['openid.identity'] ?? '').trim();
  const returnTo = String(req.query?.['openid.return_to'] ?? '').trim();
  const responseNonce = String(req.query?.['openid.response_nonce'] ?? '').trim();
  const associationHandle = String(req.query?.['openid.assoc_handle'] ?? '').trim();
  const signature = String(req.query?.['openid.sig'] ?? '').trim();
  const signed = String(req.query?.['openid.signed'] ?? '').trim();
  const steamId = extractSteamIdFromClaimedId(claimedId);

  if (openidMode !== 'id_res' || openidNs !== 'http://specs.openid.net/auth/2.0') return null;
  if (!steamId) return null;
  if (identity && identity !== claimedId) return null;
  if (!returnTo || returnTo !== String(authOptions.returnURL ?? '').trim()) return null;
  if (!associationHandle || !signature || !signed) return null;

  const knownEndpoints = ['https://steamcommunity.com/openid/login', 'https://steamcommunity.com/openid'];
  if (!knownEndpoints.includes(opEndpoint)) return null;

  const nonceTimestamp = parseOpenIdNonceTimestamp(responseNonce);
  if (!nonceTimestamp) return null;
  const ageMs = Math.abs(Date.now() - nonceTimestamp);
  if (ageMs > 10 * 60 * 1000) return null;

  const sessionAuthCreatedAt = Number(req.session?.steamAuth?.createdAt ?? 0);
  if (sessionAuthCreatedAt > 0) {
    const callbackDelay = Date.now() - sessionAuthCreatedAt;
    if (callbackDelay < -60_000 || callbackDelay > 20 * 60 * 1000) return null;
  }

  return {
    steamId,
    personaName: `steam:${steamId}`
  };
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
if (runtimeVerbose) {
  console.log('[INFO] Verbose request logging enabled');
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = Math.random().toString(36).slice(2, 10);
    console.log('[VERBOSE] HTTP request start', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      host: req.get('host'),
      ip: req.ip
    });
    res.on('finish', () => {
      console.log('[VERBOSE] HTTP request end', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    });
    next();
  });
}
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
            const trustedReplayUser = buildSteamUserFromTrustedReplayNonce(req, authOptions);
            if (trustedReplayUser) {
              console.warn('[WARN] Steam OpenID callback accepted via trusted replay nonce fallback', {
                steamId: trustedReplayUser.steamId,
                expectedReturnURL: authOptions.returnURL
              });
              return req.logIn(trustedReplayUser, (loginError) => {
                if (loginError) {
                  console.error('[ERROR] Failed to establish Steam session after trusted replay nonce fallback', loginError);
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
                  const trustedReplayUser = buildSteamUserFromTrustedReplayNonce(req, retryAuthOptions);
                  if (trustedReplayUser) {
                    console.warn('[WARN] Steam OpenID callback accepted via trusted replay nonce fallback after retry', {
                      steamId: trustedReplayUser.steamId,
                      expectedReturnURL: retryAuthOptions.returnURL
                    });
                    return req.logIn(trustedReplayUser, (loginError) => {
                      if (loginError) {
                        console.error('[ERROR] Failed to establish Steam session after trusted replay nonce fallback', loginError);
                        return next(loginError);
                      }
                      if (req.session?.steamAuth) delete req.session.steamAuth;
                      if (req.session?.steamClientOrigin) delete req.session.steamClientOrigin;
                      return res.redirect('/');
                    });
                  }
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
    const decoded = safeDecodeURIComponent(raw);
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
  const cooldownPatterns = [
    /tradable after/i,
    /available after/i,
    /not tradable/i,
    /cannot be traded/i,
    /trade hold/i,
    /交易后.*可交易/i,
    /可在.*后交易/i,
    /不可交易/i,
    /交易冷却/i
  ];
  return desc
    .filter((d) => d?.value && cooldownPatterns.some((pattern) => pattern.test(String(d.value))))
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
    exterior: it.exterior ?? null,
    floatValue: typeof it.floatValue === 'number' ? it.floatValue : null
  }));
}

function extractExterior(desc = {}) {
  const tags = Array.isArray(desc?.tags) ? desc.tags : [];
  for (const tag of tags) {
    const category = String(tag?.category ?? tag?.category_name ?? '').toLowerCase();
    const name = String(tag?.localized_tag_name ?? tag?.name ?? '').trim();
    if ((category === 'exterior' || category.includes('wear')) && name) return name;
    if (name in exteriorFloatRanges) return name;
  }
  return null;
}

function normalizeInspectLink(rawLink = '', steamId = '', assetId = '') {
  const decoded = String(rawLink ?? '')
    .replace(/&amp;/g, '&')
    .trim();
  if (!decoded) return '';

  const owner = String(steamId ?? '').trim();
  const asset = String(assetId ?? '').trim();

  // 先替换 Steam 占位符，再做非法百分号兜底修复。
  // 如果先修复 `%`，会把 `%owner_steamid%` / `%assetid%` 变成 `%25...%25`，
  // 导致占位符替换失效，最终 inspect 链接不可用（float 全缺失）。
  const withPlaceholdersResolved = decoded
    .replace(/%(?:25)?owner_steamid%(?:25)?/gi, owner)
    .replace(/%(?:25)?assetid%(?:25)?/gi, asset);

  // 不在入口处全局转义 `%`，避免污染 CS2 新版自编码 inspect 链接。
  return withPlaceholdersResolved;
}

function buildInspectLinkCandidates(rawInspectLink = '') {
  const raw = String(rawInspectLink ?? '').trim();
  if (!raw) return [];
  const candidates = [];
  const push = (value) => {
    const normalized = String(value ?? '').trim();
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  push(raw);
  push(safeDecodeURIComponent(raw));
  // 兼容历史脏数据：保留“非法 % 修复版”作为兜底候选，而非覆盖原始 inspect link。
  push(raw.replace(/%(?![0-9a-fA-F]{2})/g, '%25'));
  return candidates;
}

function pickInspectLink(desc = {}, steamId = '', assetId = '') {
  const actionGroups = [desc.owner_actions, desc.actions, desc.market_actions];
  for (const group of actionGroups) {
    if (!Array.isArray(group)) continue;
    for (const action of group) {
      const link = String(action?.link ?? '');
      const name = String(action?.name ?? '');
      if (/Inspect in Game/i.test(name) || /csgo_econ_action_preview/i.test(link)) {
        const normalized = normalizeInspectLink(link, steamId, assetId);
        if (normalized) return normalized;
      }
    }
  }
  return '';
}

async function fetchInventory(steamId, apiKey) {
  const url = `${STEAM_WEB_API}/IEconItems_730/GetPlayerItems/v1/`;
  const { data } = await http.get(url, {
    params: {
      key: apiKey,
      steamid: steamId
    }
  });
  return data?.result?.items ?? [];
}

function parseAssetDescriptionInventoryPayload(payload, steamId) {
  const descriptions = new Map();
  for (const d of payload?.descriptions ?? []) {
    const classId = String(d?.classid ?? '');
    const instanceId = String(d?.instanceid ?? '0');
    if (!classId) continue;
    descriptions.set(`${classId}_${instanceId}`, d);
    descriptions.set(`${classId}_0`, d);
    descriptions.set(classId, d);
  }
  const assets = payload?.assets ?? payload?.items ?? [];
  const items = assets.map((asset) => {
    const classId = String(asset?.classid ?? '');
    const instanceId = String(asset?.instanceid ?? '0');
    const desc =
      descriptions.get(`${classId}_${instanceId}`) ??
      descriptions.get(`${classId}_0`) ??
      descriptions.get(classId) ??
      asset ??
      {};
    const inspectLink = pickInspectLink(desc, steamId, asset.assetid ?? asset.id ?? '');
    const cooldownText = extractCooldownText([...(desc.owner_descriptions ?? []), ...(desc.descriptions ?? [])]);
    const exterior = extractExterior(desc);
    const tradable = Number(desc.tradable ?? 1) === 1;
    const permanentUntradable =
      (desc.tags ?? []).some((tag) => String(tag?.internal_name ?? '').toLowerCase() === 'not_tradable') ||
      /不可交易|not tradable/i.test(String(desc.type ?? ''));
    return {
      id: String(asset.assetid ?? asset.id ?? ''),
      marketHashName: desc.market_hash_name ?? desc.marketHashName ?? '',
      iconUrl: desc.icon_url ? `https://community.fastly.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : '',
      inspectLink,
      tradable,
      cooldown: (!tradable && !permanentUntradable) || cooldownText.length > 0,
      cooldownText,
      exterior,
      floatValue: null
    };
  });
  return normalizeInventory(items.filter((it) => it.id));
}

function parseCommunityInventoryPayload(data, steamId) {
  return parseAssetDescriptionInventoryPayload(data, steamId);
}

function parseLegacyCommunityInventoryPayload(payload, steamId) {
  const rgInventory = payload?.rgInventory ?? {};
  const rgDescriptions = payload?.rgDescriptions ?? {};
  const assets = Object.values(rgInventory);
  const items = assets.map((asset) => {
    const key = `${asset.classid}_${asset.instanceid ?? '0'}`;
    const desc = rgDescriptions[key] ?? {};
    const inspectLink = pickInspectLink(desc, steamId, asset.id ?? asset.assetid ?? '');
    const cooldownText = extractCooldownText([...(desc.owner_descriptions ?? []), ...(desc.descriptions ?? [])]);
    const exterior = extractExterior(desc);
    const tradable = Number(desc.tradable ?? 1) === 1;
    const permanentUntradable =
      (desc.tags ?? []).some((tag) => String(tag?.internal_name ?? '').toLowerCase() === 'not_tradable') ||
      /不可交易|not tradable/i.test(String(desc.type ?? ''));
    return {
      id: String(asset.id ?? asset.assetid ?? ''),
      marketHashName: desc.market_hash_name ?? desc.marketHashName ?? '',
      iconUrl: desc.icon_url ? `https://community.fastly.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : '',
      inspectLink,
      tradable,
      cooldown: (!tradable && !permanentUntradable) || cooldownText.length > 0,
      cooldownText,
      exterior,
      floatValue: null
    };
  });
  return normalizeInventory(items.filter((it) => it.id));
}

async function fetchInventoryFromCommunity(steamId) {
  const headers = {
    Referer: 'https://steamcommunity.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };
  const primaryUrl = `https://steamcommunity.com/inventory/${steamId}/730/2`;

  const fetchCommunityPages = async (url, extraParams = {}) => {
    let startAssetId = null;
    const allItems = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await getWithDirectFallback(url, {
        params: {
          l: 'english',
          count: 2000,
          ...(startAssetId ? { start_assetid: startAssetId } : {}),
          ...extraParams
        },
        headers
      });
      const chunkItems = parseCommunityInventoryPayload(response.data, steamId);
      allItems.push(...chunkItems);
      const moreItems = Boolean(response?.data?.more_items);
      const lastAssetId = response?.data?.last_assetid;
      if (!moreItems || !lastAssetId) break;
      startAssetId = lastAssetId;
    }
    const deduped = [...new Map(allItems.map((it) => [it.id, it])).values()];
    return deduped;
  };

  try {
    const items = await fetchCommunityPages(primaryUrl);
    return {
      source: 'auth',
      total: items.length,
      cooldownCount: items.filter((it) => it.cooldown).length,
      items
    };
  } catch (primaryError) {
    const legacyUrl = `https://steamcommunity.com/profiles/${steamId}/inventory/json/730/2`;
    try {
      const response = await getWithDirectFallback(legacyUrl, {
        params: { l: 'english', count: 2000 },
        headers
      });
      const items = parseLegacyCommunityInventoryPayload(response.data, steamId);
      return {
        source: 'auth_legacy_json',
        total: items.length,
        cooldownCount: items.filter((it) => it.cooldown).length,
        items
      };
    } catch (legacyError) {
      const primaryStatus = Number(primaryError?.response?.status ?? 0);
      const legacyStatus = Number(legacyError?.response?.status ?? 0);
      const aggregateError = new Error(
        `Community inventory endpoints failed: /inventory/${steamId}/730/2(${primaryStatus || 'n/a'}) and /profiles/${steamId}/inventory/json/730/2(${legacyStatus || 'n/a'})`
      );
      aggregateError.response = legacyError?.response ?? primaryError?.response;
      throw aggregateError;
    }
  }
}

function assertEconServiceResult(result = {}) {
  const status = Number(result?.status ?? 1);
  if (!Number.isNaN(status) && status !== 1) {
    const detail = result?.statusDetail || result?.statusdetail || 'unknown status';
    const err = new Error(`IEconService rejected request: status=${status}, detail=${detail}`);
    err.response = { status };
    throw err;
  }
}

async function fetchInventoryFromEconService(steamId, apiKey) {
  const url = `${STEAM_WEB_API}/IEconService/GetInventoryItemsWithDescriptions/v1/`;
  let startAssetId = null;
  const allItems = [];
  for (let i = 0; i < 4; i += 1) {
    const { data } = await getWithDirectFallback(url, {
      params: {
        key: apiKey,
        steamid: steamId,
        appid: 730,
        contextid: 2,
        count: 2000,
        ...(startAssetId ? { start_assetid: startAssetId } : {})
      }
    });
    const result = data?.result ?? {};
    assertEconServiceResult(result);
    const chunk = parseAssetDescriptionInventoryPayload(result, steamId);
    allItems.push(...chunk);
    if (!result.more_items || !result.last_assetid) break;
    startAssetId = result.last_assetid;
  }
  const deduped = [...new Map(allItems.map((it) => [it.id, it])).values()];
  return {
    source: 'econ_service_api',
    total: deduped.length,
    cooldownCount: deduped.filter((it) => it.cooldown).length,
    items: deduped
  };
}

function resolveSteamApiKey(req) {
  const keyFromQuery = String(req?.query?.apiKey ?? '').trim();
  const keyFromHeader = String(req?.headers?.['x-steam-api-key'] ?? '').trim();
  const key = keyFromQuery || keyFromHeader || STEAM_API_KEY;
  return String(key ?? '').trim();
}

function resolveSteamDtApiKey(req) {
  const keyFromQuery = String(req?.query?.steamDtApiKey ?? '').trim();
  const keyFromHeader = String(req?.headers?.['x-steamdt-api-key'] ?? '').trim();
  const key = keyFromQuery || keyFromHeader || STEAMDT_API_KEY;
  return String(key ?? '').trim();
}

app.get('/api/inventory', requireAuth, async (req, res) => {
  const errors = [];
  const pushError = (source, error) => {
    const status = Number(error?.response?.status ?? 0);
    const message = String(error?.message ?? 'unknown error');
    errors.push({ source, status: status || null, message });
    console.error(`[ERROR] Inventory fetch failed via ${source}`, {
      steamId: req.user?.steamId ?? null,
      status: status || null,
      message
    });
  };

  try {
    const communityResult = await fetchInventoryFromCommunity(req.user.steamId);
    const apiKey = resolveSteamApiKey(req);
    const steamDtApiKey = resolveSteamDtApiKey(req);
    if (apiKey) {
      try {
        const econServiceResult = await fetchInventoryFromEconService(req.user.steamId, apiKey);
        if (econServiceResult.total > communityResult.total) {
          return res.json(await buildInventoryResponse(
            econServiceResult,
            '库存使用 IEconService 结果（数量高于社区库存），通常可覆盖更多冷却/限制物品。',
            steamDtApiKey
          ));
        }
      } catch (econServiceCompareError) {
        pushError('econ_service_compare', econServiceCompareError);
      }
    }
    return res.json(await buildInventoryResponse(
      communityResult,
      '库存优先来自 steamcommunity inventory 接口；官方 Web API 在 CS2 场景经常返回空结果。',
      steamDtApiKey
    ));
  } catch (error) {
    pushError('community', error);
    const apiKey = resolveSteamApiKey(req);
    const steamDtApiKey = resolveSteamDtApiKey(req);
    if (apiKey) {
      try {
        const econServiceResult = await fetchInventoryFromEconService(req.user.steamId, apiKey);
        if (econServiceResult.total > 0) {
          return res.json(await buildInventoryResponse(
            econServiceResult,
            '主链路失败后，已回退到 IEconService/GetInventoryItemsWithDescriptions。',
            steamDtApiKey
          ));
        }
        pushError('econ_service_empty', new Error('IEconService returned 0 items.'));
      } catch (econServiceError) {
        pushError('econ_service', econServiceError);
      }

      try {
        const items = await fetchInventory(req.user.steamId, apiKey);
        const normalized = items
          .filter((it) => it.inventory > 0)
          .map((it) => ({
            id: String(it.id),
            marketHashName: it.market_hash_name ?? '',
            floatValue: typeof it.floatvalue === 'number' ? it.floatvalue : null,
            tradable: true,
            cooldown: false,
            cooldownText: []
          }));
        const resultItems = normalizeInventory(normalized);
        if (resultItems.length > 0) {
          return res.json(await buildInventoryResponse({
            source: 'auth_legacy_api',
            total: resultItems.length,
            cooldownCount: 0,
            items: resultItems
          }, '回退到 Steam Web API（IEconItems_730）读取。若仍为 0，通常不是 key 问题而是该接口对 CS2 数据不完整。', steamDtApiKey));
        }
        pushError('legacy_econitems_empty', new Error('IEconItems_730 returned 0 items.'));
      } catch (legacyError) {
        pushError('legacy_econitems', legacyError);
      }
    }

    const statusCode = error?.response?.status;
    const hints = statusCode === 403 || statusCode === 400
      ? 'Steam 社区库存接口拒绝访问：请确认该账号库存公开可见，或改用“交易链接读取库存”。如果你确认库存公开且有物品，请检查代理出口 IP 是否被 Steam 风控。'
      : '请检查网络/代理设置，确认服务器能访问 steamcommunity.com。';
    return res.status(500).json(await withInventoryMeta({
      error: 'Failed to fetch inventory',
      details: `${error.message}。${hints}`,
      fallbackErrors: errors,
      source: 'auth',
      total: 0,
      cooldownCount: 0,
      items: []
    }, steamDtApiKey));
  }
});

app.get('/api/inventory/by-api-key', async (req, res) => {
  try {
    const steamId = String(req.query.steamId ?? '').trim();
    const apiKey = resolveSteamApiKey(req);
    const steamDtApiKey = resolveSteamDtApiKey(req);
    const fallbackErrors = [];
    const pushFallbackError = (source, error) => {
      fallbackErrors.push({
        source,
        status: Number(error?.response?.status ?? 0) || null,
        message: String(error?.message ?? 'unknown error')
      });
    };
    if (!steamId || !/^\d{17}$/.test(steamId)) {
      return res.status(400).json({ error: 'Missing or invalid steamId (expects 17-digit SteamID64).' });
    }
    if (!apiKey) {
      return res.status(400).json({ error: 'Missing Steam Web API Key. Provide it via query apiKey or x-steam-api-key.' });
    }
    try {
      const econServiceResult = await fetchInventoryFromEconService(steamId, apiKey);
      if (econServiceResult.total > 0) {
        return res.json(await buildInventoryResponse(econServiceResult, '通过 Steam Web API Key 直接读取库存（无需 Steam 登录会话）。', steamDtApiKey));
      }
      pushFallbackError('econ_service_empty', new Error('IEconService returned 0 items.'));
    } catch (error) {
      pushFallbackError('econ_service', error);
    }

    try {
      const communityResult = await fetchInventoryFromCommunity(steamId);
      if (communityResult.total > 0) {
        return res.json(await buildInventoryResponse(communityResult, 'IEconService 返回空后，已回退到 steamcommunity inventory 公开库存接口。', steamDtApiKey));
      }
      pushFallbackError('community_empty', new Error('steamcommunity inventory returned 0 items.'));
    } catch (error) {
      pushFallbackError('community', error);
    }

    try {
      const legacyItems = await fetchInventory(steamId, apiKey);
      const normalized = legacyItems
        .filter((it) => it.inventory > 0)
        .map((it) => ({
          id: String(it.id),
          marketHashName: it.market_hash_name ?? '',
          floatValue: typeof it.floatvalue === 'number' ? it.floatvalue : null,
          tradable: true,
          cooldown: false,
          cooldownText: []
        }));
      const resultItems = normalizeInventory(normalized);
      if (resultItems.length > 0) {
        return res.json(await buildInventoryResponse({
          source: 'legacy_econitems_api_key',
          total: resultItems.length,
          cooldownCount: 0,
          items: resultItems
        }, 'IEconService 与社区库存都为空后，回退到 IEconItems_730 旧接口。', steamDtApiKey));
      }
      pushFallbackError('legacy_econitems_empty', new Error('IEconItems_730 returned 0 items.'));
    } catch (error) {
      pushFallbackError('legacy_econitems', error);
    }

    return res.status(404).json(await withInventoryMeta({
      error: 'Inventory fetched but no items were returned',
      details: 'API Key 与回退链路均未返回任何库存数据。请确认 SteamID、库存公开状态、Key 域名绑定与代理出口。',
      source: 'api_key',
      total: 0,
      cooldownCount: 0,
      items: [],
      fallbackErrors
    }, steamDtApiKey));
  } catch (error) {
    const statusCode = Number(error?.response?.status ?? 0);
    const details = statusCode === 403
      ? `Steam API 拒绝访问（403）：请确认 API Key 有效且域名绑定正确。${error.message}`
      : error.message;
    return res.status(500).json({
      error: 'Failed to fetch inventory by API key',
      details
    });
  }
});

async function fetchPublicInventoryByTradeUrl(tradeUrl, steamDtApiKey = '') {
  const parsed = parseTradeUrl(tradeUrl);
  if (!parsed) {
    const err = new Error('Invalid trade offer URL');
    err.code = 400;
    throw err;
  }

  const invUrl = `https://steamcommunity.com/inventory/${parsed.steamId}/730/2`;
  const baseParams = {
    l: 'english'
  };
  const baseHeaders = {
    Referer: 'https://steamcommunity.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  };
  const fetchPages = async (extraParams = {}, extraHeaders = {}) => {
    let startAssetId = null;
    const allItems = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await getWithDirectFallback(invUrl, {
        params: {
          ...baseParams,
          count: 2000,
          ...(startAssetId ? { start_assetid: startAssetId } : {}),
          ...extraParams
        },
        headers: { ...baseHeaders, ...extraHeaders }
      });
      allItems.push(...parseCommunityInventoryPayload(response.data, parsed.steamId));
      const moreItems = Boolean(response?.data?.more_items);
      const lastAssetId = response?.data?.last_assetid;
      if (!moreItems || !lastAssetId) break;
      startAssetId = lastAssetId;
    }
    return [...new Map(allItems.map((it) => [it.id, it])).values()];
  };

  let items;
  try {
    items = await fetchPages();
  } catch (error) {
    const statusCode = error?.response?.status;
    if (statusCode === 400 && parsed.token) {
      try {
        items = await fetchPages(
          { trade_offer_access_token: parsed.token },
          { Referer: tradeUrl }
        );
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

  return await withInventoryMeta({
    source: 'trade_url',
    steamId: parsed.steamId,
    token: parsed.token ?? null,
    total: items.length,
    cooldownCount: items.filter((it) => it.cooldown).length,
    items
  }, steamDtApiKey);
}

app.get('/api/inventory/public', async (req, res) => {
  try {
    const tradeUrl = String(req.query.tradeUrl ?? '');
    const apiKey = resolveSteamApiKey(req);
    const steamDtApiKey = resolveSteamDtApiKey(req);
    if (!tradeUrl) {
      return res.status(400).json({ error: 'Missing tradeUrl query parameter' });
    }
    const parsed = parseTradeUrl(tradeUrl);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid tradeUrl query parameter' });
    }
    let result = await fetchPublicInventoryByTradeUrl(tradeUrl, steamDtApiKey);
    if (apiKey) {
      try {
        const econServiceResult = await fetchInventoryFromEconService(parsed.steamId, apiKey);
        if (econServiceResult.total > result.total) {
          result = await withInventoryMeta({
            ...econServiceResult,
            source: 'trade_url_econ_service_api',
            steamId: parsed.steamId,
            token: parsed.token ?? null,
            note: '检测到 API Key 且 IEconService 数量更高，已自动切换到 API 结果以覆盖更多受限库存。'
          }, steamDtApiKey);
        }
      } catch (compareError) {
        console.warn('[WARN] /api/inventory/public compare by apiKey failed', {
          steamId: parsed.steamId,
          message: compareError?.message ?? 'unknown'
        });
      }
    }
    res.json(result);
  } catch (error) {
    const status = error.code === 400 ? 400 : 500;
    res.status(status).json({
      error: 'Failed to fetch public inventory',
      details: error.message
    });
  }
});

app.get('/api/logs', requireAuth, (req, res) => {
  const limitRaw = Number(req.query.limit ?? 300);
  const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(2000, limitRaw)) : 300;
  res.json({
    total: logBuffer.length,
    limit,
    entries: logBuffer.slice(-limit)
  });
});

app.get('/api/logs/export', requireAuth, (req, res) => {
  const content = logBuffer.join('\n');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"steam-tradeup-server-logs-${stamp}.log\"`);
  res.send(`${content}\n`);
});

app.listen(PORT, () => {
  console.log(`Server running on ${BASE_URL}`);
});
