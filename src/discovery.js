// Finds trending Arbitrum tokens with at least TWO usable pools across
// Uniswap (v2/v3/v4), PancakeSwap v3, SushiSwap (v2/v3) and Camelot (v2/v3),
// runs a security check, and returns a watchlist of tokens + their pools.
//
// Sources (all free, no API key):
//   - GeckoTerminal: trending + newest pools on Arbitrum
//   - DexScreener:  boosted tokens + new token profiles (Arbitrum only)
//   - DexScreener:  every pool of each candidate
//   - GoPlus:       honeypot / tax / owner-power checks
//   - WATCH_TOKENS env: addresses you always want considered
import { AbiCoder, keccak256, getAddress, ZeroAddress } from 'ethers';
import { TOKENS, QUOTE_TOKENS, EXCLUDE_TOKENS, DEXES } from './config.js';
import { poolFeeCall } from './quotes.js';

const coder = AbiCoder.defaultAbiCoder();
const GT = 'https://api.geckoterminal.com/api/v2';
const DS = 'https://api.dexscreener.com';
const GOPLUS = 'https://api.gopluslabs.io/api/v1/token_security/42161';
const GT_SPACING_MS = 6500; // GeckoTerminal keyless limit is ~10 calls/min

const QUOTES = Object.fromEntries(QUOTE_TOKENS.map((s) => [TOKENS[s].toLowerCase(), s]));
const EXCLUDED = new Set([...Object.values(TOKENS), ...EXCLUDE_TOKENS].map((a) => a.toLowerCase()));
const SUPPORTED_DEX_IDS = new Set(Object.values(DEXES).map((d) => d.dexId));
const WATCH = (process.env.WATCH_TOKENS ?? '').split(',').map((s) => s.trim()).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

// Common Uniswap v4 fee / tick-spacing combos for hookless pools
const V4_COMBOS = [
  [100, 1], [500, 10], [3000, 60], [10000, 200],
  [2500, 50], [5000, 100], [20000, 400], [30000, 600],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

async function getJson(url, { timeoutMs = 15000, tries = 3 } = {}) {
  const label = url.split('?')[0].replace(/^https:\/\//, '');
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
      if (i === tries - 1) throw new Error(`${label}: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`${label}: no response`);
}

// ---------- 1. candidate tokens ----------
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
  const gtAddr = (rel) => rel?.data?.id?.split('_')[1];

  WATCH.forEach((a) => add(a, 'watch', -1));

  for (const [name, url] of [
    ['gecko-trending', `${GT}/networks/arbitrum/trending_pools?page=1`],
    ['gecko-trending', `${GT}/networks/arbitrum/trending_pools?page=2`],
    ['gecko-new', `${GT}/networks/arbitrum/new_pools?page=1`],
  ]) {
    try {
      const j = await getJson(url);
      (j.data ?? []).forEach((p, i) => {
        add(gtAddr(p.relationships?.base_token), name, i);
        add(gtAddr(p.relationships?.quote_token), name, i);
      });
    } catch (e) {
      log({ msg: 'discovery feed failed', feed: name, err: e.message });
    }
    await sleep(GT_SPACING_MS);
  }

  for (const [name, path] of [
    ['dex-boosts', '/token-boosts/latest/v1'],
    ['dex-boosts-top', '/token-boosts/top/v1'],
    ['dex-profiles', '/token-profiles/latest/v1'],
  ]) {
    try {
      const j = await getJson(DS + path);
      (Array.isArray(j) ? j : [j]).filter((t) => t?.chainId === 'arbitrum').forEach((t, i) => add(t.tokenAddress, name, i));
    } catch (e) {
      log({ msg: 'discovery feed failed', feed: name, err: e.message });
    }
  }
  return found;
}

// ---------- 2. every pool of each candidate ----------
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
      await sleep(250); // well under DexScreener's 300 req/min
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

// Turn DexScreener pairs into quotable pools ("venues"). V3-vs-V2 for
// Uniswap/PancakeSwap/SushiSwap is decided on-chain by reading pool.fee().
async function buildVenues(addresses, byToken, batcher, opts) {
  const perToken = {};
  const feeProbe = []; // { token, entry, pool, dexId }

  for (const t of addresses) {
    const info = (perToken[t] = { symbol: null, venues: [], seen: [], notes: new Set(), vol24: 0, oldest: Infinity, url: null, bestLiq: 0 });
    for (const p of byToken[t]) {
      const base = p.baseToken?.address?.toLowerCase();
      const quote = p.quoteToken?.address?.toLowerCase();
      let other;
      if (base === t) { other = quote; info.symbol ??= p.baseToken.symbol; }
      else if (quote === t) { other = base; info.symbol ??= p.quoteToken.symbol; }
      else continue;

      const labels = (p.labels ?? []).map((l) => String(l).toLowerCase());
      const liq = Number(p.liquidity?.usd ?? 0);
      const otherSym = base === t ? p.quoteToken?.symbol : p.baseToken?.symbol;
      info.seen.push({ where: `${p.dexId}${labels.length ? ' ' + labels.join('/') : ''} vs ${otherSym}`, liq });
      if (p.pairCreatedAt) info.oldest = Math.min(info.oldest, Number(p.pairCreatedAt));

      const quoteSym = QUOTES[other] ?? (other === ZeroAddress ? 'WETH' : null);
      if (!quoteSym) continue;
      if (!SUPPORTED_DEX_IDS.has(p.dexId)) continue;
      info.vol24 += Number(p.volume?.h24 ?? 0);
      if (liq < opts.minLiqUsd) { info.notes.add('thin'); continue; }
      if (liq > info.bestLiq) { info.bestLiq = liq; info.url = p.url; }

      const addr = p.pairAddress ?? '';
      const entry = { quoteSym, liq, url: p.url };

      if (p.dexId === 'uniswap' && (labels.includes('v4') || addr.length === 66)) {
        const key = matchV4Key(addr, t, quoteSym);
        if (key) info.venues.push({ ...entry, dex: 'uniswap-v4', v4Key: key, id: addr.toLowerCase() });
        else info.notes.add('uniswap v4 pool with hooks/custom fee (not quotable)');
        continue;
      }
      if (p.dexId === 'camelot') {
        if (labels.some((l) => l.includes('v4') || l.includes('integral'))) { info.notes.add('camelot newest pool version (not quotable)'); continue; }
        const dex = labels.includes('v3') ? 'camelot-v3' : 'camelot-v2';
        info.venues.push({ ...entry, dex, id: addr.toLowerCase() });
        continue;
      }
      if (!isAddr(addr)) continue;
      if (labels.includes('v2')) {
        const dex = `${p.dexId}-v2`;
        if (DEXES[dex]) info.venues.push({ ...entry, dex, id: addr.toLowerCase() });
        else info.notes.add(`${p.dexId} v2 not supported`);
        continue;
      }
      feeProbe.push({ token: t, entry: { ...entry, id: addr.toLowerCase() }, pool: addr, dexId: p.dexId });
    }
  }

  if (feeProbe.length) {
    const fees = await batcher.run(feeProbe.map((x) => poolFeeCall(x.pool)), 'latest', { keepZero: true });
    feeProbe.forEach((x, i) => {
      const info = perToken[x.token];
      const v3 = DEXES[`${x.dexId}-v3`];
      if (fees[i] !== null && v3) {
        const fee = Number(fees[i]);
        if (v3.fees.includes(fee)) info.venues.push({ ...x.entry, dex: `${x.dexId}-v3`, fee });
        else info.notes.add(`${x.dexId} v3 pool with unusual fee ${fee}`);
      } else if (DEXES[`${x.dexId}-v2`]) {
        info.venues.push({ ...x.entry, dex: `${x.dexId}-v2` });
      } else {
        info.notes.add(`${x.dexId} pool type not supported`);
      }
    });
  }

  // one venue per pool id; for V2/algebra routers one venue per (dex, quote)
  for (const info of Object.values(perToken)) {
    const best = new Map();
    for (const v of info.venues) {
      const k = v.dex.endsWith('-v2') || v.dex === 'camelot-v3' ? `${v.dex}|${v.quoteSym}` : v.id;
      if (!best.has(k) || best.get(k).liq < v.liq) best.set(k, v);
    }
    info.venues = [...best.values()].sort((a, b) => b.liq - a.liq).slice(0, opts.maxVenues);
  }
  return perToken;
}

// ---------- 3. security check ----------
async function securityCheck(addresses, opts, log) {
  const out = {};
  const parse = (j) => {
    for (const [addr, r] of Object.entries(j?.result ?? {})) {
      if (!r || !Object.keys(r).length) continue; // empty entry = not analyzed yet
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
  };
  const replies = [];
  // first pass in batches of 20
  for (let i = 0; i < addresses.length; i += 20) {
    try {
      const j = await getJson(`${GOPLUS}?contract_addresses=${addresses.slice(i, i + 20).join(',')}`);
      parse(j);
      if (j?.code !== 1) replies.push({ code: j?.code, message: j?.message });
    } catch (e) {
      replies.push({ error: e.message });
    }
    await sleep(1500);
  }
  // GoPlus often has no data the first time it sees a token, or answers a
  // batch partially; retry the missing ones one by one after a pause
  const missing = addresses.filter((a) => !out[a]);
  if (missing.length) {
    await sleep(5000);
    for (const a of missing) {
      try {
        const j = await getJson(`${GOPLUS}?contract_addresses=${a}`);
        parse(j);
        if (!out[a]) replies.push({ token: a.slice(0, 10), code: j?.code, message: j?.message });
      } catch (e) {
        replies.push({ token: a.slice(0, 10), error: e.message });
      }
      await sleep(2500);
    }
  }
  const stillMissing = addresses.filter((a) => !out[a]).length;
  if (stillMissing) log({ msg: 'security check incomplete', missing: stillMissing, of: addresses.length, goplusReplies: replies.slice(0, 5) });
  return out;
}

// ---------- public ----------
export async function discover({ log, opts, batcher }) {
  const cands = await candidateTokens(log);
  const ranked = [...cands.entries()].sort((a, b) => b[1].sources.size - a[1].sources.size || a[1].rank - b[1].rank);
  const addresses = ranked.slice(0, opts.maxCandidates).map(([a]) => a);
  if (!addresses.length) return { list: [], skipped: [], skipStats: {}, candidates: 0 };

  const byToken = await pairsFor(addresses, log);
  const perToken = await buildVenues(addresses, byToken, batcher, opts);

  const ok = [];
  const skipped = [];
  const skip = (t, category, reason) => skipped.push({ token: perToken[t]?.symbol ?? t.slice(0, 10), category, reason });
  for (const t of addresses) {
    const info = perToken[t];
    const top = [...info.seen].sort((a, b) => b.liq - a.liq).slice(0, 3).map((x) => `${x.where} $${Math.round(x.liq)}`).join(', ');
    const notes = [...info.notes].filter((n) => n !== 'thin');
    if (!info.seen.length) { skip(t, 'no pools found', 'no pools found'); continue; }
    if (info.venues.length < 2) {
      const category = info.venues.length === 0 && info.notes.has('thin') ? 'pools too thin' : 'fewer than 2 usable pools';
      skip(t, category, [category, ...notes.slice(0, 1), top].filter(Boolean).join(' | '));
      continue;
    }
    if (info.vol24 < opts.minVol24Usd) { skip(t, 'filtered', `24h volume $${Math.round(info.vol24)} too low`); continue; }
    const ageDays = Number.isFinite(info.oldest) ? (Date.now() - info.oldest) / 86400000 : null;
    if (opts.maxAgeDays > 0 && ageDays !== null && ageDays > opts.maxAgeDays && !cands.get(t).sources.has('watch')) {
      skip(t, 'filtered', `token is ${Math.round(ageDays)}d old (max ${opts.maxAgeDays})`);
      continue;
    }
    ok.push({
      token: getAddress(t), symbol: info.symbol ?? '?', venues: info.venues, url: info.url,
      secondLiq: info.venues[1].liq, vol24: info.vol24, ageDays, sources: [...cands.get(t).sources],
    });
  }

  const sec = await securityCheck(ok.map((t) => t.token.toLowerCase()), opts, log);
  const list = [];
  for (const t of ok) {
    const flags = sec[t.token.toLowerCase()];
    if (flags === undefined && opts.requireSecurity) { skip(t.token.toLowerCase(), 'unsafe/unchecked', 'security check unavailable'); continue; }
    if (flags?.length) { skip(t.token.toLowerCase(), 'unsafe/unchecked', `unsafe: ${flags.join(', ')}`); continue; }
    list.push({ ...t, security: flags === undefined ? 'unchecked' : 'passed' });
  }
  list.sort((a, b) => b.vol24 - a.vol24);

  const skipStats = {};
  for (const x of skipped) skipStats[x.category] = (skipStats[x.category] ?? 0) + 1;
  const order = ['unsafe/unchecked', 'filtered', 'fewer than 2 usable pools', 'pools too thin', 'no pools found'];
  skipped.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  return { list: list.slice(0, opts.maxTokens), skipped, skipStats, candidates: addresses.length };
}
