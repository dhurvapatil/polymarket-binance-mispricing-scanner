import { jest } from '@jest/globals';
import { TelegramService } from '../src/services/telegram.js';
import { Config } from '../src/utils/config.js';

const opp = {
  market: { id: '42', question: 'Will BTC be above $120,000?' },
  futures: { symbol: 'BTCUSDT', price: 100000 },
  arbitrage: { profitMargin: 0.0736 },
  recommendation: 'SELL_POLYMARKET_YES',
};

describe('TelegramService', () => {
  const mk = () => {
    const t = new TelegramService('TOKEN', 'CHAT');
    t.client = { post: jest.fn().mockResolvedValue({ data: { ok: true } }) };
    return t;
  };

  test('formats the alert with edge %, price, direction and links', () => {
    const msg = mk().formatArbitrageMessage(opp);
    expect(msg).toContain('Profit: 7.4%');
    expect(msg).toContain('(BTC)');
    expect(msg).toContain('SELL_POLYMARKET_YES');
    expect(msg).toContain('https://www.binance.com/en/futures/BTCUSDT');
  });

  test('de-duplicates identical opportunities and only POSTs once', async () => {
    const t = mk();
    expect(await t.sendArbitrageAlert(opp)).toBe(true);
    expect(await t.sendArbitrageAlert(opp)).toBe(true);
    expect(t.client.post).toHaveBeenCalledTimes(1);
    expect(t.getStatistics().totalSent).toBe(1);
  });

  test('returns false (does not throw) when the API call fails', async () => {
    const t = mk();
    t.client.post.mockRejectedValue(new Error('down'));
    expect(await t.sendArbitrageAlert(opp)).toBe(false);
    expect(t.getStatistics().totalSent).toBe(0);
  });
});

describe('Config', () => {
  const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'BINANCE_API_KEY', 'BINANCE_API_SECRET',
    'BINANCE_SECRET_KEY', 'MIN_PROFIT_THRESHOLD', 'CHECK_FREQUENCY_MS'];
  let saved;
  beforeEach(() => { saved = {}; KEYS.forEach(k => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => KEYS.forEach(k => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

  test('BINANCE_API_SECRET is read; BINANCE_SECRET_KEY works as a legacy alias', () => {
    process.env.BINANCE_SECRET_KEY = 'legacy';
    expect(new Config().binanceApiSecret).toBe('legacy');
    process.env.BINANCE_API_SECRET = 'primary';
    expect(new Config().binanceApiSecret).toBe('primary');
  });

  test('load() requires the Telegram variables and validates numerics', () => {
    expect(() => Config.load()).toThrow(/TELEGRAM_BOT_TOKEN/);
    process.env.TELEGRAM_BOT_TOKEN = 't';
    process.env.TELEGRAM_CHAT_ID = 'c';
    expect(Config.load().minProfitThreshold).toBe(2.0);
    process.env.CHECK_FREQUENCY_MS = '10';
    expect(() => Config.load()).toThrow(/CHECK_FREQUENCY_MS/);
  });
});
