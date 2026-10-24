// Read-only Camelot <-> Uniswap arbitrage scanner for Arbitrum One.
// Default MODE=trending: auto-discovers new / trending tokens listed on both DEXs.
// It never signs or sends transactions. It only reads quotes and logs gaps.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { CHAIN_ID, TOKENS, STABLES, QUOTE_TOKENS, DEFAULT_PAIRS } from './config.js';
import { Batcher, buildQuoteCalls } from './quotes.js';
import { discover } from './discovery.js';

// ---------- settings ----------
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));
const MODE = env('MODE', 'trending'); // trending | static
const RPC_URL = env('RPC_URL', 'https://arb1.arbitrum.io/rpc');
const SCAN_INTERVAL_MS = num('SCAN_INTERVAL_MS', 15000);
const MIN_PROFIT_USD = num('MIN_PROFIT_USD', 1);
const GAS_UNITS = BigInt(env('GAS_UNITS', 450000));
const L1_FEE_USD = num('L1_FEE_USD', 0.02);
const SUMMARY_EVERY_MIN = num('SUMMARY_EVERY_MIN', 60);
const CHUNK_SIZE = num('MULTICALL_CHUNK', 40);
const ALERT_COOLDOWN_MIN = num('ALERT_COOLDOWN_MIN', 10);
const DATA_DIR = env('DATA_DIR', '');
const DISCORD_WEBHOOK_URL = env('DISCORD_WEBHOOK_URL', '');
const TELEGRAM_BOT_TOKEN = env('TELEGRAM_BOT_TOKEN', '');
const TELEGRAM_CHAT_ID = env('TELEGRAM_CHAT_ID', '');

// trending-mode settings
const DISCOVERY_EVERY_MIN = num('DISCOVERY_EVERY_MIN', 10);
const DISCOVERY = {
  maxCandidates: num('MAX_CANDIDATES', 90), // tokens pulled from trending feeds per round
  maxTokens: num('MAX_TOKENS', 25), // tokens actually scanned
  minLiqUsd: num('MIN_LIQ_USD', 10000), // liquidity needed on BOTH the Camelot and Uniswap pool
  minVol24Usd: num('MIN_VOL24_USD', 10000),
  maxAgeDays: num('MAX_AGE_DAYS', 90), // 0 = no age limit
  maxTax: num('MAX_TAX', 0.005), // drop tokens with buy/sell tax above this (0.005 = 0.5%)
  requireSecurity: env('REQUIRE_SECURITY_CHECK', 'true') !== 'false',
  crossQuote: env('CROSS_QUOTE', 'true') !== 'false', // allow e.g. WETH pool on Camelot vs USDC pool on Uniswap
};
const CONVERT_GAS_UNITS = BigInt(env('CONVERT_GAS_UNITS', 150000)); // extra swap when quotes differ
const SIZE_PCTS = env('SIZE_PCTS', '0.5,2').split(',').map(Number); // % of the thinner pool's liquidity
const MIN_TRADE_USD = num('MIN_TRADE_USD', 50);
const MAX_TRADE_USD = num('MAX_TRADE_USD', 5000);

const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
const round = (x, d = 6) => Number(Number(x).toFixed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state ----------
const provider = new JsonRpcProvider(RPC_URL, Number(CHAIN_ID), { staticNetwork: true });
const batcher = new Batcher(provider, CHUNK_SIZE);
const decCache = new Map(); // lowercase address -> decimals
let watch = []; // [{ key, baseSym, base, camQuote, uniQuote, sizesUsd, v4Keys, url, info }]
const stats = {};
let csvPath = null;
let running = true;
const lastAlert = new Map();

async function decimalsOf(addresses) {
  const missing = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !decCache.has(a));
  // one at a time on failure so a single broken token can't block the rest
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

// USD price of every quote token (stables = $1, others via Uniswap -> USDC)
async function pricesAt(blockTag) {
  const prices = {};
  const groups = [];
  const all = [];
  for (const sym of QUOTE_TOKENS) {
    if (STABLES.has(sym)) { prices[sym] = 1; continue; }
    const calls = buildQuoteCalls(TOKENS[sym], TOKENS.USDC, parseUnits('1', dec(TOKENS[sym]))).filter((c) => c.dex === 'uniswap');
    groups.push({ sym, start: all.length, n: calls.length });
    all.push(...calls);
  }
  const q = await batcher.run(all, blockTag);
  for (const g of groups) {
    const best = q.slice(g.start, g.start + g.n).reduce((m, v) => (v !== null && v > m ? v : m), 0n);
    if (best === 0n) throw new Error(`Could not price ${g.sym}`);
    prices[g.sym] = Number(formatUnits(best, 6));
  }
  return prices;
}
const toUnits = (usd, sym, prices) => {
  const d = dec(TOKENS[sym]);
  return parseUnits((usd / prices[sym]).toFixed(Math.min(d, 8)), d);
};

// ---------- startup ----------
async function init() {
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${net.chainId}, expected Arbitrum One (42161)`);
  await decimalsOf(Object.values(TOKENS));
  await venueCheck();

  if (DATA_DIR) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    csvPath = path.join(DATA_DIR, 'signals.csv');
    if (!fs.existsSync(csvPath))
      fs.writeFileSync(csvPath, 'time,block,pair,token,size_usd,start_token,buy_on,sell_on,route,amount_in,amount_back,gross_usd,gas_usd,net_usd,net_bps\n');
  }

  if (MODE === 'static') {
    const pairs = process.env.PAIRS_JSON ? JSON.parse(process.env.PAIRS_JSON) : DEFAULT_PAIRS;
    const prices = await pricesAt('latest');
    watch = pairs.map((p) => {
      if (!TOKENS[p.base] || !QUOTE_TOKENS.includes(p.quote)) throw new Error(`Unsupported pair ${p.base}/${p.quote}`);
      return makeEntry({ baseSym: p.base, base: TOKENS[p.base], camQuote: p.quote, uniQuote: p.quote, sizesUsd: p.sizes.map((x) => x * prices[p.quote]) });
    });
  } else {
    await refreshWatchlist();
  }
  log({ msg: 'scanner started (read-only)', mode: MODE, rpc: RPC_URL.replace(/\/[^/]{12,}$/, '/***'), intervalMs: SCAN_INTERVAL_MS, minProfitUsd: MIN_PROFIT_USD, watching: watch.length });
}

function makeEntry({ baseSym, base, camQuote, uniQuote, sizesUsd, v4Keys = [], url = null, info = null }) {
  const quotes = camQuote === uniQuote ? camQuote : `C:${camQuote} U:${uniQuote}`;
  return { key: `${baseSym}(${base.slice(0, 6)})/${quotes}`, baseSym, base, camQuote, uniQuote, sizesUsd: sizesUsd.map((u) => round(u, 2)), v4Keys, url, info };
}

// Startup self-check: quote 1 WETH -> USDC on every venue and compare to Uniswap V3.
async function venueCheck() {
  // 0.1 WETH keeps price impact small, so a thin pool doesn't look like a broken quoter
  const calls = buildQuoteCalls(TOKENS.WETH, TOKENS.USDC, parseUnits('0.1', 18));
  const res = await batcher.run(calls, 'latest');
  const prices = calls.map((c, i) => ({ venue: c.venue, usd: res[i] === null ? null : Number(formatUnits(res[i], 6)) * 10 }));
  const ref = Math.max(...prices.filter((p) => p.venue.startsWith('uni') && p.usd).map((p) => p.usd));
  if (!Number.isFinite(ref) || ref <= 0) throw new Error('Uniswap quoter returned nothing for WETH/USDC. Check RPC_URL.');
  for (const p of prices) {
    p.status = p.usd === null ? 'no quote (pool missing or call failed)' : Math.abs(p.usd / ref - 1) > 0.05 ? 'far off Uniswap (thin pool for WETH/USDC, or quoter problem)' : 'ok';
    if (p.usd !== null) p.usd = round(p.usd, 2);
  }
  log({ msg: 'venue check: ETH price per venue (quoted with 0.1 WETH -> USDC)', venues: prices });
  if (!prices.some((p) => p.venue.startsWith('camelot') && p.status === 'ok'))
    log({ msg: 'WARNING: no Camelot venue returned a sane quote; Camelot results will be missing' });
}

// ---------- trending watchlist ----------
async function refreshWatchlist() {
  const started = Date.now();
  let found;
  try {
    found = await discover({ log, opts: DISCOVERY });
  } catch (e) {
    log({ msg: 'discovery failed, keeping previous watchlist', err: e.message });
    return;
  }
  await decimalsOf(found.list.map((t) => t.token));

  const next = [];
  for (const t of found.list) {
    if (dec(t.token) == null) continue;
    const sizesUsd = [...new Set(SIZE_PCTS.map((p) => Math.min(MAX_TRADE_USD, Math.max(MIN_TRADE_USD, (t.minSide * p) / 100))))];
    next.push(
      makeEntry({
        baseSym: t.symbol ?? '?', base: t.token, camQuote: t.camQuote, uniQuote: t.uniQuote, sizesUsd, v4Keys: t.v4Keys, url: t.url,
        info: { liqCamelot: Math.round(t.cam), liqUniswap: Math.round(t.uni), vol24: Math.round(t.vol24), ageDays: t.ageDays == null ? null : round(t.ageDays, 1), security: t.security, sources: t.sources },
      })
    );
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
    watching: watch.map((w) => ({ pair: w.key, sizesUsd: w.sizesUsd, v4Pools: w.v4Keys.length, ...w.info })),
    added: added.map((w) => w.key),
    removed,
    skipStats: found.skipStats,
    skippedSample: found.skipped.slice(0, 40).map(({ address, category, ...x }) => x),
  });
  if (added.length)
    notify(`Now watching ${added.length} new token(s):\n` + added.map((w) => `${w.key}  liq C $${w.info.liqCamelot} / U $${w.info.liqUniswap}  ${w.url ?? ''}`).join('\n'));
}

// ---------- one scan cycle ----------
// Each watched token is tried in both directions:
//   A) buy on Camelot with its quote token -> sell on Uniswap for Uniswap's quote token
//   B) buy on Uniswap -> sell on Camelot
// If the two quote tokens differ, a third leg converts the proceeds back to the
// starting token (best venue on either DEX), so profit is always like-for-like.
const bestOf = (calls, results, offset) => {
  let best = null;
  calls.forEach((c, i) => {
    const v = results[offset + i];
    if (v !== null && (!best || v > best.out)) best = { out: v, venue: c.venue };
  });
  return best;
};

async function scanOnce() {
  if (!watch.length) return {};
  const block = await provider.getBlockNumber();
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 10_000_000n;
  const prices = await pricesAt(block);
  const gasUsdFor = (convert) => Number(formatUnits(gasPrice * (GAS_UNITS + (convert ? CONVERT_GAS_UNITS : 0n)), 18)) * prices.WETH + L1_FEE_USD;

  // Round 1: buy the token
  const jobs = [];
  const r1Calls = [];
  for (const p of watch) {
    for (const sizeUsd of p.sizesUsd) {
      for (const [buyDex, sellDex] of [['camelot', 'uniswap'], ['uniswap', 'camelot']]) {
        const inSym = buyDex === 'camelot' ? p.camQuote : p.uniQuote;
        const outSym = sellDex === 'camelot' ? p.camQuote : p.uniQuote;
        const amountIn = toUnits(sizeUsd, inSym, prices);
        const calls = buildQuoteCalls(TOKENS[inSym], p.base, amountIn, p.v4Keys).filter((c) => c.dex === buyDex);
        jobs.push({ p, sizeUsd, buyDex, sellDex, inSym, outSym, amountIn, c1: calls, o1: r1Calls.length });
        r1Calls.push(...calls);
      }
    }
  }
  const r1 = await batcher.run(r1Calls, block);

  // Round 2: sell it on the other DEX
  const r2Calls = [];
  for (const j of jobs) {
    j.bought = bestOf(j.c1, r1, j.o1);
    if (!j.bought) continue;
    j.c2 = buildQuoteCalls(j.p.base, TOKENS[j.outSym], j.bought.out, j.p.v4Keys).filter((c) => c.dex === j.sellDex);
    j.o2 = r2Calls.length;
    r2Calls.push(...j.c2);
  }
  const r2 = await batcher.run(r2Calls, block);

  // Round 3: convert back to the starting token if the quotes differ
  const r3Calls = [];
  for (const j of jobs) {
    if (!j.bought) continue;
    j.sold = bestOf(j.c2, r2, j.o2);
    if (!j.sold || j.inSym === j.outSym) continue;
    j.c3 = buildQuoteCalls(TOKENS[j.outSym], TOKENS[j.inSym], j.sold.out);
    j.o3 = r3Calls.length;
    r3Calls.push(...j.c3);
  }
  const r3 = r3Calls.length ? await batcher.run(r3Calls, block) : [];

  for (const j of jobs) {
    const { p } = j;
    const st = (stats[p.key] ??= { checks: 0, signals: 0, bestNetUsd: -Infinity, bestGrossBps: -Infinity, bestAt: null, url: p.url });
    if (!j.sold) continue;
    const convert = j.inSym !== j.outSym;
    const back = convert ? bestOf(j.c3, r3, j.o3) : { out: j.sold.out, venue: null };
    if (!back) continue;
    st.checks++;

    const inDec = dec(TOKENS[j.inSym]);
    const inNum = Number(formatUnits(j.amountIn, inDec));
    const outNum = Number(formatUnits(back.out, inDec));
    const px = prices[j.inSym];
    const gasUsd = gasUsdFor(convert);
    const grossUsd = (outNum - inNum) * px;
    const netUsd = grossUsd - gasUsd;
    const grossBps = ((outNum - inNum) / inNum) * 10000;
    const netBps = (netUsd / (inNum * px)) * 10000;

    if (netUsd > st.bestNetUsd) { st.bestNetUsd = netUsd; st.bestAt = `$${Math.round(j.sizeUsd)} buy@${j.buyDex}`; }
    if (grossBps > st.bestGrossBps) st.bestGrossBps = grossBps;

    if (netUsd >= MIN_PROFIT_USD) {
      st.signals++;
      const route = [
        `buy ${p.baseSym} with ${j.inSym} on ${j.buyDex} (${j.bought.venue})`,
        `sell for ${j.outSym} on ${j.sellDex} (${j.sold.venue})`,
        ...(convert ? [`convert ${j.outSym}->${j.inSym} (${back.venue})`] : []),
      ].join(' -> ');
      const sig = {
        msg: 'SIGNAL', block, pair: p.key, token: p.base, sizeUsd: round(j.sizeUsd, 0), route,
        in: `${round(inNum)} ${j.inSym}`, out: `${round(outNum)} ${j.inSym}`,
        grossBps: round(grossBps, 2), gasUsd: round(gasUsd, 4), netUsd: round(netUsd, 2), netBps: round(netBps, 2), url: p.url,
      };
      log(sig);
      writeCsv([new Date().toISOString(), block, p.key, p.base, round(j.sizeUsd, 2), j.inSym, j.buyDex, j.sellDex, route, inNum, outNum, round(grossUsd, 4), round(gasUsd, 4), round(netUsd, 4), round(netBps, 2)]);
      maybeAlert(`${p.key}|${j.buyDex}`, sig);
    }
  }
  return { block, ethUsd: prices.WETH, gasUsd: gasUsdFor(false) };
}

// ---------- outputs ----------
function writeCsv(row) {
  if (!csvPath) return;
  const line = row.map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v)).join(',') + '\n';
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
    `Arb signal ${s.pair} (block ${s.block})\n${s.route}\n` +
    `Size ~$${s.sizeUsd}: net ~$${s.netUsd} (${s.netBps} bps after gas)\n${s.url ?? ''}\nRead-only estimate. Real fills will be worse.`
  );
}

function summary(extra) {
  const rows = Object.entries(stats)
    .map(([pair, s]) => ({ pair, checks: s.checks, signals: s.signals, bestGrossBps: round(s.bestGrossBps, 2), bestNetUsd: round(s.bestNetUsd, 2), bestAt: s.bestAt }))
    .sort((a, b) => b.bestNetUsd - a.bestNetUsd);
  log({ msg: 'SUMMARY', ...extra, watching: watch.length, rpcRequests: batcher.rpcRequests, pairs: rows });
  if (rows.length && (DISCORD_WEBHOOK_URL || TELEGRAM_BOT_TOKEN)) {
    const lines = rows.slice(0, 15).map((r) => `${r.pair}: ${r.signals} signals, best net $${r.bestNetUsd} (gross ${r.bestGrossBps} bps, ${r.bestAt})`).join('\n');
    notify(`Scanner summary (last ${SUMMARY_EVERY_MIN} min, top ${Math.min(15, rows.length)})\n${lines}`);
  }
  for (const k of Object.keys(stats)) delete stats[k];
}

// ---------- main loop ----------
async function main() {
  await init();
  let lastSummary = Date.now();
  let lastDiscovery = Date.now();
  let discovering = false;
  let lastInfo = {};
  let failures = 0;

  while (running) {
    const started = Date.now();
    // Discovery takes ~1 min (API rate limits), so it runs alongside scanning
    if (MODE !== 'static' && !discovering && Date.now() - lastDiscovery >= DISCOVERY_EVERY_MIN * 60000) {
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
    const wait = failures ? SCAN_INTERVAL_MS * Math.min(failures, 6) : Math.max(0, SCAN_INTERVAL_MS - (Date.now() - started));
    await sleep(wait);
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log({ msg: `${sig} received, shutting down` });
    running = false;
    summary({ reason: 'shutdown' });
    setTimeout(() => process.exit(0), 1500);
  });
}

main().catch((e) => {
  log({ msg: 'fatal', err: e.message });
  process.exit(1);
});
