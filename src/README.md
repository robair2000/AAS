# Arbitrum arb scanner — new & trending tokens (Camelot ↔ Uniswap), read-only

Finds **new, trending Arbitrum tokens** that trade on both **Camelot** and **Uniswap**, then watches them for round trips that would be profitable after fees, price impact and gas:

> buy TOKEN with WETH/USDC on DEX A → sell it back on DEX B

It **never signs or sends a transaction** and needs no private key. The goal is to measure how often real gaps appear on young tokens before you spend money on an execution bot.

## How it works

**Discovery (every 10 min)**
1. Pulls candidates from free feeds: GeckoTerminal trending + newest Arbitrum pools, DexScreener boosted tokens and new token profiles.
2. Drops established tokens (WETH, stables, ARB, GMX, LINK, UNI, wstETH…; see `EXCLUDE_TOKENS` in `src/config.js`).
3. Asks DexScreener for every pool of each candidate and keeps tokens that have a pool on **both** Camelot and Uniswap, paired against WETH, USDC, USDC.e, USDT, WBTC or ARB, with at least `MIN_LIQ_USD` on each side, enough 24h volume, and a first pool younger than `MAX_AGE_DAYS`. The two DEXs may use **different** quote tokens (e.g. TOKEN/WETH on Camelot, TOKEN/USDC on Uniswap); the same quote is preferred when liquidity is similar.
4. Runs a **GoPlus security check** and drops honeypots, tokens with tax above `MAX_TAX`, owner-controlled balances, modifiable tax, pausable transfers, or unverified contracts.
5. Sizes trades from liquidity: 0.5 % and 2 % of the thinner pool (clamped to $50–$5,000).

**Scanning (every 15 s)**
1. Pins one block so every quote is consistent.
2. Quotes the buy on every venue — Uniswap V3 (all fee tiers), Uniswap V4 (hookless pools), Camelot V3 and Camelot V2 — through Multicall3, keeping the best per DEX.
3. Quotes selling the exact amount bought into the *other* DEX.
4. If the quote tokens differ, quotes converting the proceeds back to the starting token on the best venue (an extra swap, with extra gas counted).
5. Subtracts estimated gas and logs a `SIGNAL` when net profit ≥ `MIN_PROFIT_USD`.
6. Logs a `SUMMARY` every hour, ranked by best gap.

## Deploy on Render (background worker)

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo (it reads `render.yaml`), or **New → Background Worker** with build `npm install` and start `npm start`.
3. Set `RPC_URL` (and optional Discord/Telegram vars) in the Environment tab.
4. Watch the **Logs** tab. In order you should see:
   - `venue check` — quotes 1 WETH → USDC on every venue; each should say `ok`. A Camelot venue saying `no quote` or `WARNING` means its quotes aren't being read correctly.
   - `watchlist updated` — the tokens it picked, their liquidity on each DEX, and a sample of skipped tokens with the reason.
   - `SIGNAL` lines and an hourly `SUMMARY`.

Notes:
- Background workers have **no free tier** on Render; Starter is enough.
- Render's disk is wiped on every deploy/restart and logs are kept for a limited time. Use Discord/Telegram for alerts and summaries, or add a persistent disk and set `DATA_DIR=/var/data` to keep `signals.csv`.
- The worker exits after 20 consecutive RPC errors so Render restarts it.

## Tuning

| Want | Change |
|---|---|
| Younger tokens only | `MAX_AGE_DAYS=14` |
| More tokens (more risk) | lower `MIN_LIQ_USD`, `MIN_VOL24_USD` |
| Same quote token on both DEXs only | `CROSS_QUOTE=false` |
| Fewer RPC requests | raise `SCAN_INTERVAL_MS`, lower `MAX_TOKENS` |
| Bigger/smaller test trades | `SIZE_PCTS`, `MAX_TRADE_USD` |
| Old fixed list of big pairs | `MODE=static` |

RPC load: 25 tokens × 2 sizes is roughly 700 quotes ≈ 20 RPC requests per cycle. At 15 s that's ~115k requests/day, more than most free RPC plans allow. Use 30–60 s or a paid plan.

## What it can't see (yet)

- **Uniswap V4 pools with hooks or unusual fees.** Many new launches use these; they're listed under `skippedSample` in the watchlist log.
- **Camelot's newest pool version** (Algebra Integral). Tokens only listed there are skipped.
- **Transfer taxes in the quotes themselves.** The DEX quoters ignore token taxes, which is why taxed tokens are filtered by the security check. A token can change its tax later.

## Reading signals on young tokens

Signals are **upper bounds**. On new tokens a big gap is often there for a reason: the pool is about to be pulled, the token has hidden sell restrictions the security check missed, or liquidity is so thin the gap disappears with any real trade. Check the token on DexScreener (the link is in each alert) before trusting anything.
