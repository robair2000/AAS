// Finds new / trending Arbitrum tokens that trade on BOTH Camelot and Uniswap,
// runs a security check on them, and returns a watchlist for the scanner.
//
// Sources (all free, no API key):
//   - GeckoTerminal: trending pools, newest pools and busiest Camelot pools on Arbitrum
//   - DexScreener:  latest boosted tokens + latest token profiles (filtered to Arbitrum)
//   - DexScreener:  all pairs for each candidate (to confirm Camelot + Uniswap listings)
//   - GoPlus:       honeypot / tax / owner-power checks
import { AbiCoder, keccak256, getAddress, ZeroAddress } from 'ethers';
import { TOKENS, QUOTE_TOKENS, EXCLUDE_TOKENS } from './config.js';

const coder = AbiCoder.defaultAbiCoder();
const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/42161';

// Quote tokens: lowercase address -> symbol
const QUOTES = Object.fromEntries(QUOTE_TOKENS.map((s) => [TOKENS[s].toLowerCase(), s]));
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
        if (i === tries - 1) throw new Error('rate limited (HTTP 429)');
        await sleep(8000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url.split('?')[0].replace(/^https:\/\//, '')}: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`${url.split('?')[0]}: no response`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

const GT_SPACING_MS = 6500;
let camelotIdsCache = null;
async function camelotDexIds(log) {
  if (camelotIdsCache) return camelotIdsCache;
  const ids = [];
  try {
    // only page 1: GeckoTerminal answers HTTP 400 for later pages of this list
    const j = await getJson(`${GT}/networks/arbitrum/dexes`);
    for (const d of j.data ?? []) if (String(d.id).toLowerCase().includes('camelot')) ids.push(d.id);
    await sleep(GT_SPACING_MS);
  } catch (e) {
    log({ msg: 'could not list GeckoTerminal dexes', err: e.message });
  }
  if (!ids.length) {
    // fallback: the ids GeckoTerminal used when this was written
    log({ msg: 'using default camelot dex ids', ids: ['camelot', 'camelot-v3'] });
    return ['camelot', 'camelot-v3'];
  }
  camelotIdsCache = ids.slice(0, 3);
  log({ msg: 'camelot dex ids on GeckoTerminal', ids: camelotIdsCache });
  return camelotIdsCache;
}

// ---------- 1. candidate tokens from trending feeds ----------
async function candidateTokens(log) {
  const found = new Map(); // address -> { sources:Set, rank }
  const add = (addr, source, rank) => {
    if (!isAddr(addr)) return;
    const a = addr.toLowerCase();
    if (EXCLUDED.has(a) || QUOTES[a] || a === ZeroAddress) return;
    const cur = found.get(a) ?? { sources: new Set(), rank: Infinity };
    cur.sources.add(source);
    cur.rank = Math.min(cur.rank, rank);
    found.set(a, cur);
  };
  const gtTokenAddr = (rel) => rel?.data?.id?.split('_')[1];

  // GeckoTerminal keyless limit is ~10 calls/min, so calls are spaced out.
  const gt = async (name, url) => {
    try {
      const j = await getJson(url);
      (j.data ?? []).forEach((p, i) => {
        add(gtTokenAddr(p.relationships?.base_token), name, i);
        add(gtTokenAddr(p.relationships?.quote_token), name, i);
      });
    } catch (e) {
      log({ msg: 'discovery feed failed', feed: name, err: e.message });
    }
    await sleep(GT_SPACING_MS);
  };
  for (const page of [1, 2]) await gt('gecko-trending', `${GT}/networks/arbitrum/trending_pools?page=${page}`);
  for (const page of [1, 2]) await gt('gecko-new', `${GT}/networks/arbitrum/new_pools?page=${page}`);
  // Busiest Camelot pools: Camelot listing is the rarer half of "on both DEXs"
  for (const dexId of await camelotDexIds(log)) {
    await gt('gecko-camelot', `${GT}/networks/arbitrum/dexes/${dexId}/pools?page=1&sort=h24_volume_usd_desc`);
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
async function pairsFor(addresses, log) {
  const byToken = Object.fromEntries(addresses.map((a) => [a, []]));
  let failed = 0;
  const queue = [...addresses];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        const j = await getJson(`${DS}/token-pairs/v1/arbitrum/${a}`);
        byToken[a] = Array.isArray(j) ? j : Array.isArray(j?.pairs) ? j.pairs : [];
      } catch {
        failed++;
      }
      await sleep(250); // stays well under DexScreener's 300 req/min
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (failed) log({ msg: 'token-pairs lookups failed', failed, of: addresses.length });
  return byToken;
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

  const seen = []; // every pool, for the skip reason
  for (const p of pairs) {
    const base = p.baseToken?.address?.toLowerCase();
    const quote = p.quoteToken?.address?.toLowerCase();
    let other;
    if (base === t) { other = quote; symbol ??= p.baseToken.symbol; name ??= p.baseToken.name; }
    else if (quote === t) { other = base; symbol ??= p.quoteToken.symbol; name ??= p.quoteToken.name; }
    else continue;
    const otherSym = base === t ? p.quoteToken?.symbol : p.baseToken?.symbol;
    seen.push({ where: `${p.dexId}${(p.labels ?? []).length ? ' ' + p.labels.join('/') : ''} vs ${otherSym}`, liq: Number(p.liquidity?.usd ?? 0) });

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

  // Pick the Camelot quote and Uniswap quote with the most liquidity on the thinner side.
  // Same quote on both sides is preferred; different quotes need a conversion swap.
  const camLiq = {}, uniLiq = {}, urls = {};
  for (const [q, e] of Object.entries(byQuote)) {
    if (e.camelot.length) camLiq[q] = Math.max(...e.camelot.map((x) => x.liq));
    if (e.uniswap.length) uniLiq[q] = Math.max(...e.uniswap.map((x) => x.liq));
    urls[q] = (e.uniswap[0] ?? e.camelot[0])?.url;
  }
  let best = null;
  for (const [cq, cl] of Object.entries(camLiq)) {
    for (const [uq, ul] of Object.entries(uniLiq)) {
      if (cq !== uq && !opts.crossQuote) continue;
      const minSide = Math.min(cl, ul);
      const score = minSide * (cq === uq ? 1.25 : 1);
      if (score > (best?.score ?? 0))
        best = { camQuote: cq, uniQuote: uq, cam: cl, uni: ul, minSide, score, v4Keys: byQuote[uq].v4Keys, url: urls[uq] ?? urls[cq] };
    }
  }
  if (!best) {
    const top = seen.sort((a, b) => b.liq - a.liq).slice(0, 3).map((x) => `${x.where} $${Math.round(x.liq)}`);
    const onCam = seen.some((x) => x.where.startsWith('camelot'));
    const onUni = seen.some((x) => x.where.startsWith('uniswap'));
    const category = !seen.length ? 'no pools found' : onCam && onUni ? 'both DEXs but unsupported quote tokens' : onCam ? 'camelot only' : onUni ? 'uniswap only' : 'other DEXs only';
    return { ok: false, symbol, category, reason: [category, ...reasons.slice(0, 1), top.join(', ')].filter(Boolean).join(' | ') };
  }
  if (best.minSide < opts.minLiqUsd) return { ok: false, symbol, reason: `thin side: $${Math.round(best.minSide)} < $${opts.minLiqUsd}` };
  if (vol24 < opts.minVol24Usd) return { ok: false, symbol, reason: `24h volume $${Math.round(vol24)} too low` };
  const ageDays = Number.isFinite(oldest) ? (Date.now() - oldest) / 86400000 : null;
  if (opts.maxAgeDays > 0 && ageDays !== null && ageDays > opts.maxAgeDays) return { ok: false, symbol, reason: `token is ${Math.round(ageDays)}d old (max ${opts.maxAgeDays})` };

  const { score, ...rest } = best;
  return { ok: true, token: getAddress(token), symbol, name, ...rest, vol24, ageDays };
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

  const byToken = await pairsFor(addresses, log);

  const ok = [];
  const skipped = [];
  for (const a of addresses) {
    const r = analyse(a, byToken[a], opts);
    if (r.ok) ok.push({ ...r, sources: [...cands.get(a).sources] });
    else skipped.push({ token: r.symbol ?? a.slice(0, 10), address: a, category: r.category ?? 'filtered', reason: r.reason });
  }

  const sec = await securityCheck(ok.map((t) => t.token.toLowerCase()), opts);
  const list = [];
  for (const t of ok) {
    const flags = sec[t.token.toLowerCase()];
    if (flags === undefined && opts.requireSecurity) { skipped.push({ token: t.symbol, category: 'unsafe/unchecked', reason: 'security check unavailable' }); continue; }
    if (flags?.length) { skipped.push({ token: t.symbol, category: 'unsafe/unchecked', reason: `unsafe: ${flags.join(', ')}` }); continue; }
    list.push({ ...t, security: flags === undefined ? 'unchecked' : 'passed' });
  }
  list.sort((a, b) => b.vol24 - a.vol24);
  const skipStats = {};
  for (const x of skipped) skipStats[x.category ?? 'filtered'] = (skipStats[x.category ?? 'filtered'] ?? 0) + 1;
  // show the near-misses first: tokens on both DEXs, then single-DEX ones
  const order = ['unsafe/unchecked', 'filtered', 'both DEXs but unsupported quote tokens', 'camelot only', 'uniswap only'];
  skipped.sort((a, b) => (order.indexOf(a.category) + 1 || 9) - (order.indexOf(b.category) + 1 || 9));
  return { list: list.slice(0, opts.maxTokens), skipped, skipStats, candidates: addresses.length };
}
