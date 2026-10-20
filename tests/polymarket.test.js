import { PolymarketService } from '../src/services/polymarket.js';

const svc = new PolymarketService();
const event = { id: 'e1', title: 'Bitcoin price', description: 'desc' };

describe('parseMarketData', () => {
  test('parses JSON-string outcomes/prices as the Gamma API returns them', () => {
    const m = svc.parseMarketData({
      id: '1', question: 'Will BTC be above $100k?', outcomes: '["Yes","No"]', outcomePrices: '["0.37","0.63"]',
      volume: '1234.5', liquidity: '99', endDate: '2026-12-31T00:00:00Z', active: true, closed: false,
    }, event);
    expect(m.outcomes).toEqual(['Yes', 'No']);
    expect(m.outcomePrices).toEqual(['0.37', '0.63']);
    expect(m.volume).toBe(1234.5);
    expect(m.expiresAt.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(m.eventId).toBe('e1');
  });

  test('malformed JSON degrades to empty arrays; missing endDate -> null; question falls back to event title', () => {
    const m = svc.parseMarketData({ id: '2', outcomes: '[oops', outcomePrices: 'nope' }, event);
    expect(m.outcomes).toEqual([]);
    expect(m.outcomePrices).toEqual([]);
    expect(m.expiresAt).toBeNull();
    expect(m.question).toBe('Bitcoin price');
  });
});

describe('calculateImpliedProbabilities', () => {
  const base = { id: 'x', outcomes: ['Yes', 'No'], outcomePrices: ['0.25', '0.75'] };

  test('Yes price is the probability; odds are its reciprocal', () => {
    const r = svc.calculateImpliedProbabilities(base);
    expect(r.probability).toBe(0.25);
    expect(r.impliedOdds).toBe(4);
  });

  test('finds Yes regardless of outcome order or case', () => {
    const r = svc.calculateImpliedProbabilities({ ...base, outcomes: ['No', 'yes'], outcomePrices: ['0.8', '0.2'] });
    expect(r.probability).toBe(0.2);
  });

  test('zero price gives Infinity odds', () => {
    expect(svc.calculateImpliedProbabilities({ ...base, outcomePrices: ['0', '1'] }).impliedOdds).toBe(Infinity);
  });

  test('null probability for non-binary, no-Yes, or out-of-range prices', () => {
    expect(svc.calculateImpliedProbabilities({ ...base, outcomes: ['A', 'B', 'C'] }).probability).toBeNull();
    expect(svc.calculateImpliedProbabilities({ ...base, outcomes: ['Up', 'Down'] }).probability).toBeNull();
    expect(svc.calculateImpliedProbabilities({ ...base, outcomePrices: ['1.5', '-0.5'] }).probability).toBeNull();
    expect(svc.calculateImpliedProbabilities({ ...base, outcomePrices: ['abc', '1'] }).probability).toBeNull();
  });
});

describe('filterCryptoMarkets', () => {
  const mk = (question, extra = {}) => ({ question, description: '', eventTitle: '', ...extra });

  test('keeps crypto questions, drops unrelated ones', () => {
    const out = svc.filterCryptoMarkets([
      mk('Will Bitcoin hit $100k?'),
      mk('Will ETH be above $5k?'),
      mk('Who wins the election?'),
    ]);
    expect(out.map(m => m.question)).toEqual(['Will Bitcoin hit $100k?', 'Will ETH be above $5k?']);
  });

  test('also matches on description / event title', () => {
    expect(svc.filterCryptoMarkets([mk('Above $90k?', { eventTitle: 'Bitcoin price' })])).toHaveLength(1);
  });
});
