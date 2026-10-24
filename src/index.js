// Read-only multi-DEX arbitrage scanner for Arbitrum One.
// Watches trending tokens that have 2+ pools across Uniswap (v2/v3/v4),
// PancakeSwap v3, SushiSwap (v2/v3) and Camelot (v2/v3), and logs when buying
// on one pool and selling on another would be profitable after fees and gas.
// It never signs or sends transactions. It only reads quotes.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { CHAIN_ID, TOKENS, STABLES, QUOTE_TOKENS } from './config.js';
import { Batcher, buildQuoteCalls, dexCheckCalls, venueCall, venueName } from './quotes.js';
import { discover } from './discovery.js';
import { startEvents } from './events.js';

// ---------- settings ----------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const RPC_URL_RAW = () => env('RPC_URL', 'https://arb1.arbitrum.io/rpc');
const num = (k, d) => Number(env(k, d));
const RPC_URL = env('RPC_URL', 'https://arb1.arbitrum.io/rpc');
const SCAN_INTERVAL_MS = num('SCAN_INTERVAL_MS', 15000);
const MIN_PROFIT_USD = num('MIN_PROFIT_USD', 1);
const GAS_UNITS = BigInt(env('GAS_UNITS', 450000)); // two swaps + flash overhead
const CONVERT_GAS_UNITS = BigInt(env('CONVERT_GAS_UNITS', 150000)); // extra swap when quote tokens differ
const L1_FEE_USD = num('L1_FEE_USD', 0.02);
const SUMMARY_EVERY_MIN = num('SUMMARY_EVERY_MIN', 60);
// Live swap events: re-quote a token the moment one of its pools trades.
// Needs a WebSocket RPC; by default derived from RPC_URL (https:// -> wss://).
const EVENTS = env('EVENTS', 'true') !== 'false';
const WSS_URL = env('WSS_URL', /alchemy|infura|quiknode|quicknode|ankr|blast|drpc/.test(RPC_URL_RAW()) ? RPC_URL_RAW().replace(/^https:/, 'wss:') : '');
const EVENT_DEBOUNCE_MS = num('EVENT_DEBOUNCE_MS', 100); // gather swaps landing together into one re-quote
const MARKET_CACHE_MS = num('MARKET_CACHE_MS', 15000); // how long quote-token prices / gas price are reused
const BACKUP_SCAN_MS = num('BACKUP_SCAN_MS', 60000); // full scan interval while live events are connected
const CHUNK_SIZE = num('MULTICALL_CHUNK', 40);
const ALERT_COOLDOWN_MIN = num('ALERT_COOLDOWN_MIN', 10);
const DATA_DIR = env('DATA_DIR', '');
const DISCORD_WEBHOOK_URL = env('DISCORD_WEBHOOK_URL', '');
const TELEGRAM_BOT_TOKEN = env('TELEGRAM_BOT_TOKEN', '');
const TELEGRAM_CHAT_ID = env('TELEGRAM_CHAT_ID', '');

const DISCOVERY_EVERY_MIN = num('DISCOVERY_EVERY_MIN', 15);
const DISCOVERY = {
  maxCandidates: num('MAX_CANDIDATES', 90), // tokens pulled from feeds per round
  maxTokens: num('MAX_TOKENS', 25), // tokens actually scanned
  maxVenues: num('MAX_POOLS_PER_TOKEN', 6), // deepest pools kept per token
  minLiqUsd: num('MIN_LIQ_USD', 5000), // a pool needs at least this to be used
  minVol24Usd: num('MIN_VOL24_USD', 10000),
  maxAgeDays: num('MAX_AGE_DAYS', 90), // 0 = no age limit
  maxTax: num('MAX_TAX', 0.005),
  requireSecurity: env('REQUIRE_SECURITY_CHECK', 'true') !== 'false',
};
const SIZE_PCTS = env('SIZE_PCTS', '0.5,2').split(',').map(Number); // % of the 2nd-deepest pool
const MIN_TRADE_USD = num('MIN_TRADE_USD', 50);
const MAX_TRADE_USD = num('MAX_TRADE_USD', 5000);

const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
const round = (x, d = 6) => Number(Number(x).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state ----------
const provider = new JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true });
const batcher = new Batcher(provider, CHUNK_SIZE);
const decCache = new Map(); // lowercase address -> decimals
let watch = []; // [{ key, baseSym, base, venues, sizesUsd, url, info }]
const stats = {};
let csvPath = null;
let running = true;
const lastAlert = new Map();
let events = null; // live swap subscription (startEvents)
const gaps = new Map(); // token key -> currently open profitable gap
const eventStats = { swaps: 0, requotes: 0, requoteMsTotal: 0, gapsClosed: 0, gapSecs: [] };

async function decimalsOf(addresses) {
  const missing = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !decCache.has(a));
  if (!missing.length) return;
  try {
    const d = await batcher.decimals(missing);
    missing.forEach((a, i) => decCache.set(a, d[i]));
  } catch {
    for (const a of missing) {
      try { decCache.set(a, (await batcher.decimals([a]))[0]); } catch { decCache.set(a, null); }
    }
  }
}
const dec = (a) => decCache.get(a.toLowerCase());

const bestOf = (calls, results, offset, n = calls.length) => {
  let best = null;
  for (let i = 0; i < n; i++) {
    const v = results[offset + i];
    if (v !== null && (!best || v > best.out)) best = { out: v, venue: calls[i].venue };
  }
  return best;
};

// USD price of every quote token (stables = $1, others via Uniswap/Camelot -> USDC)
async function pricesAt(blockTag) {
  const prices = {};
  const groups = [];
  const all = [];
  for (const sym of QUOTE_TOKENS) {
    if (STABLES.has(sym)) { prices[sym] = 1; continue; }
    const calls = buildQuoteCalls(TOKENS[sym], TOKENS.USDC, parseUnits('1', dec(TOKENS[sym])));
    groups.push({ sym, start: all.length, calls });
    all.push(...calls);
  }
  const q = await batcher.run(all, blockTag);
  for (const g of groups) {
    const best = bestOf(g.calls, q, g.start);
    if (!best) throw new Error(`Could not price ${g.sym}`);
    prices[g.sym] = Number(formatUnits(best.out, 6));
  }
  return prices;
}
// prices + gas price, reused for MARKET_CACHE_MS so event re-quotes stay light
let market = null;
async function getMarket(block) {
  if (market && Date.now() - market.at < MARKET_CACHE_MS) return market;
  const [prices, fee] = await Promise.all([pricesAt(block), provider.getFeeData()]);
  market = { at: Date.now(), prices, gasPrice: fee.gasPrice ?? 10_000_000n };
  return market;
}
const toUnits = (usd, sym, prices) => {
  const d = dec(TOKENS[sym]);
  return parseUnits((usd / prices[sym]).toFixed(Math.min(d, 8)), d);
};

// ---------- startup ----------
async function init() {
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${net.chainId}, expected Arbitrum One (42161)`);
  if (env('MODE', 'trending') === 'static') log({ msg: 'MODE=static is no longer supported; use WATCH_TOKENS to always include specific tokens' });
  await decimalsOf(Object.values(TOKENS));
  await venueCheck();

  if (DATA_DIR) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    csvPath = path.join(DATA_DIR, 'signals.csv');
    if (!fs.existsSync(csvPath))
      fs.writeFileSync(csvPath, 'time,block,token,address,size_usd,start_token,buy_pool,sell_pool,route,amount_in,amount_back,gross_usd,gas_usd,net_usd,net_bps\n');
  }
  await refreshWatchlist();
  log({ msg: 'scanner started (read-only)', rpc: RPC_URL.replace(/\/[^/]{12,}$/, '/***'), liveEvents: EVENTS && !!WSS_URL, intervalMs: SCAN_INTERVAL_MS, minProfitUsd: MIN_PROFIT_USD, minLiqUsd: DISCOVERY.minLiqUsd, watching: watch.length });
}

// Startup self-check: every DEX prices ETH (0.1 WETH -> USDC). A DEX that says
// "no quote" or is far off has a wrong address/ABI, and its pools will be ignored.
async function venueCheck() {
  const calls = dexCheckCalls(parseUnits('0.1', 18));
  const res = await batcher.run(calls, 'latest');
  const byDex = {};
  calls.forEach((c, i) => {
    if (res[i] === null) return;
    const usd = Number(formatUnits(res[i], 6)) * 10;
    if (!byDex[c.dex] || usd > byDex[c.dex].usd) byDex[c.dex] = { usd, venue: c.venue };
  });
  const ref = byDex['uniswap-v3']?.usd;
  if (!ref) throw new Error('Uniswap quoter returned nothing for WETH/USDC. Check RPC_URL.');
  const dexes = [...new Set(calls.map((c) => c.dex))].map((dex) => {
    const b = byDex[dex];
    const status = !b ? 'no quote' : Math.abs(b.usd / ref - 1) > 0.05 ? 'far off (thin WETH/USDC pool, or quoter problem)' : 'ok';
    return { dex, usd: b ? round(b.usd, 2) : null, bestPool: b?.venue ?? null, status };
  });
  log({ msg: 'venue check: ETH price on each DEX (0.1 WETH -> USDC)', dexes });
}

// ---------- watchlist ----------
async function refreshWatchlist() {
  const started = Date.now();
  let found;
  try {
    found = await discover({ log, opts: DISCOVERY, batcher });
  } catch (e) {
    log({ msg: 'discovery failed, keeping previous watchlist', err: e.message });
    return;
  }
  await decimalsOf(found.list.map((t) => t.token));

  const next = [];
  for (const t of found.list) {
    if (dec(t.token) == null) continue;
    const sizesUsd = [...new Set(SIZE_PCTS.map((p) => round(Math.min(MAX_TRADE_USD, Math.max(MIN_TRADE_USD, (t.secondLiq * p) / 100)), 2)))];
    const venues = t.venues.map((v) => ({ ...v, name: `${venueName(v)} vs ${v.quoteSym}` }));
    next.push({
      key: `${t.symbol}(${t.token.slice(0, 6)})`, baseSym: t.symbol, base: t.token, venues, sizesUsd, url: t.url,
      info: { vol24: Math.round(t.vol24), ageDays: t.ageDays == null ? null : round(t.ageDays, 1), security: t.security, sources: t.sources },
    });
  }

  const before = new Set(watch.map((w) => w.key));
  const after = new Set(next.map((w) => w.key));
  const added = next.filter((w) => !before.has(w.key));
  const removed = watch.filter((w) => !after.has(w.key)).map((w) => w.key);
  watch = next;

  log({
    msg: 'watchlist updated',
    tookSec: round((Date.now() - started) / 1000, 1),
    candidates: found.candidates,
    watching: watch.map((w) => ({ token: w.key, sizesUsd: w.sizesUsd, pools: w.venues.map((v) => `${v.name} $${Math.round(v.liq)}`), ...w.info })),
    added: added.map((w) => w.key),
    removed,
    skipStats: found.skipStats,
    skippedSample: found.skipped.slice(0, 40).map(({ category, ...x }) => x),
  });
  if (events && (added.length || removed.length)) events.refresh();
  if (added.length)
    notify(`Now watching ${added.length} token(s):\n` + added.map((w) => `${w.key}: ${w.venues.map((v) => v.name).join(', ')}\n${w.url ?? ''}`).join('\n'));
}

// ---------- one scan cycle ----------
// For each token and trade size:
//   1. quote buying the token with $size on every pool
//   2. take the pool that gives the most tokens (B) and quote selling that
//      amount on every OTHER pool; take the one returning the most USD (S)
//   3. if B and S use different quote tokens, quote converting S's proceeds
//      back to B's quote token (best of Uniswap V3 / Camelot V3)
//   profit = what comes back - what went in, minus gas
async function scanTokens(tokens, { blockTag = null, trigger = 'timer', eventAt = null } = {}) {
  if (!tokens.length) return {};
  const block = blockTag ?? (await provider.getBlockNumber());
  const { prices, gasPrice } = await getMarket(block);
  const gasUsdFor = (convert) => Number(formatUnits(gasPrice * (GAS_UNITS + (convert ? CONVERT_GAS_UNITS : 0n)), 18)) * prices.WETH + L1_FEE_USD;

  // Round 1: buy on every pool
  const jobs = [];
  const r1Calls = [];
  for (const p of tokens) {
    for (const sizeUsd of p.sizesUsd) {
      const buys = [];
      for (const v of p.venues) {
        const amountIn = toUnits(sizeUsd, v.quoteSym, prices);
        const call = venueCall(v, TOKENS[v.quoteSym], p.base, amountIn);
        if (!call) continue;
        buys.push({ v, amountIn, idx: r1Calls.length });
        r1Calls.push(call);
      }
      jobs.push({ p, sizeUsd, buys });
    }
  }
  const r1 = await batcher.run(r1Calls, block);

  // Round 2: sell the best buy's tokens on every other pool
  const r2Calls = [];
  for (const j of jobs) {
    for (const b of j.buys) b.out = r1[b.idx];
    const valid = j.buys.filter((b) => b.out !== null);
    if (valid.length < 2) continue;
    j.B = valid.reduce((m, b) => (b.out > m.out ? b : m));
    j.sells = [];
    for (const v of j.p.venues) {
      if (v === j.B.v) continue;
      const call = venueCall(v, j.p.base, TOKENS[v.quoteSym], j.B.out);
      if (!call) continue;
      j.sells.push({ v, idx: r2Calls.length });
      r2Calls.push(call);
    }
  }
  const r2 = r2Calls.length ? await batcher.run(r2Calls, block) : [];

  // Round 3: convert back when quote tokens differ
  const r3Calls = [];
  for (const j of jobs) {
    if (!j.sells) continue;
    let S = null;
    for (const s of j.sells) {
      s.out = r2[s.idx];
      if (s.out === null) continue;
      s.usd = Number(formatUnits(s.out, dec(TOKENS[s.v.quoteSym]))) * prices[s.v.quoteSym];
      if (!S || s.usd > S.usd) S = s;
    }
    j.S = S;
    if (!S || S.v.quoteSym === j.B.v.quoteSym) continue;
    j.convCalls = buildQuoteCalls(TOKENS[S.v.quoteSym], TOKENS[j.B.v.quoteSym], S.out);
    j.convIdx = r3Calls.length;
    r3Calls.push(...j.convCalls);
  }
  const r3 = r3Calls.length ? await batcher.run(r3Calls, block) : [];

  const bestByToken = new Map(); // token key -> best profitable result this pass
  for (const j of jobs) {
    const { p } = j;
    const st = (stats[p.key] ??= { checks: 0, signals: 0, bestNetUsd: -Infinity, bestGrossBps: -Infinity, bestAt: null, url: p.url });
    if (!j.S) continue;
    const inSym = j.B.v.quoteSym;
    const convert = j.S.v.quoteSym !== inSym;
    const back = convert ? bestOf(j.convCalls, r3, j.convIdx) : { out: j.S.out, venue: null };
    if (!back) continue;
    st.checks++;

    const inDec = dec(TOKENS[inSym]);
    const inNum = Number(formatUnits(j.B.amountIn, inDec));
    const outNum = Number(formatUnits(back.out, inDec));
    const px = prices[inSym];
    const gasUsd = gasUsdFor(convert);
    const grossUsd = (outNum - inNum) * px;
    const netUsd = grossUsd - gasUsd;
    const grossBps = ((outNum - inNum) / inNum) * 10000;
    const netBps = (netUsd / (inNum * px)) * 10000;
    const pair = `${j.B.v.name} -> ${j.S.v.name}`;

    if (netUsd > st.bestNetUsd) { st.bestNetUsd = netUsd; st.bestAt = `$${Math.round(j.sizeUsd)}: ${pair}`; }
    if (grossBps > st.bestGrossBps) st.bestGrossBps = grossBps;
    if (netUsd < MIN_PROFIT_USD) continue;

    st.signals++;
    const route = [
      `buy ${p.baseSym} with ${inSym} on ${j.B.v.name}`,
      `sell for ${j.S.v.quoteSym} on ${j.S.v.name}`,
      ...(convert ? [`convert ${j.S.v.quoteSym}->${inSym} (${back.venue})`] : []),
    ].join(' -> ');
    writeCsv([new Date().toISOString(), block, p.key, p.base, round(j.sizeUsd, 2), inSym, j.B.v.name, j.S.v.name, route, inNum, outNum, round(grossUsd, 4), round(gasUsd, 4), round(netUsd, 4), round(netBps, 2)]);
    const cur = bestByToken.get(p.key);
    if (!cur || netUsd > cur.netUsd) {
      bestByToken.set(p.key, {
        msg: 'SIGNAL', block, trigger, token: p.key, address: p.base, sizeUsd: round(j.sizeUsd, 0), route,
        in: `${round(inNum)} ${inSym}`, out: `${round(outNum)} ${inSym}`,
        grossBps: round(grossBps, 2), gasUsd: round(gasUsd, 4), netUsd: round(netUsd, 2), netBps: round(netBps, 2),
        ...(eventAt ? { msSinceSwapSeen: Date.now() - eventAt } : {}), url: p.url,
      });
    }
  }
  for (const p of tokens) trackGap(p, bestByToken.get(p.key) ?? null, block);
  return { block, ethUsd: prices.WETH, gasUsd: gasUsdFor(false) };
}
const scanOnce = () => scanTokens(watch);

// A gap "opens" the first time a token has a profitable route and "closes" when
// a later quote no longer finds one. How long gaps stay open is the key number
// for deciding whether an execution bot could realistically catch them.
const lastEvalBlock = new Map(); // token key -> newest block evaluated
function trackGap(p, sig, block) {
  if (block < (lastEvalBlock.get(p.key) ?? 0)) return; // stale result from an older block
  lastEvalBlock.set(p.key, block);
  const g = gaps.get(p.key);
  if (sig) {
    if (!g) {
      gaps.set(p.key, { openedAt: Date.now(), openedBlock: block, maxNet: sig.netUsd, route: sig.route });
      log(sig); // one SIGNAL line per gap, not per re-quote
      maybeAlert(p.key, sig);
    } else if (sig.netUsd > g.maxNet) {
      g.maxNet = sig.netUsd;
      g.route = sig.route;
    }
  } else if (g) {
    const secs = (Date.now() - g.openedAt) / 1000;
    gaps.delete(p.key);
    eventStats.gapsClosed++;
    eventStats.gapSecs.push(secs);
    log({ msg: 'GAP CLOSED', token: p.key, openSec: round(secs, 1), openBlocks: block - g.openedBlock, maxNetUsd: round(g.maxNet, 2), route: g.route });
  }
}

// ---------- live swap events ----------
const dirty = new Map(); // token key -> { block, at }
let requoting = false;
function onSwap(key, block) {
  eventStats.swaps++;
  const d = dirty.get(key);
  dirty.set(key, { block: Math.max(block, d?.block ?? 0), at: d?.at ?? Date.now() });
  drainDirty();
}
async function drainDirty() {
  if (requoting) return;
  requoting = true;
  try {
    while (dirty.size) {
      await sleep(EVENT_DEBOUNCE_MS);
      const batch = [...dirty.entries()];
      dirty.clear();
      const keys = new Set(batch.map(([k]) => k));
      const tokens = watch.filter((w) => keys.has(w.key));
      if (!tokens.length) continue;
      const block = Math.max(...batch.map(([, d]) => d.block));
      const eventAt = Math.min(...batch.map(([, d]) => d.at));
      const t0 = Date.now();
      try {
        await scanTokens(tokens, { blockTag: block, trigger: 'swap', eventAt });
      } catch (e) {
        // the HTTP node may not have served the event's block yet: retry on latest
        await scanTokens(tokens, { trigger: 'swap', eventAt }).catch((e2) => log({ msg: 'swap re-quote failed', err: e2.shortMessage ?? e2.message }));
      }
      eventStats.requotes++;
      eventStats.requoteMsTotal += Date.now() - t0;
    }
  } finally {
    requoting = false;
  }
}

// ---------- outputs ----------
function writeCsv(row) {
  if (!csvPath) return;
  const line = row.map((v) => (typeof v === 'string' && (v.includes(',') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v)).join(',') + '\n';
  fs.appendFile(csvPath, line, () => {});
}

async function notify(text) {
  const tasks = [];
  if (DISCORD_WEBHOOK_URL)
    tasks.push(fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) }));
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    tasks.push(fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
    }));
  const res = await Promise.allSettled(tasks);
  res.forEach((r) => r.status === 'rejected' && log({ msg: 'alert failed', err: String(r.reason) }));
}

function maybeAlert(key, s) {
  const now = Date.now();
  if (now - (lastAlert.get(key) ?? 0) < ALERT_COOLDOWN_MIN * 60000) return;
  lastAlert.set(key, now);
  notify(
    `Arb signal ${s.token} (block ${s.block})\n${s.route}\n` +
    `Size ~$${s.sizeUsd}: net ~$${s.netUsd} (${s.netBps} bps after gas)\n${s.url ?? ''}\nRead-only estimate. Real fills will be worse.`
  );
}

function summary(extra) {
  const rows = Object.entries(stats)
    .map(([token, s]) => ({ token, checks: s.checks, signals: s.signals, bestGrossBps: round(s.bestGrossBps, 2), bestNetUsd: round(s.bestNetUsd, 2), bestAt: s.bestAt }))
    .sort((a, b) => b.bestNetUsd - a.bestNetUsd);
  const secs = [...eventStats.gapSecs].sort((a, b) => a - b);
  const live = {
    connected: events?.stats.connected ?? false,
    swapsSeen: eventStats.swaps,
    requotes: eventStats.requotes,
    avgRequoteMs: eventStats.requotes ? Math.round(eventStats.requoteMsTotal / eventStats.requotes) : null,
    gapsClosed: eventStats.gapsClosed,
    medianGapSec: secs.length ? round(secs[Math.floor(secs.length / 2)], 1) : null,
    gapsOpenNow: gaps.size,
  };
  log({ msg: 'SUMMARY', ...extra, watching: watch.length, rpcRequests: batcher.rpcRequests, live, tokens: rows });
  Object.assign(eventStats, { swaps: 0, requotes: 0, requoteMsTotal: 0, gapsClosed: 0, gapSecs: [] });
  if (rows.length && (DISCORD_WEBHOOK_URL || TELEGRAM_BOT_TOKEN)) {
    const lines = rows.slice(0, 15).map((r) => `${r.token}: ${r.signals} signals, best net $${r.bestNetUsd} (gross ${r.bestGrossBps} bps, ${r.bestAt})`).join('\n');
    const liveLine = `Live: ${live.swapsSeen} swaps seen, ${live.requotes} re-quotes (avg ${live.avgRequoteMs ?? '-'} ms), ${live.gapsClosed} gaps closed (median ${live.medianGapSec ?? '-'} s)`;
    notify(`Scanner summary (last ${SUMMARY_EVERY_MIN} min, top ${Math.min(15, rows.length)})\n${liveLine}\n${lines}`);
  }
  for (const k of Object.keys(stats)) delete stats[k];
}

// ---------- main loop ----------
async function main() {
  await init();
  if (EVENTS && WSS_URL && typeof WebSocket === 'function') {
    events = startEvents({ wsUrl: WSS_URL, log, getWatch: () => watch, onSwap });
  } else {
    log({ msg: 'live swap events off', reason: !EVENTS ? 'EVENTS=false' : !WSS_URL ? 'no WebSocket URL (set WSS_URL)' : 'WebSocket not available in this Node version' });
  }
  let lastSummary = Date.now();
  let lastDiscovery = Date.now();
  let discovering = false;
  let lastInfo = {};
  let failures = 0;

  while (running) {
    const started = Date.now();
    // discovery takes ~1 min (API rate limits), so it runs alongside scanning
    if (!discovering && Date.now() - lastDiscovery >= DISCOVERY_EVERY_MIN * 60000) {
      discovering = true;
      lastDiscovery = Date.now();
      refreshWatchlist()
        .catch((e) => log({ msg: 'watchlist refresh error', err: e.message }))
        .finally(() => (discovering = false));
    }
    try {
      lastInfo = await scanOnce();
      failures = 0;
    } catch (e) {
      failures++;
      log({ msg: 'scan error', failures, err: e.shortMessage ?? e.message });
      if (failures >= 20) {
        log({ msg: 'too many consecutive errors, exiting so Render restarts the worker' });
        process.exit(1);
      }
    }
    if (Date.now() - lastSummary >= SUMMARY_EVERY_MIN * 60000) {
      summary({ ethUsd: round(lastInfo.ethUsd ?? 0, 2), gasUsdPerTx: round(lastInfo.gasUsd ?? 0, 4) });
      lastSummary = Date.now();
    }
    // with live events connected, the full scan is only a safety net, so it runs less often
    const interval = events?.stats.connected ? Math.max(SCAN_INTERVAL_MS, BACKUP_SCAN_MS) : SCAN_INTERVAL_MS;
    const wait = failures ? interval * Math.min(failures, 6) : Math.max(0, interval - (Date.now() - started));
    await sleep(wait);
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log({ msg: `${sig} received, shutting down` });
    running = false;
    events?.stop();
    summary({ reason: 'shutdown' });
    setTimeout(() => process.exit(0), 1500);
  });
}

main().catch((e) => {
  log({ msg: 'fatal', err: e.message });
  process.exit(1);
});
