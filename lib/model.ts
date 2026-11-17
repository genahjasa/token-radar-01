// The token radar's model, version radar-2: one snapshot of the protocol universe in, one ranked
// board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// rankable pre-token protocol below the floor: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value follows only from the snapshot's own figures, and from no hardcoded list of names:
//
//   comps    = the median market-cap / TVL of the live-token protocols in the same category
//              (categories with fewer than 3 live tokens use the global median instead),
//              winsorised to [0.02, 1.00] so one outlier cannot set the price
//   base     = tvl_usd x comps
//   growth   = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied  = max(1, round(base x growthMult x maturity))
//
// The multiple is what the market already pays for a token in this category: a DEX's token trades at
// a different fraction of TVL than a lender's, and the snapshot's own live tokens say what those
// fractions are. A flat multiple would price every category alike; the comps multiple does not.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  comps_min_n: number;
  comps_floor: number;
  comps_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  comps_min_n: 3,
  comps_floor: 0.02,
  comps_cap: 1.0,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's comparables: the multiple the board uses for it, and how it was derived. */
export interface CompsEntry {
  category: string;
  multiple: number;
  n: number;
  fallback: boolean;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    comps_multiple: number;
    comps_n: number;
    comps_fallback: boolean;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  comps_multiple: number;
  comps_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the comparables and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_comps_multiple: number;
  watchlist: string[];
  comps: CompsEntry[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted list of numbers; NaN when empty. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The comparables table: for every category that holds a live-token protocol, the median
 * market-cap / TVL of its live tokens, winsorised to the model's band. A category with fewer
 * than `comps_min_n` live tokens borrows the global median and is marked as a fallback, so the
 * dashboard can say so instead of pretending the number is that category's own.
 */
export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; table: CompsEntry[] } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list) list.push(ratio);
    else byCategory.set(key, [ratio]);
  }
  const clamp = (v: number): number => Math.min(model.comps_cap, Math.max(model.comps_floor, v));
  const global = clamp(median(all.sort((a, b) => a - b)));
  const table: CompsEntry[] = [];
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length >= model.comps_min_n) {
      table.push({ category, multiple: clamp(median(ratios.sort((a, b) => a - b))), n: ratios.length, fallback: false });
    } else {
      table.push({ category, multiple: global, n: ratios.length, fallback: true });
    }
  }
  return { global, table };
}

/** The multiple one protocol's category gets, from the comparables table. */
export function compsFor(category: string | null, comps: { global: number; table: CompsEntry[] }): { multiple: number; n: number; fallback: boolean } {
  const key = category ?? 'Other';
  const entry = comps.table.find((c) => c.category === key);
  if (entry) return { multiple: entry.multiple, n: entry.n, fallback: entry.fallback };
  return { multiple: comps.global, n: 0, fallback: true };
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: { global: number; table: CompsEntry[] },
  model: ModelConstants,
): { implied: number; compsMultiple: number; compsN: number; compsFallback: boolean; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const { multiple, n, fallback } = compsFor(protocol.category, comps);
  const base = protocol.tvl_usd * multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, compsMultiple: multiple, compsN: n, compsFallback: fallback, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = buildComps(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, even one the snapshot no longer carries (it cannot, but the
  // board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, by TVL. Never a
  // replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, comps, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      comps_multiple: s.compsMultiple,
      comps_n: s.compsN,
      comps_fallback: s.compsFallback,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC as margin for the basis trade on ${name} and hold the hedged position.`;
  if (c.includes('chain') && !c.includes('cross')) return `Bridge $${capital} of USDC to ${name}'s chain and use it in one of the chain's own apps.`;
  if (c.includes('cede') || c.includes('governance')) return `Deposit $${capital} of USDC into ${name} on ${chain} and take part in one vote.`;
  if (c.includes('payment')) return `Pay $${capital} through ${name} on ${chain} and keep the receipt.`;
  if (c.includes('launchpad')) return `Commit $${capital} of USDC to one launch on ${name} and hold the allocation.`;
  if (c.includes('option')) return `Deposit $${capital} of USDC as collateral for one option position on ${name}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    comps_multiple: row.model.comps_multiple,
    comps_n: row.model.comps_n,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comps = buildComps(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_comps_multiple: comps.global,
    watchlist: snapshot.watchlist,
    comps: comps.table,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/*
 * Diagnostics: a second, independent look at the finished board, printed by main.ts after the
 * files are written. None of this feeds board.json or data.js, so the summary can grow without
 * moving a single ranked row: it describes the board's shape, how wide each row's value band is
 * when the live-token ratios spread, and whether anything in it fails a fresh validation.
 */

/** One quartile of a sorted list, interpolated between neighbours. */
export function quartile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** The live-token market-cap / TVL ratios, sorted ascending, per category and overall. */
export function categoryRatioLists(snapshot: Snapshot): { byCategory: Map<string, number[]>; all: number[] } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list) list.push(ratio);
    else byCategory.set(key, [ratio]);
  }
  const byAscending = (a: number, b: number): number => a - b;
  for (const list of byCategory.values()) list.sort(byAscending);
  all.sort(byAscending);
  return { byCategory, all };
}

/** The value band one row carries: its implied value stretched by its category's ratio quartiles. */
export function confidenceBand(
  implied: number,
  ratios: number[],
  globalRatios: number[],
): { low: number; high: number; widthRatio: number } {
  const use = ratios.length >= 3 ? ratios : globalRatios;
  const med = median(use);
  if (!Number.isFinite(med) || med <= 0 || use.length === 0) return { low: implied, high: implied, widthRatio: 1 };
  const low = Math.max(1, Math.round(implied * (quartile(use, 0.25) / med)));
  const high = Math.max(low, Math.round(implied * (quartile(use, 0.75) / med)));
  return { low, high, widthRatio: high / low };
}

/** The value bands the board's rows fall into, from the top down. */
export const VALUE_BANDS = [
  { label: 'over $100M', min: 100_000_000 },
  { label: '$10M–$100M', min: 10_000_000 },
  { label: '$1M–$10M', min: 1_000_000 },
  { label: 'under $1M', min: 0 },
];

/** Everything the run's printed summary says about the finished board. */
export interface BoardDiagnostics {
  rows: number;
  watchlistRows: number;
  earlyRows: number;
  categories: number;
  fallbackRows: number;
  impliedTotal: number;
  impliedMedian: number;
  impliedMin: number;
  impliedMax: number;
  medianBandWidth: number;
  widestBandSlug: string;
  widestBandWidth: number;
  bands: { label: string; count: number }[];
  findings: string[];
}

/** The finished board's shape, value spread, confidence bands and a fresh validation pass. */
export function boardDiagnostics(board: BoardRow[], snapshot: Snapshot): BoardDiagnostics {
  const ratios = categoryRatioLists(snapshot);
  // Bands use the same winsorised ratios the model prices with, so a band never describes a
  // multiple the model itself refuses to pay.
  const clampRatio = (v: number): number => Math.min(MODEL.comps_cap, Math.max(MODEL.comps_floor, v));
  const bandRatios = new Map<string, number[]>();
  for (const [category, list] of ratios.byCategory) bandRatios.set(category, list.map(clampRatio));
  const bandGlobal = ratios.all.map(clampRatio);
  const comps = buildComps(snapshot);
  const impliedSorted = board.map((r) => r.implied_value_usd).sort((a, b) => a - b);
  const widths: number[] = [];
  let widestBandSlug = '';
  let widestBandWidth = 1;
  let fallbackRows = 0;
  for (const row of board) {
    const entry = comps.table.find((c) => c.category === (row.category ?? 'Other'));
    if (entry?.fallback) fallbackRows += 1;
    const list = bandRatios.get(row.category ?? 'Other') ?? [];
    const band = confidenceBand(row.implied_value_usd, list, bandGlobal);
    widths.push(band.widthRatio);
    if (band.widthRatio > widestBandWidth) {
      widestBandWidth = band.widthRatio;
      widestBandSlug = row.slug;
    }
  }
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const row of board) {
    if (seen.has(row.slug)) findings.push(`${row.slug} appears twice on the board`);
    seen.add(row.slug);
  }
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) findings.push(`rank ${i + 1} is ${board[i]!.rank}`);
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      findings.push(`row ${i + 1} outranks row ${i} on implied value`);
    }
    if (!Number.isSafeInteger(board[i]!.implied_value_usd) || board[i]!.implied_value_usd <= 0) {
      findings.push(`${board[i]!.slug} has implied value ${board[i]!.implied_value_usd}`);
    }
    if (board[i]!.farm_steps.length < 3 || board[i]!.farm_steps.length > 12) {
      findings.push(`${board[i]!.slug} has ${board[i]!.farm_steps.length} farm steps`);
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) findings.push(`the board misses watchlist slug ${slug}`);
  }
  return {
    rows: board.length,
    watchlistRows: board.filter((r) => snapshot.watchlist.includes(r.slug)).length,
    earlyRows: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    categories: new Set(board.map((r) => r.category ?? 'Other')).size,
    fallbackRows,
    impliedTotal: impliedSorted.reduce((sum, v) => sum + v, 0),
    impliedMedian: median(impliedSorted),
    impliedMin: impliedSorted[0] ?? 0,
    impliedMax: impliedSorted[impliedSorted.length - 1] ?? 0,
    medianBandWidth: median(widths.sort((a, b) => a - b)),
    widestBandSlug,
    widestBandWidth,
    bands: VALUE_BANDS.map((band, i) => ({
      label: band.label,
      count: board.filter((r) => r.implied_value_usd >= band.min && (i === 0 || r.implied_value_usd < VALUE_BANDS[i - 1]!.min)).length,
    })),
    findings,
  };
}

/** The diagnostics as the run prints them: one line per fact, money in whole dollars. */
export function diagnosticsText(d: BoardDiagnostics): string {
  const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
  const lines = [
    `token radar diagnostics: ${d.rows} rows (${d.watchlistRows} watchlist, ${d.earlyRows} early) across ${d.categories} categories`,
    `token radar diagnostics: implied value ${money(d.impliedMin)} to ${money(d.impliedMax)}, median ${money(d.impliedMedian)}, total ${money(d.impliedTotal)}`,
    `token radar diagnostics: confidence bands from live-token quartiles: median width ${d.medianBandWidth.toFixed(2)}x, widest ${d.widestBandWidth.toFixed(2)}x (${d.widestBandSlug})`,
    `token radar diagnostics: value bands: ${d.bands.map((b) => `${b.count} ${b.label}`).join(' · ')}`,
    `token radar diagnostics: ${d.fallbackRows} rows priced on the global median fallback`,
    `token radar diagnostics: ${d.findings.length} finding${d.findings.length === 1 ? '' : 's'}${d.findings.length > 0 ? `: ${d.findings.slice(0, 3).join('; ')}` : ''}`,
  ];
  return `${lines.join('\n')}\n`;
}
