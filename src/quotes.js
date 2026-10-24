// Builds and decodes quote calls for every supported pool type, batched through Multicall3.
import { Interface, AbiCoder, Contract, ZeroAddress } from 'ethers';
import { ADDR, DEXES, UNI_FEE_TIERS, TOKENS } from './config.js';

const coder = AbiCoder.defaultAbiCoder();

const v3Quoter = new Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const algebraQuoter = new Interface([
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint160 limitSqrtPrice) returns (uint256 amountOut,uint16 fee)',
]);
const v2Router = new Interface([
  'function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)',
]);
const v4Quoter = new Interface([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);
const erc20 = new Interface(['function decimals() view returns (uint8)']);
const v3Pool = new Interface(['function fee() view returns (uint24)']);

const MULTICALL_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
];
const MAX_U128 = (1n << 128n) - 1n;

// amountOut is always the first return word, so reading only that keeps
// decoding robust to small differences in quoter return shapes.
export function firstWord(data) {
  if (!data || data.length < 66) return 0n;
  return BigInt('0x' + data.slice(2, 66));
}
const lastOfArray = (data) => {
  const [amounts] = coder.decode(['uint256[]'], data);
  return amounts.length ? amounts[amounts.length - 1] : 0n;
};

// One quote call for one specific pool ("venue").
// venue: { dex: key of DEXES, fee?: number, v4Key?: PoolKey }
export function venueCall(venue, tokenIn, tokenOut, amountIn) {
  const d = DEXES[venue.dex];
  switch (d.kind) {
    case 'v3':
      return {
        target: d.quoter,
        callData: v3Quoter.encodeFunctionData('quoteExactInputSingle', [
          { tokenIn, tokenOut, amountIn, fee: venue.fee, sqrtPriceLimitX96: 0n },
        ]),
        decode: firstWord,
      };
    case 'algebra':
      return {
        target: d.quoter,
        callData: algebraQuoter.encodeFunctionData('quoteExactInputSingle', [tokenIn, tokenOut, amountIn, 0n]),
        decode: firstWord,
      };
    case 'v2':
      return {
        target: d.router,
        callData: v2Router.encodeFunctionData('getAmountsOut', [amountIn, [tokenIn, tokenOut]]),
        decode: lastOfArray,
      };
    case 'v4': {
      if (amountIn > MAX_U128) return null;
      const key = venue.v4Key;
      const c0 = key.currency0.toLowerCase();
      const inAddr = tokenIn.toLowerCase();
      // native-ETH v4 pools use the zero address; WETH is treated as ETH 1:1
      const zeroForOne = c0 === inAddr || (c0 === ZeroAddress && inAddr === TOKENS.WETH.toLowerCase());
      return {
        target: ADDR.uniV4Quoter,
        callData: v4Quoter.encodeFunctionData('quoteExactInputSingle', [
          { poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' },
        ]),
        decode: firstWord,
      };
    }
    default:
      return null;
  }
}

export function venueName(venue) {
  const fee = venue.fee != null ? `-${venue.fee / 10000}%` : venue.v4Key ? `-${venue.v4Key.fee / 10000}%` : '';
  return `${venue.dex}${fee}`;
}

// Generic routing between deep tokens (prices, converting quote tokens back):
// every Uniswap V3 tier plus Camelot V3. Returns [{ venue, target, callData, decode }]
export function buildQuoteCalls(tokenIn, tokenOut, amountIn) {
  const venues = [
    ...UNI_FEE_TIERS.map((fee) => ({ dex: 'uniswap-v3', fee })),
    { dex: 'camelot-v3' },
  ];
  return venues.map((v) => ({ venue: venueName(v), ...venueCall(v, tokenIn, tokenOut, amountIn) }));
}

// Startup self-check: every DEX quoting WETH -> USDC
export function dexCheckCalls(amountIn) {
  const out = [];
  for (const [dex, d] of Object.entries(DEXES)) {
    if (d.kind === 'v4') continue;
    const tiers = d.kind === 'v3' ? d.fees : [null];
    for (const fee of tiers) {
      const v = { dex, fee: fee ?? undefined };
      out.push({ dex, venue: venueName(v), ...venueCall(v, TOKENS.WETH, TOKENS.USDC, amountIn) });
    }
  }
  return out;
}

export const poolFeeCall = (pool) => ({ target: pool, callData: v3Pool.encodeFunctionData('fee'), decode: firstWord });

export class Batcher {
  constructor(provider, chunkSize) {
    this.mc = new Contract(ADDR.multicall3, MULTICALL_ABI, provider);
    this.chunkSize = chunkSize;
    this.rpcRequests = 0;
  }

  // calls: [{ target, callData, decode }] -> array of bigint|null (null = failed / no pool)
  // keepZero: return 0 results instead of treating them as failures (for fee() reads)
  async run(calls, blockTag, { keepZero = false } = {}) {
    const out = new Array(calls.length).fill(null);
    const chunks = [];
    for (let i = 0; i < calls.length; i += this.chunkSize) chunks.push(i);
    await Promise.all(
      chunks.map(async (start) => {
        const slice = calls.slice(start, start + this.chunkSize);
        this.rpcRequests++;
        const res = await this.mc.aggregate3.staticCall(
          slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })),
          { blockTag }
        );
        res.forEach((r, j) => {
          if (!r.success) return;
          try {
            const v = slice[j].decode(r.returnData);
            if (v > 0n || (keepZero && r.returnData.length >= 66)) out[start + j] = v;
          } catch {
            /* undecodable -> treat as no quote */
          }
        });
      })
    );
    return out;
  }

  async decimals(addresses) {
    const res = await this.run(
      addresses.map((a) => ({ target: a, callData: erc20.encodeFunctionData('decimals'), decode: firstWord })),
      'latest'
    );
    return res.map((d, i) => {
      if (d === null) throw new Error(`Could not read decimals() for ${addresses[i]}`);
      return Number(d);
    });
  }
}
