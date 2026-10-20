import { jest } from '@jest/globals';
import { BinanceService, parseOptionSymbol, selectBestCall } from '../src/services/binance.js';

describe('parseOptionSymbol', () => {
  test('parses underlying, 08:00 UTC expiry, strike and type', () => {
    const p = parseOptionSymbol('BTC-260424-120000-C');
    expect(p.underlying).toBe('BTC');
    expect(p.strike).toBe(120000);
    expect(p.type).toBe('C');
    expect(p.expiry.toISOString()).toBe('2026-04-24T08:00:00.000Z');
  });

  test('rejects malformed symbols', () => {
    expect(parseOptionSymbol('BTCUSDT')).toBeNull();
    expect(parseOptionSymbol('BTC-26042-120000-C')).toBeNull();
    expect(parseOptionSymbol('BTC-260424-abc-C')).toBeNull();
    expect(parseOptionSymbol('BTC-260424-120000-X')).toBeNull();
    expect(parseOptionSymbol(null)).toBeNull();
  });
});

describe('selectBestCall', () => {
  const NOW = Date.parse('2026-01-01T00:00:00Z');
  const c = (symbol, markIV = '0.6') => ({ symbol, markIV, markPrice: '100', indexPrice: '100000' });
  const contracts = [
    c('BTC-260626-100000-C'),
    c('BTC-260626-120000-C', '0.65'),
    c('BTC-260626-120000-P', '0.99'),     // put: ignored
    c('BTC-260925-120000-C', '0.70'),     // later expiry
    c('BTC-251201-120000-C', '0.50'),     // already expired
    c('ETH-260626-120000-C', '0.90'),     // other underlying
  ];
  const target = new Date('2026-06-20T00:00:00Z');

  test('picks nearest strike, then nearest expiry at/after the market expiry', () => {
    const best = selectBestCall(contracts, 'BTC', 120000, target, NOW);
    expect(best.symbol).toBe('BTC-260626-120000-C');
    expect(best.impliedVolatility).toBe(0.65);
  });

  test('ignores contracts expiring before the market resolves', () => {
    const best = selectBestCall(contracts, 'BTC', 120000, new Date('2026-07-15T00:00:00Z'), NOW);
    expect(best.symbol).toBe('BTC-260925-120000-C');
  });

  test('null when nothing qualifies or IV is unusable or inputs missing', () => {
    expect(selectBestCall(contracts, 'SOL', 120000, target, NOW)).toBeNull();
    expect(selectBestCall([c('BTC-260626-120000-C', '0')], 'BTC', 120000, target, NOW)).toBeNull();
    expect(selectBestCall(contracts, 'BTC', 120000, null, NOW)).toBeNull();
    expect(selectBestCall(null, 'BTC', 120000, target, NOW)).toBeNull();
  });
});

describe('BinanceService (HTTP mocked)', () => {
  test('fetchOptionsData fetches marks once and serves repeat calls from the 60s cache', async () => {
    const svc = new BinanceService();
    const get = jest.fn().mockResolvedValue({ data: [
      { symbol: 'BTC-261231-120000-C', markIV: '0.7', markPrice: '1', indexPrice: '2' },
    ] });
    svc.optionsClient = { get };
    const a = await svc.fetchOptionsData('BTC', new Date('2026-12-01T00:00:00Z'), 120000);
    const b = await svc.fetchOptionsData('BTC', new Date('2026-12-01T00:00:00Z'), 120000);
    expect(a.impliedVolatility).toBe(0.7);
    expect(b).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('fetchFuturesPrice parses the ticker response', async () => {
    const svc = new BinanceService();
    svc.client = { get: jest.fn().mockResolvedValue({ data: { symbol: 'BTCUSDT', price: '67457.50' } }) };
    const r = await svc.fetchFuturesPrice('btcusdt');
    expect(r.price).toBe(67457.5);
    expect(svc.client.get).toHaveBeenCalledWith('/ticker/price', { params: { symbol: 'BTCUSDT' } });
  });
});
