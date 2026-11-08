import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import sharp from 'sharp';
import { FakeMl } from './helpers/fakeml';
import { startEnv } from './helpers/filesenv';

process.env.DVCLOUD_EMBED_TICK_MS = '300'; // фоновые векторы проверяем быстро

describe('поиск по смыслу (настоящий Postgres и диск, поддельная ML-служба)', () => {
  const ml = new FakeMl();
  const e = startEnv();
  const { api, upload, intCall } = e;
  const patch = (body: unknown) =>
    fetch(`${e.intBase}/internal/media/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${e.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wait = async (check: () => Promise<boolean>, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const solid = (hex: string) => sharp({ create: { width: 300, height: 200, channels: 3, background: hex } }).jpeg().toBuffer();
  const find = (cookie: string, q: string, extra = '') => api('GET', `/api/search?q=${encodeURIComponent(q)}${extra}`, { cookie });
  const names = (r: { json: any }) => r.json.files.map((f: any) => f.name);
  const status = async (cookie: string) => (await api('GET', '/api/search/status', { cookie })).json;
  const dbq = async <T>(sql: string): Promise<T[]> => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      return (await c.query(sql)).rows as T[];
    } finally {
      await c.end();
    }
  };

  before(async () => {
    await ml.start();
    await e.start({ DVCLOUD_ML_URL: ml.url });
  });
  after(async () => {
    await e.stop();
    await ml.stop();
  });

  it('по умолчанию выключено: поиск отвечает 503, векторы не считаются', async () => {
    const o = await intCall('GET', '/internal/media');
    assert.equal(o.settings.searchEnabled, false);
    assert.equal(o.settings.searchCutoff, 80);
    await upload(e.anna, 'red.jpg', await solid('#ff0000'));
    await sleep(1500);
    assert.equal(ml.images, 0, 'пока выключено, ML-служба не нагружается');
    const r = await find(e.anna, 'красный');
    assert.equal(r.status, 503);
    assert.match(r.json.message, /выключен/);
    assert.equal((await status(e.anna)).enabled, false);
  });

  it('проверка значений настроек', async () => {
    assert.equal((await patch({ searchEnabled: 'да' })).status, 400);
    assert.equal((await patch({ searchCutoff: 49 })).status, 400);
    assert.equal((await patch({ searchCutoff: 96 })).status, 400);
    assert.equal((await patch({ searchCutoff: 80.5 })).status, 400);
  });

  it('после включения векторы считаются в фоне, поиск находит нужное и не показывает лишнего', async () => {
    assert.equal((await patch({ searchEnabled: true })).status, 200);
    await upload(e.anna, 'green.jpg', await solid('#00ff00'));
    await upload(e.anna, 'blue.jpg', await solid('#0000ff'));
    await sleep(2500); // публичный порт перечитывает настройки раз в пару секунд
    assert.ok(await wait(async () => (await status(e.anna)).indexed === 3), 'все три файла проиндексированы');
    const s = await status(e.anna);
    assert.deepEqual({ enabled: s.enabled, available: s.available, total: s.total }, { enabled: true, available: true, total: 3 });

    const red = await find(e.anna, 'красный');
    assert.equal(red.status, 200);
    assert.deepEqual(names(red), ['red.jpg'], 'другие цвета не дотягивают до порога');
    assert.ok(red.json.files[0].score > 0.9);
    assert.deepEqual(names(await find(e.anna, 'синий')), ['blue.jpg']);
    assert.deepEqual(names(await find(e.anna, 'ЗЕЛЁНЫЙ  ')), ['green.jpg'], 'регистр и пробелы по краям не мешают');
  });

  it('порог можно ослабить: тогда в выдаче появляются и слабые совпадения', async () => {
    assert.equal((await patch({ searchCutoff: 50 })).status, 200);
    await sleep(2500);
    const all = await find(e.anna, 'красный');
    assert.equal(all.json.files.length >= 1, true);
    // Запрос без «цвета» (все компоненты равны) сходен со всеми, порог 50% оставляет всех.
    assert.equal((await find(e.anna, 'что-то неопределённое')).json.files.length, 3);
    assert.equal((await patch({ searchCutoff: 80 })).status, 200);
    await sleep(2500);
  });

  it('чужие файлы и корзина в выдачу не попадают', async () => {
    await upload(e.boris, 'boris-red.jpg', await solid('#ff1010'));
    assert.ok(await wait(async () => (await status(e.boris)).indexed === 1));
    assert.deepEqual(names(await find(e.boris, 'красный')), ['boris-red.jpg']);
    assert.deepEqual(names(await find(e.anna, 'красный')), ['red.jpg']);
    const list = (await api('GET', '/api/files', { cookie: e.anna })).json.files;
    const id = list.find((f: any) => f.name === 'red.jpg').id;
    assert.equal((await api('DELETE', `/api/files/${id}`, { cookie: e.anna })).status, 200);
    assert.deepEqual(names(await find(e.anna, 'красный')), [], 'файл в корзине не ищется');
    assert.equal((await api('POST', `/api/files/${id}/restore`, { cookie: e.anna, body: '{}', type: 'application/json' })).status, 200);
    assert.deepEqual(names(await find(e.anna, 'красный')), ['red.jpg']);
  });

  it('один и тот же файл у двух людей индексируется один раз', async () => {
    const before = ml.images;
    await upload(e.boris, 'same-as-anna-blue.jpg', await solid('#0000ff'));
    assert.ok(await wait(async () => (await status(e.boris)).indexed === 2));
    const rows = await dbq<{ n: string }>("SELECT count(*) AS n FROM embeddings WHERE status = 'ready'");
    assert.equal(Number(rows[0].n), 4, 'четыре разных содержимого, а не пять файлов');
    assert.equal(ml.images, before, 'для файла с уже известным содержимым ML-служба не вызывалась');
  });

  it('неверные запросы', async () => {
    assert.equal((await api('GET', '/api/search', { cookie: e.anna })).status, 400);
    assert.equal((await find(e.anna, '   ')).status, 400);
    assert.equal((await find(e.anna, 'я'.repeat(201))).status, 400);
    assert.equal((await find(e.anna, 'красный', '&limit=0')).status, 400);
    assert.equal((await find(e.anna, 'красный', '&limit=301')).status, 400);
    assert.equal((await api('GET', '/api/search?q=x')).status, 401, 'без входа нельзя');
  });

  it('админка: счётчики, неудачные, очистка индекса и пересчёт', async () => {
    await upload(e.anna, 'broken.jpg', e.jpeg('мусор вместо картинки', 3000));
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).search.failed === 1));
    const o = (await intCall('GET', '/internal/media')).search;
    assert.equal(o.configured, true);
    assert.equal(o.up, true);
    assert.equal(o.model, 'fake-color-v1');
    assert.ok(o.total === 5 && o.ready === 4 && o.failed === 1 && o.pending === 0, JSON.stringify(o));
    assert.ok(o.sizeBytes > 0);
    const f = await intCall('POST', '/internal/media/clear', { what: 'index-failed' });
    assert.equal(f.files, 1);
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).search.failed === 1), 'неудачный файл пробуется снова');
    await intCall('POST', '/internal/media/clear', { what: 'index' });
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).search.ready === 4), 'после полной очистки всё считается заново');
  });

  it('смена модели: векторы старой модели не смешиваются с новой и пересчитываются', async () => {
    ml.model = 'fake-color-v2';
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).search.ready === 4));
    const models = await dbq<{ model: string }>("SELECT DISTINCT model FROM embeddings WHERE status = 'ready'");
    assert.deepEqual(models.map((m) => m.model), ['fake-color-v2']);
    assert.deepEqual(names(await find(e.anna, 'красный')), ['red.jpg']);
  });

  it('ML-служба недоступна: 503 с понятным текстом, остальное облако работает', async () => {
    assert.equal((await find(e.anna, 'зелёный')).status, 200, 'прогрев: вектор запроса теперь от текущей модели');
    await ml.stop();
    const r = await find(e.anna, 'зелёный');
    assert.equal(r.status, 200, 'запрос уже в кэше: ответ приходит без службы');
    const fresh = await find(e.anna, 'совсем новый запрос');
    assert.equal(fresh.status, 503);
    assert.match(fresh.json.message, /недоступна/);
    assert.equal((await api('GET', '/api/files', { cookie: e.anna })).status, 200);
    assert.equal((await intCall('GET', '/internal/media')).search.up, false);
    assert.equal((await status(e.anna)).available, false);
  });
});
