// Live swap events over a WebSocket (eth_subscribe "logs").
// Every watched pool is subscribed; when one trades, its token is reported via
// onSwap(tokenKey, blockNumber) so the scanner can re-quote just that token.
//
// Topics:
//   Uniswap V3 / SushiSwap V3 / Camelot V3 (Algebra): Swap(address,address,int256,int256,uint160,uint128,int24)
//   PancakeSwap V3: Swap(...,int24,uint128,uint128)
//   V2 pairs (Uniswap/SushiSwap/Camelot): Sync(uint112,uint112)
//   Uniswap V4: PoolManager Swap(bytes32 id, ...) with the pool id as topic1
import { id as topicOf } from 'ethers';

const V3_SWAP = topicOf('Swap(address,address,int256,int256,uint160,uint128,int24)');
const PCS_SWAP = topicOf('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
const V2_SYNC = topicOf('Sync(uint112,uint112)');
const V4_SWAP = topicOf('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
export const POOL_MANAGER = '0x360e68faccca8ca495c1b759fd9eee466db9fb32'; // Uniswap v4, Arbitrum

export function startEvents({ wsUrl, log, getWatch, onSwap }) {
  let ws = null;
  let closedByUs = false;
  let backoff = 2000;
  let reqId = 100;
  let lastPong = Date.now();
  let keepalive = null;
  let poolToTokens = new Map(); // lowercase pool address -> Set(token keys)
  let v4ToTokens = new Map(); // lowercase pool id -> Set(token keys)
  const stats = { connected: false, connects: 0, events: 0, unknownEvents: 0, lastEventAt: null };

  function buildMaps() {
    poolToTokens = new Map();
    v4ToTokens = new Map();
    for (const w of getWatch()) {
      for (const v of w.venues) {
        if (!v.id) continue;
        const m = v.dex === 'uniswap-v4' ? v4ToTokens : poolToTokens;
        if (!m.has(v.id)) m.set(v.id, new Set());
        m.get(v.id).add(w.key);
      }
    }
  }

  const send = (method, params) => {
    const id = ++reqId;
    try { ws?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { /* reconnect handles it */ }
    return id;
  };

  function subscribe() {
    const pools = [...poolToTokens.keys()];
    const v4ids = [...v4ToTokens.keys()];
    if (pools.length) send('eth_subscribe', ['logs', { address: pools, topics: [[V3_SWAP, PCS_SWAP, V2_SYNC]] }]);
    if (v4ids.length) send('eth_subscribe', ['logs', { address: POOL_MANAGER, topics: [V4_SWAP, v4ids] }]);
    log({ msg: 'swap events subscribed', pools: pools.length, v4Pools: v4ids.length });
  }

  function handle(raw) {
    let m;
    try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch { return; }
    lastPong = Date.now();
    if (m.error) { log({ msg: 'websocket rpc error', err: m.error.message ?? m.error }); return; }
    if (m.method !== 'eth_subscription') return;
    const l = m.params?.result;
    if (!l || l.removed) return;
    const block = Number(l.blockNumber);
    let keys;
    if (l.address?.toLowerCase() === POOL_MANAGER) keys = v4ToTokens.get(l.topics?.[1]?.toLowerCase());
    else keys = poolToTokens.get(l.address?.toLowerCase());
    if (!keys) { stats.unknownEvents++; return; }
    stats.events++;
    stats.lastEventAt = new Date().toISOString();
    for (const k of keys) onSwap(k, block, l.address);
  }

  function connect() {
    buildMaps();
    if (!poolToTokens.size && !v4ToTokens.size) { stats.connected = false; return; } // nothing to watch yet
    closedByUs = false;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      log({ msg: 'websocket failed to open', err: e.message });
      return scheduleReconnect();
    }
    ws.onopen = () => {
      stats.connected = true;
      stats.connects++;
      backoff = 2000;
      lastPong = Date.now();
      subscribe();
      clearInterval(keepalive);
      // quiet pools send nothing, so ping with a cheap call and reconnect if the socket died
      keepalive = setInterval(() => {
        if (Date.now() - lastPong > 75000) { log({ msg: 'websocket silent, reconnecting' }); try { ws.close(); } catch {} return; }
        send('eth_blockNumber', []);
      }, 30000);
    };
    ws.onmessage = (ev) => handle(ev.data);
    ws.onerror = (ev) => log({ msg: 'websocket error', err: ev?.message ?? 'connection error' });
    ws.onclose = () => {
      stats.connected = false;
      clearInterval(keepalive);
      if (!closedByUs) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60000);
    log({ msg: 'websocket disconnected, reconnecting', inSec: wait / 1000 });
    setTimeout(connect, wait);
  }

  // call after the watchlist changes: reconnect with the new pool list
  function refresh() {
    closedByUs = true;
    clearInterval(keepalive);
    try { ws?.close(); } catch {}
    ws = null;
    connect();
  }

  function stop() {
    closedByUs = true;
    clearInterval(keepalive);
    try { ws?.close(); } catch {}
  }

  connect();
  return { refresh, stop, stats };
}
