// Contract addresses on Arbitrum One (chain 42161)
export const CHAIN_ID = 42161n;

export const ADDR = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  // Uniswap V3 QuoterV2 (official Uniswap docs, Arbitrum deployments)
  uniQuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  // Camelot V3 (Algebra) Quoter
  camelotV3Quoter: '0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E',
  // Camelot V2 (AMM) router, used only for getAmountsOut quotes
  camelotV2Router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
  // Uniswap V4 Quoter (official Uniswap v4 deployments page, Arbitrum One)
  uniV4Quoter: '0x8928074CA1b241D8Ec02815881c1Af11E8bC5219',
};

// Established tokens that discovery should never treat as "new / trending"
// (everything in TOKENS below is excluded too). Add more with EXCLUDE_TOKENS env (comma-separated).
export const EXCLUDE_TOKENS = [
  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
  '0x5979D7b546E38E414F7E9822514be443A4800529', // wstETH
  '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', // weETH
  '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', // rETH
  '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F', // FRAX
  '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', // UNI
  '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978', // CRV
  '0x3082CC23568eA640225c2467653dB90e9250AaA0', // RDNT
  '0x6694340fc020c5E6B96567843da2df01b2CE1eb6', // STG
  '0x18c11FD286C5EC11c3b683Caa813B77f5163A122', // GNS
  '0xd4d42F0b6DEF4CE0383636770eF773390d85c61A', // SUSHI
  '0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60', // LDO
  '0x6C2C06790b3E3E3c38e12Ee22F8183b37a13EE55', // DPX
  '0x4e352cF164E64ADCBad318C3a1e222E9EBa4Ce42', // MCB
  ...(process.env.EXCLUDE_TOKENS ? process.env.EXCLUDE_TOKENS.split(',').map((s) => s.trim()) : []),
].filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));

export const TOKENS = {
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native USDC
  'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // bridged USDC
  USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  GMX: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
  LINK: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
  PENDLE: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
  GRAIL: '0x3d9907F9a368ad0a51Be60f7Da3b97cf940982D8',
  MAGIC: '0x539bdE0d7Dbd336b79148AA742883198BBF60342',
};

// Quote tokens must be a stablecoin or WETH so profit can be valued in USD.
export const STABLES = new Set(['USDC', 'USDC.e', 'USDT']);

export const UNI_FEE_TIERS = [100, 500, 3000, 10000];

// Only used when MODE=static. Default mode is "trending" (auto-discovered tokens).
// Each pair: buy BASE with QUOTE on one DEX, sell BASE back for QUOTE on the other.
// sizes are trade sizes in QUOTE token units. Override with PAIRS_JSON (same shape).
export const DEFAULT_PAIRS = [
  { base: 'WETH', quote: 'USDC', sizes: [1000, 5000, 20000] },
  { base: 'ARB', quote: 'USDC', sizes: [500, 2000, 10000] },
  { base: 'USDT', quote: 'USDC', sizes: [1000, 10000, 50000] },
  { base: 'WBTC', quote: 'WETH', sizes: [0.5, 2, 5] },
  { base: 'ARB', quote: 'WETH', sizes: [0.25, 1, 4] },
  { base: 'GMX', quote: 'WETH', sizes: [0.25, 1, 3] },
  { base: 'LINK', quote: 'WETH', sizes: [0.25, 1, 3] },
  { base: 'PENDLE', quote: 'WETH', sizes: [0.25, 1, 3] },
  { base: 'GRAIL', quote: 'WETH', sizes: [0.1, 0.5, 2] },
  { base: 'MAGIC', quote: 'WETH', sizes: [0.1, 0.5, 2] },
];
