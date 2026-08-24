const request = require('supertest');
const { newDb } = require('pg-mem');

async function setup() {
  jest.resetModules();
  const mem = newDb({ noAstCoverageCheck: true });
  jest.doMock('pg', () => mem.adapters.createPg());
  jest.doMock('../lib/cover.js', () => ({ saveCoverFromUrl: async () => null, COVER_DIR: '/tmp' }));
  const db = require('../db.js');
  await db.migrate();
  const { createApp } = require('../index.js');
  return createApp();
}

describe('spreadsheet exports', () => {
  test.each(['titles', 'borrowers', 'loans'])('%s is an Excel workbook with text-formatted cells', async (name) => {
    const app = await setup();
    const res = await request(app).get(`/api/export/${name}.xlsx`)
      .responseType('blob').expect(200);

    const workbook = res.body.toString('utf8');
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(`${name}.xlsx`);
    expect(workbook.slice(0, 2)).toBe('PK');
    expect(workbook).toContain('t="s"');
    expect(workbook).toContain('numFmtId="49"');
  });
});
