describe('isOnline', () => {
  let net;
  beforeEach(() => {
    jest.resetModules();
    net = require('../lib/net-status.js');
    net.resetCache();
  });

  test('探測成功視為線上', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    expect(await net.isOnline({ fetchImpl, now: () => 1000 })).toBe(true);
  });

  test('探測拋錯視為離線，不冒泡', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(net.isOnline({ fetchImpl, now: () => 1000 })).resolves.toBe(false);
  });

  // 快取的意義就是「不要每次都等 timeout」。少了它，離線時每一次掃碼都要卡 3 秒。
  test('60 秒內只探測一次', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await net.isOnline({ fetchImpl, now: () => 1000 });
    await net.isOnline({ fetchImpl, now: () => 30000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('超過 60 秒後會重新探測', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    await net.isOnline({ fetchImpl, now: () => 1000 });
    await net.isOnline({ fetchImpl, now: () => 1000 + 60001 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('markOffline 後在快取期內直接回離線且不再探測', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    net.markOffline(1000);
    expect(await net.isOnline({ fetchImpl, now: () => 5000 })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('探測有 timeout，不會無限等待', async () => {
    const fetchImpl = jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const p = net.isOnline({ fetchImpl, now: () => 1000, timeoutMs: 10 });
    await expect(p).resolves.toBe(false);
  });
});
