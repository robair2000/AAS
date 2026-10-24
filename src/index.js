// Read-only Camelot <-> Uniswap arbitrage scanner for Arbitrum One.
// Default MODE=trending: auto-discovers new / trending tokens listed on both DEXs.
// It never signs or sends transactions. It only reads quotes and logs gaps.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import { CHAIN_ID, TOKENS, STABLES, DEFAULT_PAIRS } from './config.js';
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
  minLiqUsd: num('MIN_LIQ_USD', 15000), // liquidity needed on BOTH the Camelot and Uniswap pool
  minVol24Usd: num('MIN_VOL24_USD', 10000),
  maxAgeDays: num('MAX_AGE_DAYS', 90), // 0 = no age limit
  maxTax: num('MAX_TAX', 0.005), // drop tokens with buy/sell tax above this (0.005 = 0.5%)
  requireSecurity: env('REQUIRE_SECURITY_CHECK', 'true') !== 'false',
};
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
let watch = []; // [{ key, baseSym, base, baseDec, quoteSym, quote, quoteDec, sizes, v4Keys, url, info }]
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

async function ethUsdAt(blockTag) {
  const calls = buildQuoteCalls(TOKENS.WETH, TOKENS.USDC, parseUnits('1', 18)).filter((c) => c.dex === 'uniswap');
  const q = await batcher.run(calls, blockTag);
  const best = q.reduce((m, v) => (v !== null && v > m ? v : m), 0n);
  if (best === 0n) throw new Error('Could not price ETH');
  return Number(formatUnits(best, 6));
}

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
      fs.writeFileSync(csvPath, 'time,block,pair,token,size,quote,buy_on,sell_on,amount_in,amount_out,gross,gas_cost,net,net_usd,net_bps\n');
  }

  if (MODE === 'static') {
    const pairs = process.env.PAIRS_JSON ? JSON.parse(process.env.PAIRS_JSON) : DEFAULT_PAIRS;
    watch = pairs.map((p) => {
      if (!TOKENS[p.base] || !TOKENS[p.quote]) throw new Error(`Unknown token in pair ${p.base}/${p.quote}`);
      return makeEntry({ baseSym: p.base, base: TOKENS[p.base], quoteSym: p.quote, sizes: p.sizes });
    });
  } else {
    await refreshWatchlist();
  }
  log({ msg: 'scanner started (read-only)', mode: MODE, rpc: RPC_URL.replace(/\/[^/]{12,}$/, '/***'), intervalMs: SCAN_INTERVAL_MS, minProfitUsd: MIN_PROFIT_USD, watching: watch.length });
}

function makeEntry({ baseSym, base, quoteSym, sizes, v4Keys = [], url = null, info = null }) {
  return {
    key: `${baseSym}(${base.slice(0, 6)})/${quoteSym}`,
    baseSym, base, baseDec: dec(base),
    quoteSym, quote: TOKENS[quoteSym], quoteDec: dec(TOKENS[quoteSym]),
    sizes, v4Keys, url, info,
  };
}

// Startup self-check: quote 1 WETH -> USDC on every venue and compare to Uniswap V3.
async function venueCheck() {
  const calls = buildQuoteCalls(TOKENS.WETH, TOKENS.USDC, parseUnits('1', 18));
  const res = await batcher.run(calls, 'latest');
  const prices = calls.map((c, i) => ({ venue: c.venue, usd: res[i] === null ? null : Number(formatUnits(res[i], 6)) }));
  const ref = Math.max(...prices.filter((p) => p.venue.startsWith('uni') && p.usd).map((p) => p.usd));
  if (!Number.isFinite(ref) || ref <= 0) throw new Error('Uniswap quoter returned nothing for WETH/USDC. Check RPC_URL.');
  for (const p of prices) {
    p.status = p.usd === null ? 'no quote (pool missing or call failed)' : Math.abs(p.usd / ref - 1) > 0.05 ? 'WARNING: >5% off Uniswap' : 'ok';
    if (p.usd !== null) p.usd = round(p.usd, 2);
  }
  log({ msg: 'venue check: 1 WETH -> USDC', venues: prices });
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
  const ethUsd = await ethUsdAt('latest');
  await decimalsOf(found.list.map((t) => t.token));

  const next = [];
  for (const t of found.list) {
    if (dec(t.token) == null) continue;
    const quoteUsd = t.quoteSym === 'WETH' ? ethUsd : 1;
    const sizesUsd = [...new Set(SIZE_PCTS.map((p) => Math.min(MAX_TRADE_USD, Math.max(MIN_TRADE_USD, (t.minSide * p) / 100))))];
    const qDec = dec(TOKENS[t.quoteSym]);
    const sizes = sizesUsd.map((u) => Number((u / quoteUsd).toFixed(Math.min(qDec, 8))));
    next.push(
      makeEntry({
        baseSym: t.symbol ?? '?', base: t.token, quoteSym: t.quoteSym, sizes, v4Keys: t.v4Keys, url: t.url,
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
    watching: watch.map((w) => ({ pair: w.key, sizes: w.sizes, v4Pools: w.v4Keys.length, ...w.info })),
    added: added.map((w) => w.key),
    removed,
    skippedSample: found.skipped.slice(0, 25),
  });
  if (added.length)
    notify(`Now watching ${added.length} new token(s):\n` + added.map((w) => `${w.key}  liq C $${w.info.liqCamelot} / U $${w.info.liqUniswap}  ${w.url ?? ''}`).join('\n'));
}

// ---------- one scan cycle ----------
async function scanOnce() {
  if (!watch.length) return {};
  const block = await provider.getBlockNumber();
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 10_000_000n;
  const ethUsd = await ethUsdAt(block);
  const gasUsd = Number(formatUnits(gasPrice * GAS_UNITS, 18)) * ethUsd + L1_FEE_USD;

  // Round 1: buy BASE with QUOTE on every venue
  const jobs = [];
  const round1 = [];
  for (const p of watch) {
    for (const size of p.sizes) {
      const amountIn = parseUnits(String(size), p.quoteDec);
      const calls = buildQuoteCalls(p.quote, p.base, amountIn, p.v4Keys);
      jobs.push({ p, size, amountIn, r1Start: round1.length, r1Calls: calls });
      round1.push(...calls);
    }
  }
  const r1 = await batcher.run(round1, block);

  // Round 2: sell what DEX A gave us into DEX B (both directions)
  const round2 = [];
  for (const job of jobs) {
    job.best = {};
    job.r1Calls.forEach((c, i) => {
      const v = r1[job.r1Start + i];
      if (v !== null && (!job.best[c.dex] || v > job.best[c.dex].out)) job.best[c.dex] = { out: v, venue: c.venue };
    });
    job.legs = [];
    for (const [buyDex, sellDex] of [['uniswap', 'camelot'], ['camelot', 'uniswap']]) {
      const bought = job.best[buyDex];
      if (!bought) continue;
      const sellCalls = buildQuoteCalls(job.p.base, job.p.quote, bought.out, job.p.v4Keys).filter((c) => c.dex === sellDex);
      job.legs.push({ buyDex, sellDex, bought, start: round2.length, calls: sellCalls });
      round2.push(...sellCalls);
    }
  }
  const r2 = await batcher.run(round2, block);

  for (const job of jobs) {
    const { p, size, amountIn } = job;
    const st = (stats[p.key] ??= { cycles: 0, signals: 0, bestNetUsd: -Infinity, bestGrossBps: -Infinity, bestAt: null, url: p.url });
    if (size === p.sizes[0]) st.cycles++;
    const quoteUsd = p.quoteSym === 'WETH' ? ethUsd : 1;
    const gasInQuote = gasUsd / quoteUsd;

    for (const leg of job.legs) {
      let best = null;
      leg.calls.forEach((c, i) => {
        const v = r2[leg.start + i];
        if (v !== null && (!best || v > best.out)) best = { out: v, venue: c.venue };
      });
      if (!best) continue;

      const inNum = Number(formatUnits(amountIn, p.quoteDec));
      const outNum = Number(formatUnits(best.out, p.quoteDec));
      const gross = outNum - inNum;
      const net = gross - gasInQuote;
      const netUsd = net * quoteUsd;
      const grossBps = (gross / inNum) * 10000;
      const netBps = (net / inNum) * 10000;

      if (netUsd > st.bestNetUsd) { st.bestNetUsd = netUsd; st.bestAt = `$${Math.round(inNum * quoteUsd)} buy@${leg.buyDex}`; }
      if (grossBps > st.bestGrossBps) st.bestGrossBps = grossBps;

      if (netUsd >= MIN_PROFIT_USD) {
        st.signals++;
        const sig = {
          msg: 'SIGNAL', block, pair: p.key, token: p.base, size, sizeUsd: round(inNum * quoteUsd, 0),
          buyOn: `${leg.buyDex} (${leg.bought.venue})`, sellOn: `${leg.sellDex} (${best.venue})`,
          in: round(inNum), out: round(outNum), grossBps: round(grossBps, 2), gasUsd: round(gasUsd, 4),
          netUsd: round(netUsd, 2), netBps: round(netBps, 2), url: p.url,
        };
        log(sig);
        writeCsv([new Date().toISOString(), block, p.key, p.base, size, p.quoteSym, sig.buyOn, sig.sellOn, inNum, outNum, gross, gasInQuote, net, netUsd, netBps]);
        maybeAlert(`${p.key}|${leg.buyDex}`, sig);
      }
    }
  }
  return { block, ethUsd, gasUsd };
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
    `Arb signal ${s.pair} (block ${s.block})\nBuy on ${s.buyOn}, sell on ${s.sellOn}\n` +
    `Size ~$${s.sizeUsd}: net ~$${s.netUsd} (${s.netBps} bps after gas)\n${s.url ?? ''}\nRead-only estimate. Real fills will be worse.`
  );
}

function summary(extra) {
  const rows = Object.entries(stats)
    .map(([pair, s]) => ({ pair, cycles: s.cycles, signals: s.signals, bestGrossBps: round(s.bestGrossBps, 2), bestNetUsd: round(s.bestNetUsd, 2), bestAt: s.bestAt }))
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
  let lastInfo = {};
  let failures = 0;

  while (running) {
    const started = Date.now();
    if (MODE !== 'static' && Date.now() - lastDiscovery >= DISCOVERY_EVERY_MIN * 60000) {
      await refreshWatchlist().catch((e) => log({ msg: 'watchlist refresh error', err: e.message }));
      lastDiscovery = Date.now();
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
