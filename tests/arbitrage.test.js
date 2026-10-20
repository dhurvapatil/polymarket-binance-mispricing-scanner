import { jest } from '@jest/globals';
import { ArbitrageService } from '../src/services/arbitrage.js';
import { impliedProbability, daysToYears } from '../src/services/blackscholes.js';

const mkService = (binance = {}, telegram = null, options) =>
  new ArbitrageService({}, binance, telegram, options);

describe('computeEdge (fee model and net edge)', () => {
  const svc = mkService();

  test('net = |delta| * size - size * (2.5% + 0.04% + 0.1%)', () => {
    const e = svc.computeEdge(0.60, 0.50);
    expect(e.probDelta).toBeCloseTo(0.10, 12);
    expect(e.grossProfit).toBeCloseTo(100, 8);
    expect(e.totalFees).toBeCloseTo(26.4, 8);
    expect(e.netProfit).toBeCloseTo(73.6, 8);
    expect(e.profitMargin).toBeCloseTo(0.0736, 10);
  });

  test('symmetric in sign of the gap, delta keeps its sign', () => {
    const over = svc.computeEdge(0.60, 0.50);
    const under = svc.computeEdge(0.40, 0.50);
    expect(under.probDelta).toBeLessThan(0);
    expect(under.netProfit).toBeCloseTo(over.netProfit, 8);
  });

  test('break-even gap is exactly the total fee rate (2.64 pp)', () => {
    expect(svc.computeEdge(0.5264, 0.5).netProfit).toBeCloseTo(0, 8);
  });

  test('gaps smaller than fees give negative net edge', () => {
    expect(svc.computeEdge(0.52, 0.50).profitMargin).toBeLessThan(0);
  });

  test('scales linearly with position size but margin does not', () => {
    const a = svc.computeEdge(0.6, 0.5, 1000);
    const b = svc.computeEdge(0.6, 0.5, 5000);
    expect(b.netProfit).toBeCloseTo(a.netProfit * 5, 8);
    expect(b.profitMargin).toBeCloseTo(a.profitMargin, 12);
  });
});

describe('threshold filtering', () => {
  const opp = (id, margin) => ({ market: { id }, arbitrage: { profitMargin: margin }, confidence: 'low' });

  test('keeps only opportunities >= threshold, sorted by margin descending', async () => {
    const out = await mkService().filterOpportunities(
      [opp('a', 0.004), opp('b', 0.02), opp('c', 0.005), opp('d', 0.05)]
    );
    expect(out.map(o => o.market.id)).toEqual(['d', 'b', 'c']);
  });

  test('explicit threshold argument overrides the default', async () => {
    const out = await mkService().filterOpportunities([opp('a', 0.01), opp('b', 0.03)], 0.02);
    expect(out.map(o => o.market.id)).toEqual(['b']);
  });

  test('constructor option sets the default threshold', async () => {
    const svc = mkService({}, null, { minProfitThreshold: 0.02 });
    const out = await svc.filterOpportunities([opp('a', 0.01), opp('b', 0.03)]);
    expect(out.map(o => o.market.id)).toEqual(['b']);
  });

  test('sends one Telegram alert per surviving opportunity and survives failures', async () => {
    const telegram = { sendArbitrageAlert: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(true) };
    const out = await mkService({}, telegram).filterOpportunities([opp('a', 0.03), opp('b', 0.02), opp('c', 0.001)]);
    expect(out).toHaveLength(2);
    expect(telegram.sendArbitrageAlert).toHaveBeenCalledTimes(2);
  });

  test('getStatistics aggregates margins and confidence', () => {
    const stats = mkService().getStatistics([
      { arbitrage: { profitMargin: 0.01 }, confidence: 'high' },
      { arbitrage: { profitMargin: 0.03 }, confidence: 'low' },
    ]);
    expect(stats.total).toBe(2);
    expect(stats.averageProfit).toBeCloseTo(0.02, 12);
    expect(stats.highConfidence).toBe(1);
    expect(stats.maxProfit).toBe(0.03);
    expect(mkService().getStatistics([]).total).toBe(0);
  });
});

describe('extractStrikePrice', () => {
  const svc = mkService();
  test.each([
    ['Will Bitcoin reach $120,000 by December 31?', 120000],
    ['Will BTC be above $95000 on June 30?', 95000],
    ['Will BTC hit $120k this year?', 120000],
    ['Will BTC hit $120K this year?', 120000],
    ['Will ETH be above $4.5k on Friday?', 4500],
    ['Will BTC reach $1.2m by 2030?', 1200000],
    ['Will BTC be above $2,500.50 at noon?', 2500.5],
    ['Will BTC be above $100,000, or not?', 100000],
  ])('%s -> %p', (q, expected) => {
    expect(svc.extractStrikePrice(q)).toBeCloseTo(expected, 6);
  });

  test('regression: a word starting with m/k after the number is not a multiplier', () => {
    expect(svc.extractStrikePrice('Will BTC be above $120,000 mid-June?')).toBe(120000);
    expect(svc.extractStrikePrice('Will BTC close above $90,000 monthly?')).toBe(90000);
  });

  test('returns null when there is no dollar amount', () => {
    expect(svc.extractStrikePrice('Will Bitcoin go up?')).toBeNull();
    expect(svc.extractStrikePrice('')).toBeNull();
    expect(svc.extractStrikePrice(undefined)).toBeNull();
  });
});

describe('market parsing helpers', () => {
  const svc = mkService();

  test('extractCryptoSymbol maps names and tickers, null otherwise', () => {
    expect(svc.extractCryptoSymbol({ question: 'Will Bitcoin hit $100k?' })).toBe('BTC');
    expect(svc.extractCryptoSymbol({ question: 'Will ETH be above $5k?' })).toBe('ETH');
    expect(svc.extractCryptoSymbol({ question: 'Will Solana reach $300?' })).toBe('SOL');
    expect(svc.extractCryptoSymbol({ question: 'Will the Fed cut rates?' })).toBeNull();
  });

  test('determineMarketDirection: bullish, bearish, ambiguous', () => {
    expect(svc.determineMarketDirection({ question: 'Will BTC be above $100k?' })).toBe('bullish');
    expect(svc.determineMarketDirection({ question: 'Will BTC fall below $60k?' })).toBe('bearish');
    expect(svc.determineMarketDirection({ question: 'Will BTC be above $100k or below $60k?' })).toBeNull();
    expect(svc.determineMarketDirection({ question: 'Will BTC moon?' })).toBeNull();
  });

  test('isBinaryMarket requires exactly Yes/No', () => {
    expect(svc.isBinaryMarket({ outcomes: ['Yes', 'No'] })).toBe(true);
    expect(svc.isBinaryMarket({ outcomes: ['Up', 'Down'] })).toBe(false);
    expect(svc.isBinaryMarket({ outcomes: ['Yes', 'No', 'Maybe'] })).toBe(false);
    expect(svc.isBinaryMarket({})).toBeFalsy();
  });

  test('calculateConfidence tiers by gap size and requires options data', () => {
    expect(svc.calculateConfidence(0.06, {})).toBe('high');
    expect(svc.calculateConfidence(-0.03, {})).toBe('medium');
    expect(svc.calculateConfidence(0.01, {})).toBe('low');
    expect(svc.calculateConfidence(0.5, null)).toBe('low');
  });
});

describe('calculateArbitrage (end to end, mocked options feed)', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  const EXPIRY = new Date('2026-07-01T00:00:00Z');
  const fut = { symbol: 'BTCUSDT', price: 100000, timestamp: 1 };
  const optionsData = { symbol: 'BTC-260701-120000-C', strike: 120000, expiry: EXPIRY, impliedVolatility: 0.6, markPrice: 1000 };
  const market = (over = {}) => ({
    id: 'm1', question: 'Will BTC be above $120,000 on June 30?', probability: 0.5,
    outcomes: ['Yes', 'No'], expiresAt: EXPIRY, ...over,
  });
  const svcWith = (opt = optionsData) => mkService({ fetchOptionsData: jest.fn().mockResolvedValue(opt) });

  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
  afterEach(() => jest.useRealTimers());

  const expectedProb = () => impliedProbability(100000, 120000, daysToYears(EXPIRY), 0.05, 0.6);

  test('bullish market: model prob is N(d2); big gap yields SELL_POLYMARKET_YES', async () => {
    const o = await svcWith().calculateArbitrage(market({ probability: 0.5 }), fut, 'BTC');
    expect(o.arbitrage.bsProb).toBeCloseTo(expectedProb(), 12);
    expect(o.arbitrage.bsProb).toBeGreaterThan(0.1);
    expect(o.arbitrage.bsProb).toBeLessThan(0.4);
    expect(o.recommendation).toBe('SELL_POLYMARKET_YES');
    expect(o.arbitrage.netProfit).toBeCloseTo(o.arbitrage.grossProfit - o.arbitrage.totalFees, 10);
  });

  test('bearish market uses the complement 1 - N(d2)', async () => {
    const o = await svcWith().calculateArbitrage(
      market({ question: 'Will BTC fall below $120,000 on June 30?', probability: 0.3 }), fut, 'BTC');
    expect(o.market.direction).toBe('bearish');
    expect(o.arbitrage.bsProb).toBeCloseTo(1 - expectedProb(), 12);
    expect(o.recommendation).toBe('BUY_POLYMARKET_YES');
  });

  test('returns null when the gap does not clear fees + threshold', async () => {
    const p = expectedProb();
    const o = await svcWith().calculateArbitrage(market({ probability: p + 0.03 }), fut, 'BTC');
    expect(o).toBeNull(); // 3pp gap < 2.64pp fees + 0.5pp threshold
  });

  test('returns null with no options data, no strike, no direction, no expiry or no price', async () => {
    expect(await svcWith(null).calculateArbitrage(market(), fut, 'BTC')).toBeNull();
    expect(await svcWith().calculateArbitrage(market({ question: 'Will BTC be above the moon?' }), fut, 'BTC')).toBeNull();
    expect(await svcWith().calculateArbitrage(market({ question: 'Will BTC do $120,000?' }), fut, 'BTC')).toBeNull();
    expect(await svcWith().calculateArbitrage(market({ expiresAt: null }), fut, 'BTC')).toBeNull();
    expect(await svcWith().calculateArbitrage(market({ probability: null }), fut, 'BTC')).toBeNull();
  });

  test('swallows options-feed errors and skips the market', async () => {
    const svc = mkService({ fetchOptionsData: jest.fn().mockRejectedValue(new Error('network')) });
    expect(await svc.calculateArbitrage(market(), fut, 'BTC')).toBeNull();
  });

  test('matchMarkets skips non-binary / unknown-symbol markets and returns the rest', async () => {
    const svc = svcWith();
    const out = await svc.matchMarkets(
      [market(), market({ id: 'x', outcomes: ['A', 'B'] }), market({ id: 'y', question: 'Will the Fed cut above $5?' })],
      [fut]
    );
    expect(out.map(o => o.market.id)).toEqual(['m1']);
  });
});
