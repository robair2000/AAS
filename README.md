# Arbitrum multi-DEX arb scanner — read-only

Finds trending Arbitrum tokens that trade in **two or more pools** across:

| DEX | Pool types |
|---|---|
| Uniswap | v2, v3 (all fee tiers), v4 (hookless pools) |
| PancakeSwap | v3 |
| SushiSwap | v2, v3 |
| Camelot | v2, v3 |

…then watches them for "buy in one pool, sell in another" round trips that would be profitable after pool fees, price impact and gas. Two pools on the **same** DEX count too (e.g. Uniswap 0.3 % vs 1 %, or Uniswap v3 vs v4).

It **never signs or sends a transaction** and needs no private key.

## How it works

**Discovery (every 15 min)**
1. Candidates from GeckoTerminal trending + newest Arbitrum pools, DexScreener boosted tokens and new profiles, plus any addresses in `WATCH_TOKENS`.
2. Drops established tokens (WETH, stables, ARB, GMX, LINK, UNI, wstETH…; see `src/config.js`).
3. Pulls every pool of each candidate from DexScreener. Keeps pools on the DEXs above, paired with WETH, USDC, USDC.e, USDT, WBTC or ARB, with at least `MIN_LIQ_USD`. Uniswap/PancakeSwap/SushiSwap pools are classified as v2 or v3 on-chain (by reading the pool's fee).
4. A token needs **2+ usable pools**, enough 24h volume, and a first pool younger than `MAX_AGE_DAYS`.
5. GoPlus security check: drops honeypots, tax above `MAX_TAX`, owner-controlled balances, modifiable tax, pausable transfers, unverified contracts.
6. Trade sizes: 0.5 % and 2 % of the 2nd-deepest pool (clamped to $50–$5,000).

**Scanning (every 15 s)** — for each token and size, at one pinned block:
1. Quote buying the token on every pool; take the pool giving the most tokens.
2. Quote selling that amount on every *other* pool; take the one returning the most USD.
3. If the two pools use different quote tokens, quote converting back (best of Uniswap V3 / Camelot V3), with extra gas counted.
4. Log a `SIGNAL` when net profit ≥ `MIN_PROFIT_USD`; log a `SUMMARY` every hour.

## Deploy on Render (background worker)

1. Push this folder to GitHub with `render.yaml`, `package.json` and `README.md` at the **top level** and the `.js` files inside `src/`.
2. Render: **New → Blueprint** (reads `render.yaml`), or **New → Background Worker** with build `npm install`, start `npm start`.
3. Set `RPC_URL` (and optional Discord/Telegram vars) in the Environment tab.
4. In **Logs**, in order:
   - `venue check` — each DEX prices 0.1 WETH → USDC. `ok` means its quoter works. `no quote` means its pools are ignored.
   - `watchlist updated` — tokens picked, with each pool and its liquidity, plus `skipStats` and a sample of skipped tokens with reasons.
   - `SIGNAL` lines and an hourly `SUMMARY`.

Notes: background workers have no free tier on Render (Starter is enough). Logs are kept for a limited time; use Discord/Telegram, or a persistent disk + `DATA_DIR=/var/data` for `signals.csv`.

## Tuning

| Want | Change |
|---|---|
| Newer tokens only | `MAX_AGE_DAYS=14` |
| More tokens (more noise) | lower `MIN_LIQ_USD`, `MIN_VOL24_USD` |
| Always watch a token | `WATCH_TOKENS=0xabc…,0xdef…` |
| Fewer RPC requests | raise `SCAN_INTERVAL_MS`, lower `MAX_TOKENS` / `MAX_POOLS_PER_TOKEN` |
| Fewer GeckoTerminal 429s | raise `DISCOVERY_EVERY_MIN` |

RPC load is roughly tokens × sizes × pools × 2 quotes per cycle. 25 tokens × 2 sizes × 4 pools ≈ 400 quotes ≈ 12 requests per cycle.

## What it can't see

- Uniswap v4 pools with hooks or unusual fees, and Camelot's newest pool version.
- PancakeSwap v2 pools, and v3 pools with non-standard fee tiers.
- Token transfer taxes in the quotes themselves (taxed tokens are filtered by the security check instead).

## Reading signals

Signals are **upper bounds**. A real bot sees them later than this scanner and competes with faster searchers. On young tokens a big gap often means trouble: liquidity about to be pulled, hidden sell restrictions, or a pool too thin to fill. Check the DexScreener link in each alert.
