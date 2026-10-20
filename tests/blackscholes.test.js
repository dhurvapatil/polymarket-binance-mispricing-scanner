import { jest } from '@jest/globals';
import { impliedProbability, blackScholesDetail, daysToYears } from '../src/services/blackscholes.js';

describe('normal CDF (observed through impliedProbability)', () => {
  // With r=0, S=K: d2 = -sigma*sqrt(T)/2, so P = Phi(-sigma*sqrt(T)/2)
  test('reference values of Phi to ~1e-6', () => {
    expect(impliedProbability(100, 100, 1, 0, 2)).toBeCloseTo(0.158655, 5);   // Phi(-1)
    expect(impliedProbability(100, 100, 1, 0, 3.92)).toBeCloseTo(0.024998, 5); // Phi(-1.96)
    expect(impliedProbability(100, 100, 1, 0, 1e-9)).toBeCloseTo(0.5, 6);      // Phi(0)
  });
  test('symmetry Phi(x) + Phi(-x) = 1', () => {
    // With r = sigma^2/2, d2 = ln(S/K)/(sigma*sqrt(T)) is antisymmetric under S<->K.
    const sigma = 0.5, r = sigma * sigma / 2;
    const up = impliedProbability(120, 100, 1, r, sigma);
    const down = impliedProbability(100, 120, 1, r, sigma);
    expect(up + down).toBeCloseTo(1, 6);
  });
});

describe('impliedProbability  N(d2)', () => {
  test('at-the-money, r=0: matches closed form N(-0.5*sigma*sqrt(T))', () => {
    // sigma=0.8, T=1 -> d2 = -0.4 -> N(-0.4) = 0.344578258...
    expect(impliedProbability(100, 100, 1, 0, 0.8)).toBeCloseTo(0.3445783, 6);
  });

  test('textbook value: S=100 K=100 T=1 r=5% sigma=20% -> N(0.15)=0.5596', () => {
    // d2 = (0.05 - 0.02)/0.2 = 0.15 ; N(0.15) = 0.559618
    expect(impliedProbability(100, 100, 1, 0.05, 0.2)).toBeCloseTo(0.559618, 5);
  });

  test('is a probability: always within [0, 1]', () => {
    for (const K of [1, 50, 100, 150, 1e6]) {
      const p = impliedProbability(100, K, 0.5, 0.05, 0.6);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test('decreases as strike rises, increases as spot rises', () => {
    const lowK = impliedProbability(100, 90, 0.25, 0.05, 0.5);
    const highK = impliedProbability(100, 110, 0.25, 0.05, 0.5);
    expect(lowK).toBeGreaterThan(highK);
    const lowS = impliedProbability(90, 100, 0.25, 0.05, 0.5);
    const highS = impliedProbability(110, 100, 0.25, 0.05, 0.5);
    expect(highS).toBeGreaterThan(lowS);
  });

  test('deep in/out of the money tends to 1 / 0', () => {
    expect(impliedProbability(100000, 10000, 0.1, 0.05, 0.5)).toBeCloseTo(1, 6);
    expect(impliedProbability(10000, 100000, 0.1, 0.05, 0.5)).toBeCloseTo(0, 6);
  });

  test('higher vol pushes an OTM digital up (more chance to get there)', () => {
    const lowVol = impliedProbability(100, 130, 0.5, 0.05, 0.3);
    const highVol = impliedProbability(100, 130, 0.5, 0.05, 0.9);
    expect(highVol).toBeGreaterThan(lowVol);
  });

  test('returns null on invalid inputs and implausible vol (>500%)', () => {
    expect(impliedProbability(0, 100, 1, 0.05, 0.5)).toBeNull();
    expect(impliedProbability(100, -1, 1, 0.05, 0.5)).toBeNull();
    expect(impliedProbability(100, 100, 0, 0.05, 0.5)).toBeNull();
    expect(impliedProbability(100, 100, 1, 0.05, 0)).toBeNull();
    expect(impliedProbability(100, 100, 1, 0.05, 5.01)).toBeNull();
    expect(impliedProbability(NaN, 100, 1, 0.05, 0.5)).toBeNull();
  });
});

describe('blackScholesDetail', () => {
  test('call price and delta match the textbook example (S=K=100, T=1, r=5%, sigma=20%)', () => {
    const d = blackScholesDetail(100, 100, 1, 0.05, 0.2);
    expect(d.callPrice).toBeCloseTo(10.4506, 3);
    expect(d.delta).toBeCloseTo(0.6368, 3);
    expect(d.d1).toBeCloseTo(0.35, 10);
    expect(d.d2).toBeCloseTo(0.15, 10);
  });

  test('probability equals impliedProbability and intrinsic value is max(S-K,0)', () => {
    const d = blackScholesDetail(120, 100, 0.5, 0.05, 0.4);
    expect(d.probability).toBeCloseTo(impliedProbability(120, 100, 0.5, 0.05, 0.4), 12);
    expect(d.intrinsicValue).toBe(20);
    expect(blackScholesDetail(80, 100, 0.5, 0.05, 0.4).intrinsicValue).toBe(0);
  });

  test('call price is never below discounted intrinsic value (no-arbitrage bound)', () => {
    const { callPrice } = blackScholesDetail(150, 100, 1, 0.05, 0.3);
    expect(callPrice).toBeGreaterThanOrEqual(150 - 100 * Math.exp(-0.05));
  });

  test('returns null on invalid input', () => {
    expect(blackScholesDetail(100, 100, -1, 0.05, 0.2)).toBeNull();
  });
});

describe('daysToYears', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  test('converts to years using a 365.25-day year', () => {
    expect(daysToYears(new Date('2027-01-01T00:00:00Z'))).toBeCloseTo(365 / 365.25, 10);
  });

  test('floors at one day for expiries that are past or imminent', () => {
    expect(daysToYears(new Date('2025-12-01T00:00:00Z'))).toBeCloseTo(1 / 365, 12);
    expect(daysToYears(new Date('2026-01-01T01:00:00Z'))).toBeCloseTo(1 / 365, 12);
  });
});
