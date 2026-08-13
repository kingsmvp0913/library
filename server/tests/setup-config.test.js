const { buildConfig } = require('../../scripts/setup.js');

describe('buildConfig', () => {
  test('沒有任何覆寫時給出可直接用的預設值', () => {
    const cfg = buildConfig({}, {});
    expect(cfg.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5432/library');
    expect(cfg.PORT).toBe(3940);
    expect(cfg.GOOGLE_BOOKS_API_KEY).toBe('');
  });

  test('overrides 逐欄覆寫，未覆寫的欄位保持預設', () => {
    const cfg = buildConfig({ PORT: 4000 }, {});
    expect(cfg.PORT).toBe(4000);
    expect(cfg.DATABASE_URL).toBe('postgres://postgres:postgres@localhost:5432/library');
  });

  // PORT 0 是「合法但不同」的值：用 || 取預設會被 3940 蓋掉，用 ?? 才會保留。
  // 這個案例專門攔截 ?? 被寫成 || 的錯誤。
  test('PORT 明確給 0 時不被預設值蓋掉', () => {
    expect(buildConfig({ PORT: 0 }, {}).PORT).toBe(0);
  });

  test('env 的優先序低於 overrides、高於預設值', () => {
    expect(buildConfig({}, { PORT: '5000' }).PORT).toBe(5000);
    expect(buildConfig({ PORT: 4000 }, { PORT: '5000' }).PORT).toBe(4000);
  });
});
