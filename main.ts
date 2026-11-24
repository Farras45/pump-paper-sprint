// Pump Paper Sprint — a paper bot that scalps brand-new pump.fun curves.
//
// The whole idea is to get in while a launch is still fresh and get out
// before it can hurt us. Coins that have already pumped tend to dump, and
// holding a loser while hoping it comes back is how a paper account bleeds
// out. So this bot only ever buys a coin in its first few slots, only when
// it still trades close to where it opened, and it cuts every position at
// a tight band: up ten percent and we bank it, down ten percent and we are
// gone, and if it just sits there below what we paid for five hundred
// slots we walk away too.
//
// What a launch has to look like before we touch it:
//   - no more than twenty slots old, counted from its CreateEvent;
//   - between one and five different wallets (not counting the creator)
//     have bought it so far — a crowd of buyers this early usually means
//     the dump is already being set up — and the creator has not sold any;
//   - at least one SOL of real reserves sits behind it, because the
//     per-order size cap is one percent of real reserves and anything
//     smaller cannot clear the 0.01 SOL round-trip minimum;
//   - its price still sits between five percent below and ten percent
//     above the price it opened at, so we are buying the open, not the
//     run-up.
// Once we own a coin we never buy it again, even after selling it: the
// guardrail rewards distinct coins, so the twenty-coin minimum is earned
// by turning over fresh launches, not by re-entering old ones. If the
// market rejects a buy, or the transaction fails, the mint is freed again
// — a buy that never filled should not burn a coin that is still young
// enough to try again.
//
// Nothing here reads the clock, the environment, or any random source.
// Every order is a pure function of the harness state for this batch —
// slot, reserves, fills, account, and the events themselves — so replaying
// the same data always produces the same orders.

import { runBot, type Batch, type BotState, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// --- sizing and timing, all in lamports / slots / basis points -----------

const ORDER_SIZE = 20_000_000n; // 0.02 SOL into each new coin
const ROUND_TRIP_FLOOR = 10_000_000n; // 0.01 SOL, the guardrail minimum
const RESERVE_FLOOR = 1_000_000_000n; // 1 SOL of real reserves
const FRESH_WINDOW = 20; // slots after creation during which a buy is allowed
const BUYER_LIMIT = 5; // most distinct non-creator buyers we tolerate
const BAND_DENOM = 100n; // denominator for the price-band ratios below
const BAND_LOW = 95n; // price must be at least 95% of the opening price
const BAND_HIGH = 110n; // price must be at most 110% of the opening price
const PROFIT_TARGET = 110n; // sell when the mark reaches 110% of cost
const LOSS_LIMIT = 90n; // sell when the mark falls to 90% of cost
const STALE_AFTER = 500; // slots below cost before we give up on a coin
const BUY_TOLERANCE_BPS = 500;
const SELL_TOLERANCE_BPS = 1000;

// --- what we remember about each launch ---------------------------------

interface Launch {
  bornAt: number;
  maker: string;
  quoteAtOpen: bigint;
  tokensAtOpen: bigint;
  tradeCount: number;
  wallets: Set<string>;
  makerHasSold: boolean;
}

interface OpenTrade {
  basis: bigint;
  openedAt: number;
}

// One entry per mint we have ever seen created, one per mint we have
// bought, and the cost basis of every position we currently hold.
const launches = new Map<string, Launch>();
const entered = new Set<string>();
const openTrades = new Map<string, OpenTrade>();

// Value of `tokens` at the curve's current reserves, in lamports.
function valueOf(tokens: bigint, quoteReserves: bigint, tokenReserves: bigint): bigint {
  if (tokenReserves === 0n) return 0n;
  return (tokens * quoteReserves) / tokenReserves;
}

// True when the curve still trades inside the band around its open.
function stillNearOpen(curveQuote: bigint, curveTokens: bigint, launch: Launch): boolean {
  const left = curveQuote * launch.tokensAtOpen * BAND_DENOM;
  const right = launch.quoteAtOpen * curveTokens;
  return left >= right * BAND_LOW && left <= right * BAND_HIGH;
}

// A buy that never filled leaves no position behind, so forget the mint
// and let a later batch reconsider it while it is still fresh.
function releaseUnfilledBuys(batch: Batch): void {
  for (const fill of batch.fills) {
    if (fill.side === 'buy' && fill.status !== 'filled') entered.delete(fill.mint);
  }
}

// Fold this batch's events into the launch table: remember creates,
// count trades and distinct buyers, and note creator sells and mints
// that completed (a completed curve can never be bought again).
function absorbBatchEvents(batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      if (launches.has(event.mint)) continue;
      launches.set(event.mint, {
        bornAt: event.slot,
        maker: event.creator,
        quoteAtOpen: BigInt(event.virtual_quote_reserves),
        tokensAtOpen: BigInt(event.virtual_token_reserves),
        tradeCount: 0,
        wallets: new Set<string>(),
        makerHasSold: false,
      });
    } else if (event.event === 'TradeEvent') {
      const launch = launches.get(event.mint);
      if (launch === undefined) continue;
      launch.tradeCount += 1;
      if (event.is_buy) {
        if (event.user !== launch.maker) launch.wallets.add(event.user);
      } else if (event.user === launch.maker) {
        launch.makerHasSold = true;
      }
    } else {
      entered.add(event.mint);
    }
  }
}

// The first time the account shows us holding a mint, record what we
// paid and when we first saw it. Holdings carry no mint of their own —
// the mint is the key of the positions map.
function noteHoldings(state: BotState, batch: Batch): void {
  for (const [mint, holding] of state.positions) {
    if (openTrades.has(mint)) continue;
    openTrades.set(mint, { basis: holding.cost_lamports, openedAt: batch.slot });
  }
}

// The working numbers for one batch: what we can still spend, how many
// more positions we may open, and the orders we have decided on so far.
interface Desk {
  state: BotState;
  batch: Batch;
  orders: Array<BuyInput | SellInput>;
  cashLeft: bigint;
  room: number;
  fee: bigint;
}

// Exits come before entries, so a sale frees its slot for a buy in the
// same batch. A position is sold whole when it hits the profit target,
// the loss limit, or goes stale below cost.
function planExits(desk: Desk): void {
  const { state, batch } = desk;
  const alreadySelling = new Set<string>();
  for (const pending of state.pending.values()) {
    if (pending.order.side === 'sell') alreadySelling.add(pending.order.mint);
  }
  for (const [mint, holding] of state.positions) {
    if (alreadySelling.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const trade = openTrades.get(mint);
    if (trade === undefined) continue;
    if (holding.token_amount === 0n) continue;
    const worth = valueOf(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    const hitTarget = worth * 100n >= trade.basis * PROFIT_TARGET;
    const hitLimit = worth * 100n <= trade.basis * LOSS_LIMIT;
    const goneStale = batch.slot - trade.openedAt >= STALE_AFTER && worth < trade.basis;
    if (!hitTarget && !hitLimit && !goneStale) continue;
    desk.orders.push({
      side: 'sell',
      mint,
      token_amount: holding.token_amount,
      max_slippage_bps: SELL_TOLERANCE_BPS,
    });
    desk.room += 1;
  }
}

// Entries: a single sweep over this batch's events, at most one buy per
// mint. Every gate is checked in turn; a mint that fails any of them is
// simply skipped, with no side effects, so the sweep stays pure until
// the moment an order is actually placed.
function planEntries(desk: Desk): void {
  const { state, batch } = desk;
  const touched = new Set<string>();
  for (const event of batch.events) {
    const mint = event.mint;
    if (touched.has(mint)) continue;
    touched.add(mint);
    if (entered.has(mint)) continue;
    if (state.positions.has(mint)) continue;
    const launch = launches.get(mint);
    if (launch === undefined) continue;
    if (batch.slot - launch.bornAt > FRESH_WINDOW) continue;
    if (launch.tradeCount < 1) continue;
    if (launch.wallets.size > BUYER_LIMIT) continue;
    if (launch.makerHasSold) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.real_quote_reserves < RESERVE_FLOOR) continue;
    if (launch.tokensAtOpen === 0n || curve.virtual_token_reserves === 0n) continue;
    if (!stillNearOpen(curve.virtual_quote_reserves, curve.virtual_token_reserves, launch)) continue;
    const cap = state.maxBuyLamports(mint);
    if (cap < ROUND_TRIP_FLOOR) continue;
    const size = cap < ORDER_SIZE ? cap : ORDER_SIZE;
    if (desk.room <= 0) continue;
    if (desk.cashLeft < size + desk.fee) continue;
    if (desk.orders.length >= state.hello.caps.max_orders_per_batch) continue;
    desk.orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_TOLERANCE_BPS });
    entered.add(mint);
    desk.cashLeft -= size + desk.fee;
    desk.room -= 1;
  }
}

// Drop bookkeeping that can no longer change a decision, so the maps
// stay small on long replays. A launch past the fresh window with no open
// position can never be bought again — the age gate would reject it —
// and its completion can no longer matter either, since a completed curve
// is unbuyable anyway. An entered mint is dropped once its launch is gone
// or it is past the window: the age gate would reject a re-buy, and an
// open position blocks one regardless.
function sweepOldLaunches(state: BotState, batchSlot: number): void {
  for (const [mint, launch] of launches) {
    if (batchSlot - launch.bornAt > FRESH_WINDOW && !state.positions.has(mint)) {
      launches.delete(mint);
    }
  }
  for (const mint of entered) {
    const launch = launches.get(mint);
    if (launch === undefined || batchSlot - launch.bornAt > FRESH_WINDOW) {
      entered.delete(mint);
    }
  }
}

function handleBatch(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
  releaseUnfilledBuys(batch);
  absorbBatchEvents(batch);
  noteHoldings(state, batch);

  const desk: Desk = {
    state,
    batch,
    orders: [],
    cashLeft: state.freeCashLamports(),
    room: state.hello.caps.max_open_positions - state.committedPositionCount(),
    fee: state.txFeeLamports(),
  };

  planExits(desk);
  planEntries(desk);
  sweepOldLaunches(state, batch.slot);

  return desk.orders;
}

await runBot({ onBatch: handleBatch });
