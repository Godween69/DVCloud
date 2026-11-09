// Лица и питомцы на настоящем Postgres и диске с поддельной ML-службой (цвет картинки = «кто на фото»).
// Красная картинка: лицо А. Синяя: лицо Б. Зелёная: оба. Жёлтая: кошка. Запуск: npm run test:db
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { FakeMl } from './helpers/fakeml';
import { startEnv } from './helpers/filesenv';

process.env.DVCLOUD_PEOPLE_TICK_MS = '300';
process.env.DVCLOUD_NO_THUMB_MIGRATION = '1';

describe('лица и питомцы (настоящий Postgres и диск, поддельная ML-служба)', () => {
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
  const jr = (method: string, path: string, cookie: string, body: unknown) => api(method, path, { cookie, body: JSON.stringify(body), type: 'application/json' });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const solid = (hex: string) => sharp({ create: { width: 300, height: 200, channels: 3, background: hex } }).jpeg({ quality: 95 }).toBuffer();
  const people = async (cookie: string, hidden = false) => (await api('GET', `/api/people${hidden ? '?hidden=1' : ''}`, { cookie })).json;
  const dbq = async <T>(sql: string): Promise<T[]> => {
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      return (await c.query(sql)).rows as T[];
    } finally {
      await c.end();
    }
  };
  // Долгая операция над группами идёт в фоне: ждём, пока в обзоре админки она перестанет быть «running».
  const finishedJob = async () => {
    let j: any = null;
    assert.ok(await wait(async () => { j = (await intCall('GET', '/internal/media')).peopleJob; return j !== null && j.state !== 'running'; }), 'операция не закончилась');
    return j;
  };
  const fileNames = (r: { json: any }) => r.json.files.map((f: any) => f.name).sort();

  before(async () => {
    await ml.start();
    await e.start({ DVCLOUD_ML_URL: ml.url });
  });
  after(async () => {
    await e.stop();
    await ml.stop();
  });

  it('по умолчанию выключено: ML-служба не нагружается, список пуст', async () => {
    const o = await intCall('GET', '/internal/media');
    assert.equal(o.settings.facesEnabled, false);
    assert.equal(o.settings.petsEnabled, false);
    await upload(e.anna, 'a0.jpg', await solid('#f00000'));
    await sleep(1200);
    assert.equal(ml.faceCalls + ml.petCalls, 0);
    const p = await people(e.anna);
    assert.deepEqual(p, { enabled: { faces: false, pets: false }, people: [] });
    assert.equal((await api('GET', '/api/people')).status, 401);
  });

  it('проверка значений настроек', async () => {
    assert.equal((await patch({ facesEnabled: 'да' })).status, 400);
    assert.equal((await patch({ petsEnabled: 1 })).status, 400);
  });

  it('после включения лица собираются в группы: два человека, случайные одиночки не заводят группу', async () => {
    assert.equal((await patch({ facesEnabled: true })).status, 200);
    for (const [i, c] of ['#f10000', '#f20000', '#f30000'].entries()) await upload(e.anna, `a${i + 1}.jpg`, await solid(c)); // всего четыре красных вместе с a0
    for (const [i, c] of ['#0000f1', '#0000f2'].entries()) await upload(e.anna, `b${i}.jpg`, await solid(c)); // два синих: до группы не дотягивают
    await upload(e.anna, 'ab.jpg', await solid('#00f000')); // на нём оба
    await sleep(2500);
    const ok = await wait(async () => {
      const p = await people(e.anna);
      return p.people.length === 2 && p.people.some((x: any) => x.count === 5) && p.people.some((x: any) => x.count === 3);
    });
    assert.ok(ok, JSON.stringify(await people(e.anna)));
    const p = await people(e.anna);
    assert.deepEqual(p.enabled, { faces: true, pets: false });
    assert.ok(p.people.every((x: any) => x.name === null && x.kind === 'person' && /^\d+$/.test(x.cover)));
    assert.equal(p.people[0].count, 5, 'сначала те, на ком больше файлов');
    assert.equal((await people(e.anna, true)).people.length, 2, 'hidden=1 отдаёт и видимые группы тоже: сайт фильтрует скрытых сам');
  });

  it('имя группе даётся один раз, по человеку находятся его файлы, склонения в запросе понимаются', async () => {
    const [a, b] = (await people(e.anna)).people;
    assert.equal((await jr('PATCH', `/api/people/${a.id}`, e.anna, { name: '  Валя ' })).status, 200);
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, e.anna, { name: 'Дима' })).status, 200);
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, e.anna, { name: 'валя' })).status, 409, 'имя уже занято');
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, e.anna, { name: '' })).status, 400);
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, e.anna, { color: 'red' })).status, 400);
    assert.equal((await people(e.anna)).people[0].name, 'Валя');
    const valya = await api('GET', `/api/files?person=${a.id}`, { cookie: e.anna });
    assert.deepEqual(fileNames(valya), ['a0.jpg', 'a1.jpg', 'a2.jpg', 'a3.jpg', 'ab.jpg']);
    const dima = await api('GET', `/api/files?person=${b.id}`, { cookie: e.anna });
    assert.deepEqual(fileNames(dima), ['ab.jpg', 'b0.jpg', 'b1.jpg']);
    for (const q of ['Валя', 'фото с Валей', 'Валю', 'покажи все фотки с валей']) {
      const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`, { cookie: e.anna });
      assert.equal(r.status, 200, q);
      assert.deepEqual(fileNames(r), ['a0.jpg', 'a1.jpg', 'a2.jpg', 'a3.jpg', 'ab.jpg'], q);
      assert.deepEqual(r.json.people.map((x: any) => x.name), ['Валя']);
    }
    const both = await api('GET', `/api/search?q=${encodeURIComponent('Валя и Дима')}`, { cookie: e.anna });
    assert.deepEqual(fileNames(both), ['ab.jpg'], 'оба сразу: только общий снимок');
    const rest = await api('GET', `/api/search?q=${encodeURIComponent('Валя на пляже')}`, { cookie: e.anna });
    assert.equal(rest.status, 200, 'поиск по смыслу выключен: остаются файлы человека');
    assert.equal(rest.json.files.length, 5);
    assert.equal((await api('GET', '/api/files?person=abc', { cookie: e.anna })).status, 400);
  });

  it('чужая жизнь закрыта: другой человек не видит ни группы, ни имена, ни файлы', async () => {
    assert.deepEqual((await people(e.boris)).people, []);
    const a = (await people(e.anna)).people[0];
    assert.deepEqual((await api('GET', `/api/files?person=${a.id}`, { cookie: e.boris })).json.files, []);
    assert.equal((await jr('PATCH', `/api/people/${a.id}`, e.boris, { name: 'Хакер' })).status, 404);
    assert.equal((await jr('POST', `/api/people/${a.id}/merge`, e.boris, { from: a.id })).status, 404);
    assert.equal((await api('DELETE', `/api/people/${a.id}`, { cookie: e.boris })).status, 404);
    assert.equal((await api('GET', `/api/people/detections/${a.cover}/crop`, { cookie: e.boris })).status, 404);
    const r = await api('GET', `/api/search?q=${encodeURIComponent('Валя')}`, { cookie: e.boris });
    assert.ok(r.status === 503 || r.json.files.length === 0, 'имён чужого человека он не знает');
  });

  it('тот же файл у другого человека: группы у него свои, имена не переходят', async () => {
    // тот же файл: содержимое одно, просмотр заново не нужен, но у Бориса должны собраться свои группы
    for (const [i, c] of ['#f10000', '#f20000', '#f30000'].entries()) assert.equal((await upload(e.boris, `bb${i}.jpg`, await solid(c))).status, 201);
    const ok = await wait(async () => (await people(e.boris)).people.length === 1);
    assert.ok(ok, JSON.stringify(await people(e.boris)));
    const b = (await people(e.boris)).people[0];
    assert.equal(b.name, null, 'имя Валя придумала Анна, Борису его не видно');
    assert.equal(b.count, 3);
    assert.equal((await people(e.anna)).people[0].count, 5, 'у Анны ничего не изменилось');
  });

  it('вырезка лица: квадратная, маленькая, WebP, кэшируется', async () => {
    const a = (await people(e.anna)).people[0];
    const r = await api('GET', `/api/people/detections/${a.cover}/crop`, { cookie: e.anna });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    assert.match(r.headers.get('cache-control') ?? '', /immutable/);
    const m = await sharp(r.buf).metadata();
    assert.deepEqual([m.format, m.width, m.height], ['webp', 192, 192]);
    const [row] = await dbq<{ blob_id: string }>(`SELECT blob_id FROM detections WHERE id = ${Number(a.cover)}`);
    assert.ok((await stat(join(e.dataDir, 'faces', row.blob_id, `${a.cover}.webp`))).size > 0);
  });

  it('рамки на файле и ручная разметка: назвать лицо на фото, переназначить, снять, «это не он»', async () => {
    const files = (await api('GET', '/api/files', { cookie: e.anna })).json.files as { id: string; name: string }[];
    const ab = files.find((f) => f.name === 'ab.jpg')!;
    const faces = (await api('GET', `/api/people/file/${ab.id}`, { cookie: e.anna })).json.faces;
    assert.equal(faces.length, 2);
    assert.ok(faces.every((f: any) => f.kind === 'face' && f.box.length === 4 && f.personId));
    assert.deepEqual(faces.map((f: any) => f.name).sort(), ['Валя', 'Дима']);
    assert.deepEqual((await api('GET', `/api/people/file/${ab.id}`, { cookie: e.boris })).json.faces, [], 'на чужом файле рамок нет');
    // «это не он»: Диму убираем с общего снимка, снимок в его выдаче пропадает и не возвращается после пересчёта
    const dima = (await people(e.anna)).people.find((x: any) => x.name === 'Дима');
    assert.equal((await api('DELETE', `/api/people/${dima.id}/files/${ab.id}`, { cookie: e.anna })).json.removed, 1);
    assert.deepEqual(fileNames(await api('GET', `/api/files?person=${dima.id}`, { cookie: e.anna })), ['b0.jpg', 'b1.jpg']);
    await upload(e.anna, 'b2.jpg', await solid('#0000c8')); // новая находка запускает пересчёт
    assert.ok(await wait(async () => (await api('GET', `/api/files?person=${dima.id}`, { cookie: e.anna })).json.files.length === 3), JSON.stringify({ now: fileNames(await api('GET', `/api/files?person=${dima.id}`, { cookie: e.anna })), rows: await dbq("SELECT d.id, d.blob_id, dp.person_id, dp.source FROM detections d LEFT JOIN detection_people dp ON dp.detection_id = d.id WHERE d.vector IS NOT NULL ORDER BY d.id"), rej: await dbq('SELECT * FROM detection_rejects'), sc: await dbq('SELECT blob_id, what, model, status FROM detection_scans ORDER BY blob_id') }));
    assert.deepEqual(fileNames(await api('GET', `/api/files?person=${dima.id}`, { cookie: e.anna })), ['b0.jpg', 'b1.jpg', 'b2.jpg'], 'ab.jpg не вернулся');
    // вручную вернуть: назначить находку человеку
    const detDima = faces.find((f: any) => f.name === 'Дима').id;
    assert.equal((await jr('PUT', `/api/people/detections/${detDima}`, e.anna, { personId: dima.id })).status, 200);
    assert.deepEqual(fileNames(await api('GET', `/api/files?person=${dima.id}`, { cookie: e.anna })), ['ab.jpg', 'b0.jpg', 'b1.jpg', 'b2.jpg']);
    // снять назначение
    assert.equal((await jr('PUT', `/api/people/detections/${detDima}`, e.anna, { personId: null })).status, 200);
    assert.equal((await jr('PUT', `/api/people/detections/${detDima}`, e.anna, { personId: 5 })).status, 400);
    assert.equal((await jr('PUT', `/api/people/detections/${detDima}`, e.boris, { personId: null })).status, 404);
  });

  it('новый человек по лицу на фото: название сразу, одинаковое имя это та же группа', async () => {
    // файл, который есть только у Бориса (остальные те же, что у Анны: общие файлы Анна тоже вправе размечать)
    assert.equal((await upload(e.boris, 'only-boris.jpg', await solid('#e80000'))).status, 201);
    const files = (await api('GET', '/api/files', { cookie: e.boris })).json.files as { id: string; name: string }[];
    const mine = files.find((f) => f.name === 'only-boris.jpg')!;
    assert.ok(await wait(async () => (await api('GET', `/api/people/file/${mine.id}`, { cookie: e.boris })).json.faces.length === 1));
    const faces = (await api('GET', `/api/people/file/${mine.id}`, { cookie: e.boris })).json.faces;
    const made = await jr('POST', '/api/people', e.boris, { detectionId: faces[0].id, name: 'Мама' });
    assert.equal(made.status, 201);
    const p = (await people(e.boris)).people;
    assert.ok(p.some((x: any) => x.id === made.json.id && x.name === 'Мама'));
    assert.equal((await jr('POST', '/api/people', e.boris, { detectionId: faces[0].id, name: ' мама ' })).json.id, made.json.id);
    assert.equal((await jr('POST', '/api/people', e.boris, { detectionId: faces[0].id, name: '' })).status, 400);
    assert.equal((await jr('POST', '/api/people', e.anna, { detectionId: faces[0].id, name: 'Чужая' })).status, 404);
  });

  it('кошка: питомцы включаются отдельно, группа собирается, называется, лицо к питомцу отнести нельзя', async () => {
    assert.equal((await patch({ petsEnabled: true })).status, 200);
    for (const [i, c] of ['#f0f000', '#e8e800', '#e0e000', '#d8d800'].entries()) await upload(e.anna, `cat${i}.jpg`, await solid(c));
    assert.ok(await wait(async () => (await people(e.anna)).people.some((x: any) => x.kind === 'pet' && x.count === 4)), JSON.stringify(await people(e.anna)));
    const cat = (await people(e.anna)).people.find((x: any) => x.kind === 'pet');
    assert.equal((await jr('PATCH', `/api/people/${cat.id}`, e.anna, { name: 'Ефим' })).status, 200);
    const r = await api('GET', `/api/search?q=${encodeURIComponent('кот Ефим')}`, { cookie: e.anna });
    assert.equal(r.json.files.length, 4);
    const files = (await api('GET', '/api/files', { cookie: e.anna })).json.files as { id: string; name: string }[];
    const ab = files.find((f) => f.name === 'ab.jpg')!;
    const face = (await api('GET', `/api/people/file/${ab.id}`, { cookie: e.anna })).json.faces[0];
    assert.equal((await jr('PUT', `/api/people/detections/${face.id}`, e.anna, { personId: cat.id })).status, 400);
    const a = (await people(e.anna)).people.find((x: any) => x.name === 'Валя');
    assert.equal((await jr('POST', `/api/people/${a.id}/merge`, e.anna, { from: cat.id })).status, 400, 'человека и питомца не объединить');
  });

  it('объединить две группы, скрыть группу, распустить', async () => {
    // вторая безымянная группа второго человека: добавим четыре снимка того же лица, назовём одну и объединим
    const before = (await people(e.boris)).people;
    const mama = before.find((x: any) => x.name === 'Мама');
    assert.ok(mama);
    const other = before.find((x: any) => x.id !== mama.id);
    if (other) {
      assert.equal((await jr('POST', `/api/people/${mama.id}/merge`, e.boris, { from: other.id })).status, 200);
      assert.ok(!(await people(e.boris)).people.some((x: any) => x.id === other.id));
    }
    assert.equal((await jr('POST', `/api/people/${mama.id}/merge`, e.boris, { from: mama.id })).status, 400);
    assert.equal((await jr('PATCH', `/api/people/${mama.id}`, e.boris, { hidden: true })).status, 200);
    assert.ok(!(await people(e.boris)).people.some((x: any) => x.id === mama.id));
    assert.ok((await people(e.boris, true)).people.some((x: any) => x.id === mama.id));
    assert.equal((await jr('PATCH', `/api/people/${mama.id}`, e.boris, { hidden: false })).status, 200);
    assert.equal((await api('DELETE', `/api/people/${mama.id}`, { cookie: e.boris })).status, 200);
    assert.equal((await api('DELETE', `/api/people/${mama.id}`, { cookie: e.boris })).status, 404);
  });

  it('корзина: файлы в корзине не считаются; окончательное стирание оригинала убирает находки и вырезки', async () => {
    const files = (await api('GET', '/api/files', { cookie: e.anna })).json.files as { id: string; name: string }[];
    const a0 = files.find((f) => f.name === 'a0.jpg')!;
    const valya = () => people(e.anna).then((p) => p.people.find((x: any) => x.name === 'Валя'));
    const n0 = (await valya()).count;
    await api('DELETE', `/api/files/${a0.id}`, { cookie: e.anna });
    assert.equal((await valya()).count, n0 - 1, 'в корзине человека не считаем');
    const [b] = await dbq<{ blob_id: string; n: string }>(`SELECT f.blob_id, (SELECT count(*) FROM detections d WHERE d.blob_id = f.blob_id) AS n FROM files f WHERE f.id = ${Number(a0.id)}`);
    assert.equal(Number(b.n), 1);
    // обложка этой находки: вырезка на диске
    const det = (await dbq<{ id: string }>(`SELECT id FROM detections WHERE blob_id = ${Number(b.blob_id)}`))[0].id;
    const crop = await api('GET', `/api/people/detections/${det}/crop`, { cookie: e.anna });
    assert.equal(crop.status, 200);
    await api('DELETE', `/api/files/${a0.id}?permanent=1`, { cookie: e.anna });
    const orphan = (await intCall('GET', '/internal/files/orphans')).orphans.find((x: any) => x.name === 'a0.jpg');
    assert.ok(orphan);
    assert.equal((await intCall('POST', `/internal/files/${orphan.id}/purge`)).links, 0);
    assert.equal((await dbq(`SELECT 1 FROM detections WHERE blob_id = ${Number(b.blob_id)}`)).length, 0, 'находки ушли вместе с файлом');
    await assert.rejects(stat(join(e.dataDir, 'faces', b.blob_id)));
  });

  it('админка: счётчики и полная очистка данных лиц', async () => {
    const o = await intCall('GET', '/internal/media');
    assert.equal(o.people.faces.enabled, true);
    assert.equal(o.people.faces.modelFiles, true);
    assert.ok(o.people.faces.done >= 5);
    assert.ok(o.people.detections.faces >= 8 && o.people.detections.pets === 4);
    assert.ok(o.people.groups >= 3 && o.people.named >= 2);
    assert.equal(o.people.faces.pending + o.people.faces.done + o.people.faces.failed, o.people.faces.total);
    const calls = ml.faceCalls;
    await patch({ facesEnabled: false, petsEnabled: false });
    await sleep(2500);
    const c = await intCall('POST', '/internal/media/clear', { what: 'people' });
    assert.ok(c.files >= 8);
    const o2 = await intCall('GET', '/internal/media');
    assert.deepEqual([o2.people.detections.faces, o2.people.detections.pets, o2.people.groups], [0, 0, 0]);
    assert.deepEqual((await people(e.anna)).people, []);
    await sleep(1200);
    assert.equal(ml.faceCalls, calls, 'пока выключено, заново не просматривается');
    assert.equal((await intCall('POST', '/internal/media/clear', { what: 'nonsense' })).message?.length > 0, true);
  });

  it('смена модели: файлы просматриваются заново, старые находки заменяются', async () => {
    await patch({ facesEnabled: true });
    await sleep(2500);
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).people.faces.pending === 0), 'всё просмотрено заново после очистки');
    const n1 = (await intCall('GET', '/internal/media')).people.detections.faces;
    ml.facesModel = 'fake-faces-v2';
    assert.ok(await wait(async () => {
      const s = await dbq<{ n: string }>("SELECT count(*) AS n FROM detection_scans WHERE what = 'faces' AND model = 'fake-faces-v2'");
      return Number(s[0].n) > 0 && (await intCall('GET', '/internal/media')).people.faces.pending === 0;
    }));
    assert.equal((await intCall('GET', '/internal/media')).people.detections.faces, n1, 'находки заменены, а не удвоены');
    assert.equal((await dbq("SELECT 1 FROM detections WHERE kind = 'face' AND model <> 'fake-faces-v2'")).length, 0);
  });
  it('строгость лиц: границы 30-55 в настройках, подсказка по числу групп', async () => {
    assert.equal((await patch({ facesSim: 29 })).status, 400);
    assert.equal((await patch({ facesSim: 56 })).status, 400);
    assert.equal((await patch({ facesSim: 0.45 })).status, 400, 'целое число процентов');
    assert.equal((await intCall('GET', '/internal/media')).settings.facesSim, 45, 'по умолчанию 45');
    assert.equal((await patch({ facesSim: 40 })).status, 200);
    assert.equal((await intCall('GET', '/internal/media')).settings.facesSim, 40);
    assert.equal((await intCall('GET', '/internal/media')).peopleJob, null, 'пока ничего не запускали');
    const started = await intCall('POST', '/internal/media/people/hint', {});
    assert.equal(started.job.kind, 'hint');
    const h = await finishedJob();
    assert.equal(h.state, 'done', JSON.stringify(h));
    assert.deepEqual(h.hint.map((x: any) => x.sim), [30, 35, 40, 45, 50, 55]);
    assert.ok(h.hint.every((x: any) => x.groups >= 1 && x.ungrouped >= 0), JSON.stringify(h));
    assert.ok(h.step === h.steps && h.steps >= 6 && h.elapsedSec >= 0);
    assert.equal((await patch({ facesSim: 45 })).status, 200);
  });

  it('«Пересобрать группы»: названные и скрытые остаются, безымянные собираются заново', async () => {
    const before = (await people(e.anna, true)).people;
    assert.ok(before.length >= 2, JSON.stringify(before));
    const [keep, drop] = before;
    assert.equal((await jr('PATCH', `/api/people/${keep.id}`, e.anna, { name: 'Оставить' })).status, 200);
    const bor = (await people(e.boris, true)).people;
    assert.ok(bor.length >= 1);
    assert.equal((await jr('PATCH', `/api/people/${bor[0].id}`, e.boris, { hidden: true })).status, 200);
    const started = await intCall('POST', '/internal/media/people/rebuild', {});
    assert.equal(started.job.kind, 'rebuild');
    const job = await finishedJob();
    assert.equal(job.state, 'done', JSON.stringify(job));
    const r = job.rebuild;
    assert.ok(r.removed >= 1 && r.created >= 1, JSON.stringify(r));
    const after = (await people(e.anna, true)).people;
    assert.equal(after.length, before.length, 'число групп то же: те же лица собрались снова');
    const kept = after.find((x: any) => x.id === keep.id);
    assert.equal(kept?.name, 'Оставить');
    assert.equal(kept?.count, keep.count);
    assert.ok(!after.some((x: any) => x.id === drop.id), 'безымянная группа пересоздана с новым номером');
    assert.equal(after.find((x: any) => x.id !== keep.id).count, drop.count, 'в ней те же файлы');
    const b2 = (await people(e.boris, true)).people;
    assert.equal(b2.length, bor.length);
    assert.equal(b2.find((x: any) => x.id === bor[0].id)?.hidden, true, 'скрытая группа не тронута');
  });

  it('объединить сразу несколько групп: в названную, имена остальных пропадают, чужие и пустой список отклоняются', async () => {
    const list = (await people(e.anna, true)).people;
    const keep = list.find((x: any) => x.name === 'Оставить');
    const other = list.find((x: any) => x.id !== keep.id);
    const total = keep.count + other.count;
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [] })).status, 400);
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [keep.id] })).status, 400, 'сама в себя не сливается');
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id })).status, 400);
    const boris = (await people(e.boris, true)).people[0];
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [boris.id] })).status, 404, 'чужая группа');
    assert.equal((await jr('POST', '/api/people/merge-many', e.boris, { into: boris.id, from: [keep.id] })).status, 404);
    const ok = await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [other.id, other.id] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.merged, 1, 'повтор в списке не считается дважды');
    const now = (await people(e.anna, true)).people;
    assert.equal(now.length, list.length - 1);
    assert.equal(now.find((x: any) => x.id === keep.id).name, 'Оставить');
    assert.ok(now.find((x: any) => x.id === keep.id).count >= other.count, `было ${total} файлов у двух групп, склеилось`);
  });
});
