// Pump Paper Sprint Bot — early-launch scalper for the pump.fun replay sprint.
//
// Lesson from grading the first version on the kit's dev window: chasing a
// coin after it has already risen 15% and then waiting for +50% loses money
// — most such coins dump, and the -35% stop is too deep. This version buys
// near the open instead and exits fast and tight.
//
// Entry, per coin, from its CreateEvent:
//   - buy only while it is young (at most 20 slots after creation);
//   - at least 1 trade and at most 5 distinct non-creator buyers so far
//     (a launch already swarmed by many wallets is usually a dump in
//     waiting), and the creator must not have sold;
//   - real reserves of at least 1 SOL (the per-order cap is 1% of real
//     reserves, so below 1 SOL a buy cannot reach the 0.01 SOL round-trip
//     floor), and the price within -5%..+10% of its opening price —
//     near the open, not after a run-up.
// Exit: sell the whole position at +15% (take profit) or -12% (stop loss),
// or after 1000 slots if it is still below its buy cost (stale). A coin
// bought and sold is never bought twice — the guardrail counts distinct
// coins, so turnover across new coins earns the 20-coin minimum. A buy the
// market rejects or that fails does not burn the coin: the mint is released
// so a later batch can try again while it is still young.
//
// Fully deterministic: every decision comes from the harness state (slot,
// reserves, fills, account, and the events' own fields). No clock, no
// environment, no Math.random.

import { runBot, type Batch, type BotState, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const BUY_LAMPORTS = 20_000_000n; // 0.02 SOL per coin
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL — the guardrail round-trip floor
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // 1 SOL of real reserves
const MAX_AGE_SLOTS = 20;
const MAX_BUYERS = 5;
const RUNUP_LOW_NUM = 95n; // price >= 95% of opening price
const RUNUP_HIGH_NUM = 110n; // price <= 110% of opening price
const RUNUP_DEN = 100n;
const TAKE_PROFIT_NUM = 110n; // mark value >= 110% of cost
const STOP_LOSS_NUM = 90n; // mark value <= 90% of cost
const STALE_SLOTS = 500;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 1000;

interface CoinInfo {
  createSlot: number;
  creator: string;
  openQuote: bigint;
  openToken: bigint;
  trades: number;
  buyers: Set<string>;
  creatorSold: boolean;
}

interface BoughtPosition {
  costLamports: bigint;
  buySlot: number;
}

const coins = new Map<string, CoinInfo>();
const boughtMints = new Set<string>();
const boughtPositions = new Map<string, BoughtPosition>();

function markValueLamports(tokenAmount: bigint, curveQuote: bigint, curveToken: bigint): bigint {
  if (curveToken === 0n) return 0n;
  return (tokenAmount * curveQuote) / curveToken;
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const orders: Array<BuyInput | SellInput> = [];
    const txFee = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // A buy that was rejected or failed never filled, so release the mint.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status !== 'filled') boughtMints.delete(fill.mint);
    }

    // Learn from this batch's events first: creates, trades, creator sells.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        if (!coins.has(event.mint)) {
          coins.set(event.mint, {
            createSlot: event.slot,
            creator: event.creator,
            openQuote: BigInt(event.virtual_quote_reserves),
            openToken: BigInt(event.virtual_token_reserves),
            trades: 0,
            buyers: new Set<string>(),
            creatorSold: false,
          });
        }
      } else if (event.event === 'TradeEvent') {
        const info = coins.get(event.mint);
        if (info === undefined) continue;
        info.trades += 1;
        if (event.is_buy) {
          if (event.user !== info.creator) info.buyers.add(event.user);
        } else if (event.user === info.creator) {
          info.creatorSold = true;
        }
      } else {
        const info = coins.get(event.mint);
        if (info !== undefined) boughtMints.add(event.mint);
      }
    }

    // Record positions the first time the account reports them. (A Holding
    // carries no mint of its own — the mint is the map key.)
    for (const [mint, position] of state.positions) {
      if (!boughtPositions.has(mint)) {
        boughtPositions.set(mint, {
          costLamports: position.cost_lamports,
          buySlot: batch.slot,
        });
      }
    }

    // Sells first: free a slot before deciding on new buys.
    const pendingSells = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'sell') pendingSells.add(pending.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const info = boughtPositions.get(mint);
      if (info === undefined) continue;
      if (holding.token_amount === 0n) continue;
      const value = markValueLamports(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const takeProfit = value * 100n >= info.costLamports * TAKE_PROFIT_NUM;
      const stopLoss = value * 100n <= info.costLamports * STOP_LOSS_NUM;
      const stale = batch.slot - info.buySlot >= STALE_SLOTS && value < info.costLamports;
      if (takeProfit || stopLoss || stale) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        slots += 1;
      }
    }

    // Buys: one pass over this batch's events, each mint at most once.
    const seen = new Set<string>();
    for (const event of batch.events) {
      const mint = event.mint;
      if (seen.has(mint)) continue;
      seen.add(mint);
      if (boughtMints.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      const info = coins.get(mint);
      if (info === undefined) continue;
      if (batch.slot - info.createSlot > MAX_AGE_SLOTS) continue;
      if (info.trades < 1) continue;
      if (info.buyers.size > MAX_BUYERS) continue;
      if (info.creatorSold) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      if (info.openToken === 0n || curve.virtual_token_reserves === 0n) continue;
      // Price within -5%..+10% of the opening price, cross-multiplied.
      const lowOk = curve.virtual_quote_reserves * info.openToken * RUNUP_DEN >= info.openQuote * curve.virtual_token_reserves * RUNUP_LOW_NUM;
      const highOk = curve.virtual_quote_reserves * info.openToken * RUNUP_DEN <= info.openQuote * curve.virtual_token_reserves * RUNUP_HIGH_NUM;
      if (!lowOk || !highOk) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < BUY_LAMPORTS ? cap : BUY_LAMPORTS;
      if (slots <= 0) continue;
      if (free < amount + txFee) continue;
      if (orders.length >= state.hello.caps.max_orders_per_batch) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      boughtMints.add(mint);
      free -= amount + txFee;
      slots -= 1;
    }
    return orders;
  },
});
