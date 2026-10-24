// Finds new / trending Arbitrum tokens that trade on BOTH Camelot and Uniswap,
// runs a security check on them, and returns a watchlist for the scanner.
//
// Sources (all free, no API key):
//   - GeckoTerminal: trending pools + newest pools on Arbitrum
//   - DexScreener:  latest boosted tokens + latest token profiles (filtered to Arbitrum)
//   - DexScreener:  all pairs for each candidate (to confirm Camelot + Uniswap listings)
//   - GoPlus:       honeypot / tax / owner-power checks
import { AbiCoder, keccak256, getAddress, ZeroAddress } from 'ethers';
import { TOKENS, STABLES, EXCLUDE_TOKENS } from './config.js';

const coder = AbiCoder.defaultAbiCoder();
const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/42161';

// Quote tokens we can value in USD: symbol -> address (lowercase)
const QUOTES = Object.fromEntries(
  ['WETH', ...STABLES].map((s) => [TOKENS[s].toLowerCase(), s])
);
const EXCLUDED = new Set(
  [...Object.values(TOKENS), ...EXCLUDE_TOKENS].map((a) => a.toLowerCase())
);

// Common Uniswap v4 fee / tick-spacing combos for hookless pools
const V4_COMBOS = [
  [100, 1], [500, 10], [3000, 60], [10000, 200],
  [2500, 50], [5000, 100], [20000, 400], [30000, 600],
];

async function getJson(url, { timeoutMs = 15000, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) {
        await sleep(5000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url.split('?')[0]}: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// ---------- 1. candidate tokens from trending feeds ----------
async function candidateTokens(log) {
  const found = new Map(); // address -> { sources:Set, rank }
  const add = (addr, source, rank) => {
    if (!isAddr(addr)) return;
    const a = addr.toLowerCase();
    if (EXCLUDED.has(a) || QUOTES[a]) return;
    const cur = found.get(a) ?? { sources: new Set(), rank: Infinity };
    cur.sources.add(source);
    cur.rank = Math.min(cur.rank, rank);
    found.set(a, cur);
  };
  const gtTokenAddr = (rel) => rel?.data?.id?.split('_')[1];

  const feeds = [
    ['gecko-trending', `${GT}/networks/arbitrum/trending_pools?page=1`],
    ['gecko-new', `${GT}/networks/arbitrum/new_pools?page=1`],
  ];
  for (const [name, url] of feeds) {
    try {
      const j = await getJson(url);
      (j.data ?? []).forEach((p, i) => {
        add(gtTokenAddr(p.relationships?.base_token), name, i);
        add(gtTokenAddr(p.relationships?.quote_token), name, i);
      });
    } catch (e) {
      log({ msg: 'discovery feed failed', feed: name, err: e.message });
    }
    await sleep(1500); // GeckoTerminal keyless limit is low
  }

  for (const [name, path] of [
    ['dex-boosts', '/token-boosts/latest/v1'],
    ['dex-boosts-top', '/token-boosts/top/v1'],
    ['dex-profiles', '/token-profiles/latest/v1'],
  ]) {
    try {
      const j = await getJson(DS + path);
      const list = Array.isArray(j) ? j : [j];
      list.filter((t) => t?.chainId === 'arbitrum').forEach((t, i) => add(t.tokenAddress, name, i));
    } catch (e) {
      log({ msg: 'discovery feed failed', feed: name, err: e.message });
    }
  }
  return found;
}

// ---------- 2. which candidates trade on both DEXs ----------
async function pairsFor(addresses) {
  const all = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const j = await getJson(`${DS}/tokens/v1/arbitrum/${chunk.join(',')}`);
    if (Array.isArray(j)) all.push(...j);
    else if (Array.isArray(j?.pairs)) all.push(...j.pairs);
  }
  return all;
}

function poolIdV4(c0, c1, fee, ts, hooks = ZeroAddress) {
  return keccak256(coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [c0, c1, fee, ts, hooks])).toLowerCase();
}

// Recover a v4 PoolKey from its pool id by trying common hookless settings.
function matchV4Key(poolId, token, quoteSym) {
  const id = poolId.toLowerCase();
  const quoteAddrs = quoteSym === 'WETH' ? [TOKENS.WETH, ZeroAddress] : [TOKENS[quoteSym]];
  for (const q of quoteAddrs) {
    const [c0, c1] = BigInt(q) < BigInt(token) ? [getAddress(q), getAddress(token)] : [getAddress(token), getAddress(q)];
    for (const [fee, ts] of V4_COMBOS) {
      if (poolIdV4(c0, c1, fee, ts) === id) return { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: ZeroAddress };
    }
  }
  return null;
}

function analyse(token, pairs, opts) {
  const t = token.toLowerCase();
  const reasons = [];
  const byQuote = {}; // quoteSym -> { camelot:[], uniswap:[], v4Keys:[] }
  let symbol = null, name = null, oldest = Infinity, vol24 = 0;

  for (const p of pairs) {
    const base = p.baseToken?.address?.toLowerCase();
    const quote = p.quoteToken?.address?.toLowerCase();
    let other;
    if (base === t) { other = quote; symbol ??= p.baseToken.symbol; name ??= p.baseToken.name; }
    else if (quote === t) { other = base; symbol ??= p.quoteToken.symbol; name ??= p.quoteToken.name; }
    else continue;

    // DexScreener may show native-ETH v4 pools with the zero address
    const quoteSym = QUOTES[other] ?? (other === ZeroAddress.toLowerCase() ? 'WETH' : null);
    if (!quoteSym) continue;
    const dex = p.dexId === 'camelot' ? 'camelot' : p.dexId === 'uniswap' ? 'uniswap' : null;
    if (!dex) continue;

    const liq = Number(p.liquidity?.usd ?? 0);
    vol24 += Number(p.volume?.h24 ?? 0);
    if (p.pairCreatedAt) oldest = Math.min(oldest, Number(p.pairCreatedAt));
    const labels = (p.labels ?? []).map((l) => String(l).toLowerCase());
    const entry = (byQuote[quoteSym] ??= { camelot: [], uniswap: [], v4Keys: [] });

    if (dex === 'uniswap' && (labels.includes('v4') || (p.pairAddress ?? '').length === 66)) {
      const key = matchV4Key(p.pairAddress, token, quoteSym);
      if (!key) { reasons.push(`uniswap v4 pool with hooks/custom fee skipped ($${Math.round(liq)})`); continue; }
      entry.v4Keys.push(key);
    }
    if (dex === 'camelot' && labels.some((l) => l.includes('v4') || l.includes('integral'))) {
      reasons.push('camelot newest-version pool not quotable yet');
      continue;
    }
    entry[dex].push({ liq, url: p.url, labels });
  }

  // Pick the quote token with the most liquidity present on BOTH DEXs
  let best = null;
  for (const [quoteSym, e] of Object.entries(byQuote)) {
    const cam = Math.max(0, ...e.camelot.map((x) => x.liq));
    const uni = Math.max(0, ...e.uniswap.map((x) => x.liq));
    const minSide = Math.min(cam, uni);
    if (minSide > (best?.minSide ?? 0)) best = { quoteSym, cam, uni, minSide, v4Keys: e.v4Keys, url: (e.uniswap[0] ?? e.camelot[0])?.url };
  }
  if (!best) return { ok: false, symbol, reason: reasons[0] ?? 'not on both Camelot and Uniswap with WETH/stable' };
  if (best.minSide < opts.minLiqUsd) return { ok: false, symbol, reason: `thin side: $${Math.round(best.minSide)} < $${opts.minLiqUsd}` };
  if (vol24 < opts.minVol24Usd) return { ok: false, symbol, reason: `24h volume $${Math.round(vol24)} too low` };
  const ageDays = Number.isFinite(oldest) ? (Date.now() - oldest) / 86400000 : null;
  if (opts.maxAgeDays > 0 && ageDays !== null && ageDays > opts.maxAgeDays) return { ok: false, symbol, reason: `token is ${Math.round(ageDays)}d old (max ${opts.maxAgeDays})` };

  return { ok: true, token: getAddress(token), symbol, name, ...best, vol24, ageDays };
}

// ---------- 3. security check ----------
async function securityCheck(addresses, opts) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 20) {
    const chunk = addresses.slice(i, i + 20);
    try {
      const j = await getJson(`${GOPLUS}?contract_addresses=${chunk.join(',')}`);
      for (const [addr, r] of Object.entries(j?.result ?? {})) {
        const flags = [];
        const yes = (k) => r[k] === '1';
        const tax = Math.max(Number(r.buy_tax || 0), Number(r.sell_tax || 0));
        if (yes('is_honeypot')) flags.push('honeypot');
        if (tax > opts.maxTax) flags.push(`tax ${(tax * 100).toFixed(1)}%`);
        if (yes('cannot_sell_all')) flags.push('cannot sell all');
        if (yes('owner_change_balance')) flags.push('owner can change balances');
        if (yes('slippage_modifiable')) flags.push('tax modifiable');
        if (yes('transfer_pausable')) flags.push('transfers pausable');
        if (r.is_open_source === '0') flags.push('contract not verified');
        out[addr.toLowerCase()] = flags;
      }
    } catch (e) {
      // leave missing -> handled by caller (strict mode drops unchecked tokens)
    }
    await sleep(1000);
  }
  return out;
}

// ---------- public ----------
export async function discover({ log, opts }) {
  const cands = await candidateTokens(log);
  const ranked = [...cands.entries()].sort((a, b) => b[1].sources.size - a[1].sources.size || a[1].rank - b[1].rank);
  const addresses = ranked.slice(0, opts.maxCandidates).map(([a]) => a);
  if (!addresses.length) return { list: [], skipped: [], candidates: 0 };

  const pairs = await pairsFor(addresses);
  const byToken = Object.fromEntries(addresses.map((a) => [a, []]));
  for (const p of pairs) {
    for (const side of [p.baseToken?.address, p.quoteToken?.address]) {
      const a = side?.toLowerCase();
      if (a && byToken[a]) byToken[a].push(p);
    }
  }

  const ok = [];
  const skipped = [];
  for (const a of addresses) {
    const r = analyse(a, byToken[a], opts);
    if (r.ok) ok.push({ ...r, sources: [...cands.get(a).sources] });
    else skipped.push({ token: r.symbol ?? a.slice(0, 10), reason: r.reason });
  }

  const sec = await securityCheck(ok.map((t) => t.token.toLowerCase()), opts);
  const list = [];
  for (const t of ok) {
    const flags = sec[t.token.toLowerCase()];
    if (flags === undefined && opts.requireSecurity) { skipped.push({ token: t.symbol, reason: 'security check unavailable' }); continue; }
    if (flags?.length) { skipped.push({ token: t.symbol, reason: `unsafe: ${flags.join(', ')}` }); continue; }
    list.push({ ...t, security: flags === undefined ? 'unchecked' : 'passed' });
  }
  list.sort((a, b) => b.vol24 - a.vol24);
  return { list: list.slice(0, opts.maxTokens), skipped, candidates: addresses.length };
}
