// Builds and decodes quote calls for each venue, batched through Multicall3.
import { Interface, AbiCoder, Contract, ZeroAddress } from 'ethers';
import { ADDR, UNI_FEE_TIERS, TOKENS } from './config.js';

const coder = AbiCoder.defaultAbiCoder();

const uniQuoter = new Interface([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
]);
const algebraQuoter = new Interface([
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint256 amountIn,uint160 limitSqrtPrice) returns (uint256 amountOut,uint16 fee)',
]);
const camelotV2Router = new Interface([
  'function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)',
]);
const uniV4Quoter = new Interface([
  'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)',
]);
const erc20 = new Interface(['function decimals() view returns (uint8)']);

const MULTICALL_ABI = [
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
];

// Every venue variant on each DEX. The scanner picks the best variant per DEX.
// v4Keys: Uniswap v4 PoolKeys found by discovery for this token (optional).
// Returns [{ dex, venue, target, callData, decode }]
export function buildQuoteCalls(tokenIn, tokenOut, amountIn, v4Keys = []) {
  const calls = [];
  const MAX_U128 = (1n << 128n) - 1n;
  for (const key of v4Keys) {
    if (amountIn > MAX_U128) break;
    // Native-ETH v4 pools use the zero address; we account for them as WETH 1:1
    const c0 = key.currency0.toLowerCase();
    const inAddr = tokenIn.toLowerCase();
    const zeroForOne = c0 === inAddr || (c0 === ZeroAddress && inAddr === TOKENS.WETH.toLowerCase());
    calls.push({
      dex: 'uniswap',
      venue: `uniV4-${key.fee / 10000}%`,
      target: ADDR.uniV4Quoter,
      callData: uniV4Quoter.encodeFunctionData('quoteExactInputSingle', [
        { poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' },
      ]),
      decode: firstWord,
    });
  }
  for (const fee of UNI_FEE_TIERS) {
    calls.push({
      dex: 'uniswap',
      venue: `uniV3-${fee / 10000}%`,
      target: ADDR.uniQuoterV2,
      callData: uniQuoter.encodeFunctionData('quoteExactInputSingle', [
        { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
      ]),
      decode: firstWord,
    });
  }
  calls.push({
    dex: 'camelot',
    venue: 'camelotV3',
    target: ADDR.camelotV3Quoter,
    callData: algebraQuoter.encodeFunctionData('quoteExactInputSingle', [tokenIn, tokenOut, amountIn, 0n]),
    decode: firstWord,
  });
  calls.push({
    dex: 'camelot',
    venue: 'camelotV2',
    target: ADDR.camelotV2Router,
    callData: camelotV2Router.encodeFunctionData('getAmountsOut', [amountIn, [tokenIn, tokenOut]]),
    decode: (data) => {
      const [amounts] = coder.decode(['uint256[]'], data);
      return amounts.length ? amounts[amounts.length - 1] : 0n;
    },
  });
  return calls;
}

// Reading only the first 32-byte word keeps decoding robust to small
// differences in quoter return shapes (amountOut is always first).
function firstWord(data) {
  if (!data || data.length < 66) return 0n;
  return BigInt('0x' + data.slice(2, 66));
}

export class Batcher {
  constructor(provider, chunkSize) {
    this.mc = new Contract(ADDR.multicall3, MULTICALL_ABI, provider);
    this.chunkSize = chunkSize;
    this.rpcRequests = 0;
  }

  // calls: [{ target, callData, decode }] -> array of bigint|null (null = failed / no pool)
  async run(calls, blockTag) {
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
            if (v > 0n) out[start + j] = v;
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
      addresses.map((a) => ({
        target: a,
        callData: erc20.encodeFunctionData('decimals'),
        decode: firstWord,
      })),
      'latest'
    );
    return res.map((d, i) => {
      if (d === null) throw new Error(`Could not read decimals() for ${addresses[i]}`);
      return Number(d);
    });
  }
}
