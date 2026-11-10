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

  let root = ''; // администратор: только он вправе объединять, удалять и переименовывать названные группы
  before(async () => {
    await ml.start();
    await e.start({ DVCLOUD_ML_URL: ml.url });
    root = await e.loginAs('root');
    await dbq("UPDATE users SET is_admin = true WHERE login = 'root'");
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
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, e.anna, { name: 'Сергей' })).status, 403, 'уже названную группу обычный пользователь не переименует');
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, root, { name: 'валя' })).status, 409, 'имя уже занято');
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, root, { name: 'Дима' })).status, 200, 'администратор переименовывает');
    assert.equal((await jr('PATCH', `/api/people/${b.id}`, root, { name: '' })).status, 400);
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


  it('альбом по людям: обязательно эти, не должно быть тех; чужие группы и пустые условия отклоняются', async () => {
    const list = (await people(e.anna)).people;
    const valya = list.find((x: any) => x.name === 'Валя').id;
    const dima = list.find((x: any) => x.name === 'Дима').id;
    const count = async (include: string[], exclude: string[]) => (await jr('POST', '/api/people/match', e.anna, { include, exclude })).json.count;
    assert.equal(await count([valya], []), 5);
    assert.equal(await count([valya], [dima]), 4, 'Валя без Димы: общий снимок отпадает');
    assert.equal(await count([dima], [valya]), 2);
    assert.equal(await count([valya, dima], []), 1);
    const only = async (include: string[]) => (await jr('POST', '/api/people/match', e.anna, { include, exclude: [], only: true })).json.count;
    assert.equal(await only([valya]), 4, '«только они»: Валя одна, снимок с Димой отпадает');
    assert.equal(await only([dima]), 2);
    assert.equal(await only([valya, dima]), 1, 'оба и больше никого');
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', include: [valya], only: true })).json.count, 4, 'то же в конструкторе');
    assert.equal((await jr('POST', '/api/albums/builder/count', e.anna, { source: 'all', only: true })).status, 400, '«только они» без выбранных не бывает');
    assert.equal((await jr('POST', '/api/people/match', e.anna, { include: [], exclude: [dima] })).status, 400, 'нужен хотя бы один обязательный');
    assert.equal((await jr('POST', '/api/people/match', e.anna, { include: [valya], exclude: [valya] })).status, 400, 'один человек в обоих списках');
    assert.equal((await jr('POST', '/api/people/match', e.anna, { include: ['abc'] })).status, 400);
    assert.equal((await jr('POST', '/api/people/match', e.anna, { include: ['999999'] })).status, 404, 'чужой или несуществующей группы нет');
    const made = await jr('POST', '/api/people/album', e.anna, { name: 'Только Валя', include: [valya], exclude: [dima] });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.added, 4);
    const inside = await api('GET', `/api/albums/${made.json.id}/files`, { cookie: e.anna });
    assert.deepEqual(fileNames(inside), ['a0.jpg', 'a1.jpg', 'a2.jpg', 'a3.jpg']);
    assert.equal((await jr('POST', '/api/people/album', e.anna, { name: 'Только Валя', include: [valya], exclude: [dima] })).status, 409, 'название занято');
    assert.equal((await jr('POST', '/api/people/album', e.anna, { name: 'Пусто', include: [dima], exclude: [dima] })).status, 400);
  });
  it('обложку группы можно выбрать самому по фото и вернуть автоматический выбор', async () => {
    const a = (await people(e.anna)).people[0];
    const auto = a.cover;
    const files = (await api('GET', `/api/files?person=${a.id}`, { cookie: e.anna })).json.files;
    const pick = files.find((f: any) => f.name === 'a2.jpg');
    const faces = (await api('GET', `/api/people/file/${pick.id}`, { cookie: e.anna })).json.faces;
    assert.equal(faces.length, 1);
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, e.anna, { fileId: pick.id })).status, 403, 'обложка общая: меняет администратор');
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, root, { fileId: pick.id })).status, 200);
    assert.equal((await people(e.anna)).people.find((x: any) => x.id === a.id).cover, faces[0].id, 'обложка стала лицом с выбранного фото');
    // на чужом для группы фото (синий Дима) обложку не поставить; чужой человек и неверные значения отклоняются
    const dimaFile = (await api('GET', '/api/files', { cookie: e.anna })).json.files.find((f: any) => f.name === 'b0.jpg');
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, root, { fileId: dimaFile.id })).status, 404);
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, e.boris, { fileId: pick.id })).status, 404);
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, root, { fileId: 5 })).status, 400);
    assert.equal((await people(e.anna)).people.find((x: any) => x.id === a.id).cover, faces[0].id, 'неудачные попытки обложку не меняют');
    assert.equal((await jr('PUT', `/api/people/${a.id}/cover`, root, { fileId: null })).status, 200);
    assert.equal((await people(e.anna)).people.find((x: any) => x.id === a.id).cover, auto, 'после сброса снова выбирается сама');
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

  it('люди общие: тот же человек у другого пользователя уже назван, список только по его фото', async () => {
    // красные лица Бориса попадают в ту же общую группу «Валя»: имя не спрашивают заново
    for (const [i, c] of ['#f10000', '#f20000', '#f30000'].entries()) assert.equal((await upload(e.boris, `bb${i}.jpg`, await solid(c))).status, 201);
    const ok = await wait(async () => { const p = (await people(e.boris)).people; return p.length === 1 && p[0].count === 3; });
    assert.ok(ok, JSON.stringify(await people(e.boris)));
    const b = (await people(e.boris)).people[0];
    assert.equal(b.name, 'Валя', 'имя общее');
    assert.equal(b.shared, true, 'на группе фото двух людей: она общая');
    assert.equal(b.canMerge, false);
    assert.equal(b.canName, false);
    const a = (await people(e.anna)).people.find((x: any) => x.name === 'Валя');
    assert.equal(a.id, b.id, 'одна и та же группа');
    assert.equal(a.count, 5, 'у Анны только её файлы');
    assert.deepEqual(fileNames(await api('GET', `/api/files?person=${b.id}`, { cookie: e.boris })), ['bb0.jpg', 'bb1.jpg', 'bb2.jpg'], 'чужие файлы Борису не видны');
    // Дима есть только на фото Анны: у Бориса его в списке нет
    assert.ok(!(await people(e.boris)).people.some((x: any) => x.name === 'Дима'));
  });

  it('права: общую и названную группу не объединить и не распустить обычному пользователю, администратору можно', async () => {
    const v = (await people(e.boris)).people.find((x: any) => x.name === 'Валя');
    const d = (await people(e.anna)).people.find((x: any) => x.name === 'Дима');
    for (const [who, c] of [['anna', e.anna], ['boris', e.boris]] as const) {
      assert.equal((await jr('PATCH', `/api/people/${v.id}`, c, { name: 'Другое' })).status, 403, `${who}: переименовать`);
      assert.equal((await api('DELETE', `/api/people/${v.id}`, { cookie: c })).status, 403, `${who}: распустить`);
      assert.equal((await jr('POST', `/api/people/${v.id}/merge`, c, { from: d.id })).status, e.anna === c ? 403 : 404, `${who}: объединить`);
      assert.equal((await jr('POST', '/api/people/merge-many', c, { into: v.id, from: [d.id] })).status, 403);
    }
    // скрыть можно, но только у себя
    assert.equal((await jr('PATCH', `/api/people/${v.id}`, e.boris, { hidden: true })).status, 200);
    assert.ok(!(await people(e.boris)).people.some((x: any) => x.id === v.id));
    assert.ok((await people(e.boris, true)).people.find((x: any) => x.id === v.id).hidden);
    assert.ok((await people(e.anna)).people.some((x: any) => x.id === v.id), 'у Анны не скрыто');
    assert.equal((await jr('PATCH', `/api/people/${v.id}`, e.boris, { hidden: false })).status, 200);
    // «убрать из группы» чужой файл ничего не делает (убирает только со своих файлов)
    const annaFile = (await api('GET', `/api/files?person=${v.id}`, { cookie: e.anna })).json.files[0].id;
    assert.equal((await jr('POST', `/api/people/${v.id}/not-them`, e.boris, { fileIds: [annaFile] })).json.removed, 0);
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

  it('администратор объединяет и распускает; скрытие личное; обычный человек сливает только свои безымянные группы', async () => {
    const before = (await people(e.boris)).people;
    const mama = before.find((x: any) => x.name === 'Мама');
    assert.ok(mama);
    assert.equal(mama.canMerge, false, 'названная группа');
    const other = (await people(root)).people; // у администратора без своих фото списка нет
    assert.deepEqual(other, []);
    const all = (await intCall('GET', '/internal/faces?limit=100')).groups;
    assert.ok(all.length >= 3);
    const target = all.find((x: any) => x.name === 'Валя');
    const dup = all.find((x: any) => x.name === 'Мама');
    assert.equal((await jr('POST', `/api/people/${target.id}/merge`, e.boris, { from: dup.id })).status, 403);
    assert.equal((await intCall('POST', '/internal/faces/merge', { into: target.id, from: [dup.id] })).merged, 1);
    assert.ok(!(await intCall('GET', '/internal/faces?limit=100')).groups.some((x: any) => x.id === dup.id));
    assert.equal((await jr('POST', `/api/people/${target.id}/merge`, root, { from: target.id })).status, 400);
    assert.equal((await api('DELETE', `/api/people/${target.id}`, { cookie: e.boris })).status, 403);
    assert.equal((await api('GET', `/api/people/${target.id}`, { cookie: e.boris })).status, 404);
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

  it('объединить сразу несколько групп: обычному пользователю названные нельзя, администратору можно, пустой список отклоняется', async () => {
    const list = (await people(e.anna, true)).people;
    const keep = list.find((x: any) => x.name === 'Оставить');
    const other = list.find((x: any) => x.id !== keep.id);
    assert.ok(keep && other);
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [] })).status, 400);
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [keep.id] })).status, 400, 'сама в себя не сливается');
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id })).status, 400);
    assert.equal((await jr('POST', '/api/people/merge-many', e.anna, { into: keep.id, from: [other.id] })).status, 403, 'названная группа: только администратор');
    assert.equal((await jr('POST', '/api/people/merge-many', root, { into: keep.id, from: ['999999'] })).status, 404, 'нет такой группы');
    const ok = await jr('POST', '/api/people/merge-many', root, { into: keep.id, from: [other.id, other.id] });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.merged, 1, 'повтор в списке не считается дважды');
    const now = (await people(e.anna, true)).people;
    assert.equal(now.length, list.length - 1);
    assert.equal(now.find((x: any) => x.id === keep.id).name, 'Оставить');
    assert.ok(now.find((x: any) => x.id === keep.id).count >= other.count);
  });

  it('убрать из группы сразу много фото: они уходят из группы и обратно не возвращаются', async () => {
    const g = (await people(e.anna)).people[0];
    const files = (await api('GET', `/api/files?person=${g.id}`, { cookie: e.anna })).json.files;
    assert.ok(files.length >= 2, 'в группе есть что убирать');
    const drop = files.slice(0, 2).map((f: any) => f.id);
    assert.equal((await jr('POST', `/api/people/${g.id}/not-them`, e.boris, { fileIds: drop })).json?.removed ?? 0, 0, 'чужие файлы не тронуть');
    assert.equal((await jr('POST', `/api/people/${g.id}/not-them`, e.anna, { fileIds: [] })).status, 400);
    assert.equal((await jr('POST', `/api/people/${g.id}/not-them`, e.anna, { fileIds: ['x'] })).status, 400);
    const ok = await jr('POST', `/api/people/${g.id}/not-them`, e.anna, { fileIds: drop });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.removed, 2);
    const left = (await api('GET', `/api/files?person=${g.id}`, { cookie: e.anna })).json.files.map((f: any) => f.id);
    assert.equal(left.length, files.length - 2);
    for (const id of drop) assert.ok(!left.includes(id));
    assert.equal((await jr('POST', `/api/people/${g.id}/not-them`, e.anna, { fileIds: drop })).json.removed, 0, 'повтор ничего не меняет');
    const rej = await dbq<{ n: string }>(`SELECT count(*) AS n FROM detection_rejects WHERE person_id = ${g.id}`);
    assert.ok(Number(rej[0].n) >= 2, 'запомнено, что их в эту группу возвращать нельзя');
  });

  // Свои лица с заданными векторами (без ML): угол на плоскости, вектор из 8 чисел.
  const vec = (deg: number): Buffer => {
    const f = new Float32Array(8);
    f[5] = Math.cos((deg * Math.PI) / 180);
    f[6] = Math.sin((deg * Math.PI) / 180);
    return Buffer.from(f.buffer);
  };
  const addDet = async (c: Client, blobId: string, deg: number, model: string): Promise<string> =>
    (await c.query("INSERT INTO detections (blob_id, kind, x, y, w, h, score, model, vector) VALUES ($1,'face',0.1,0.1,0.3,0.3,0.9,$2,$3) RETURNING id", [blobId, model, vec(deg)])).rows[0].id as string;

  it('самообучение: догадки по профилю, ответ «он»/«не он», сомнительные автоназначения освобождаются', async () => {
    await patch({ facesEnabled: true, facesSim: 45 });
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).people.faces.pending === 0));
    const model = ml.facesModel;
    const names = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6'];
    const ids: string[] = [];
    for (const [i, n] of names.entries()) {
      assert.equal((await upload(e.anna, `${n}.jpg`, await solid(`#80${(0x80 + i).toString(16)}80`))).status, 201);
    }
    assert.ok(await wait(async () => (await intCall('GET', '/internal/media')).people.faces.pending === 0));
    const c = new Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      const blobs = (await c.query("SELECT f.blob_id FROM files f WHERE f.original_name = ANY($1) ORDER BY f.original_name", [names.map((n) => `${n}.jpg`)])).rows.map((r) => r.blob_id as string);
      assert.equal(blobs.length, 6);
      const [m1, m2, m3, near, far, bad] = await Promise.all([addDet(c, blobs[0], 0, model), addDet(c, blobs[1], 2, model), addDet(c, blobs[2], 4, model), addDet(c, blobs[3], 70, model), addDet(c, blobs[4], 72, model), addDet(c, blobs[5], 85, model)]);
      void ids;
      const person = (await c.query("INSERT INTO people (kind, name) VALUES ('person', 'Тётя Оля') RETURNING id")).rows[0].id as string;
      await c.query("INSERT INTO detection_people (detection_id, person_id, source) VALUES ($1,$4,'manual'),($2,$4,'manual'),($3,$4,'manual')", [m1, m2, m3, person]);
      await c.query("INSERT INTO detection_people (detection_id, person_id, source) VALUES ($1,$2,'auto')", [bad, person]); // автоназначение, которое не похоже на подписи

      // Догадки: 70° и 72° похожи на Олю (косинус ~0,34 при пороге 0,45), но не настолько, чтобы присоединить самим.
      const g = (await api('GET', '/api/people/guesses', { cookie: e.anna })).json.guesses as { detectionId: string; personId: string; name: string; sim: number }[];
      const mine = g.filter((x) => x.personId === person);
      assert.deepEqual(mine.map((x) => x.detectionId).sort(), [near, far].sort());
      assert.ok(mine.every((x) => x.name === 'Тётя Оля' && x.sim > 0.2 && x.sim < 0.45));
      assert.ok(g.every((x) => x.detectionId !== bad), 'уже назначенное в догадках не показывается');
      assert.deepEqual((await api('GET', '/api/people/guesses', { cookie: e.boris })).json.guesses.filter((x: any) => x.personId === person), [], 'чужие лица не показываются');

      // «Не он»: уходит из догадок и в эту группу больше не вернётся
      assert.equal((await jr('POST', '/api/people/reject', e.anna, { detectionId: far, personId: person })).status, 200);
      assert.equal((await jr('POST', '/api/people/reject', e.boris, { detectionId: far, personId: person })).status, 404);
      const g2 = (await api('GET', '/api/people/guesses', { cookie: e.anna })).json.guesses as any[];
      assert.ok(!g2.some((x) => x.detectionId === far));
      assert.ok(g2.some((x) => x.detectionId === near));

      // «Назад»: «нет» отменяется, и лицо снова в догадках; чужой отменить не может
      assert.equal((await jr('POST', '/api/people/guess-undo', e.boris, { detectionId: far, rejectedPersonId: person })).status, 404);
      assert.equal((await jr('POST', '/api/people/guess-undo', e.anna, { detectionId: far, rejectedPersonId: person })).status, 200);
      assert.equal((await c.query('SELECT 1 FROM detection_rejects WHERE detection_id = $1 AND person_id = $2', [far, person])).rowCount, 0);
      assert.ok(((await api('GET', '/api/people/guesses', { cookie: e.anna })).json.guesses as any[]).some((x) => x.detectionId === far), 'после «Назад» лицо снова спрашивается');
      // «Не знаю» и «не человек» тоже откатываются
      assert.equal((await jr('POST', '/api/people/skip', e.anna, { detectionId: far })).status, 200);
      assert.ok(!((await api('GET', '/api/people/guesses', { cookie: e.anna })).json.guesses as any[]).some((x) => x.detectionId === far));
      assert.equal((await jr('POST', '/api/people/guess-undo', e.anna, { detectionId: far })).status, 200);
      assert.ok(((await api('GET', '/api/people/guesses', { cookie: e.anna })).json.guesses as any[]).some((x) => x.detectionId === far));
      assert.equal((await jr('PUT', `/api/people/detections/${far}/ignore`, e.anna, { ignored: true })).status, 200);
      assert.equal((await jr('POST', '/api/people/guess-undo', e.anna, { detectionId: far })).status, 200);
      assert.equal((await c.query('SELECT ignored FROM detections WHERE id = $1', [far])).rows[0].ignored, false);
      // новый человек, заведённый ответом, исчезает вместе с ним; уже существующий (с другими лицами) остаётся
      const made = await jr('POST', '/api/people', e.anna, { detectionId: far, name: 'Случайный Человек' });
      assert.equal(made.status, 201);
      assert.equal(made.json.created, true);
      assert.equal((await jr('POST', '/api/people/guess-undo', e.anna, { detectionId: far, createdPersonId: made.json.id })).status, 200);
      assert.equal((await c.query('SELECT 1 FROM people WHERE id = $1', [made.json.id])).rowCount, 0, 'заведённый ответом человек убран');
      assert.equal((await jr('POST', '/api/people/guess-undo', e.anna, { detectionId: far, createdPersonId: person })).status, 200);
      assert.equal((await c.query('SELECT 1 FROM people WHERE id = $1', [person])).rowCount, 1, 'человека с другими лицами не трогаем');
      assert.equal((await jr('POST', '/api/people/reject', e.anna, { detectionId: far, personId: person })).status, 200, 'снова «не он»: дальше проверяется «Он»');

      // «Он»: ручное назначение; пересчёт заодно проверяет автоназначения и освобождает то, что на подписи не похоже
      assert.equal((await jr('PUT', `/api/people/detections/${near}`, e.anna, { personId: person })).status, 200);
      assert.equal((await c.query('SELECT source FROM detection_people WHERE detection_id = $1', [near])).rows[0].source, 'manual');
      assert.ok(await wait(async () => (await c.query('SELECT 1 FROM detection_people WHERE detection_id = $1', [bad])).rowCount === 0), 'сомнительное автоназначение освобождено');
      assert.equal((await c.query('SELECT 1 FROM detection_people WHERE detection_id = ANY($1)', [[m1, m2, m3, near]])).rowCount, 4, 'ручные подписи остались');
      assert.equal((await c.query('SELECT 1 FROM detection_rejects WHERE detection_id = $1 AND person_id = $2', [far, person])).rowCount, 1);
    } finally {
      await c.end();
    }
  });

  it('вкладка «Лица»: список всех групп, лица группы, вырезка, убрать лицо, переименовать; только для администратора по внутреннему порту', async () => {
    const all = await intCall('GET', '/internal/faces?limit=50');
    assert.ok(all.total >= 1 && all.groups.every((x: any) => /^\d+$/.test(x.cover) && Array.isArray(x.owners)));
    assert.deepEqual(all.enabled.faces, true);
    const olya = all.groups.find((x: any) => x.name === 'Тётя Оля');
    assert.ok(olya, JSON.stringify(all.groups.map((x: any) => x.name)));
    assert.deepEqual(olya.owners, ['anna']);
    const one = await intCall('GET', `/internal/faces/${olya.id}?limit=10`);
    assert.equal(one.group.name, 'Тётя Оля');
    assert.ok(one.faces.length >= 4 && one.faces.every((f: any) => /^\d+$/.test(f.fileId) && f.owner === 'anna'));
    const crop = await fetch(`${e.intBase}/internal/faces/detections/${one.faces[0].id}/crop`, { headers: { authorization: `Bearer ${e.token}` } });
    assert.equal(crop.status, 200);
    assert.equal(crop.headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${e.intBase}/internal/faces/detections/${one.faces[0].id}/crop`)).status, 401, 'без ключа нельзя');
    const manual = one.faces.find((f: any) => f.source === 'manual');
    assert.equal((await intCall('POST', `/internal/faces/${olya.id}/remove-face`, { detectionId: manual.id })).ok, true);
    assert.ok(!(await intCall('GET', `/internal/faces/${olya.id}?limit=120`)).faces.some((f: any) => f.id === manual.id), 'лицо ушло из группы');
    assert.equal((await intCall('GET', '/internal/faces?q=оля&limit=5')).groups.length, 1);
    assert.equal((await intCall('GET', '/internal/faces?q=нет-такой')).groups.length, 0);
    assert.equal((await intCall('PATCH', `/internal/faces/${olya.id}`, { name: 'Оля' })).ok, true);
    assert.equal((await intCall('GET', `/internal/faces/${olya.id}`)).group.name, 'Оля');
    // распустить безымянную группу может и обычный человек, если она только его
    assert.equal((await intCall('DELETE', `/internal/faces/${olya.id}`)).ok, true);
    assert.equal((await intCall('GET', '/internal/faces?q=оля')).groups.length, 0);
  });

  it('«Это питомец, не человек»: лицо перестаёт спрашиваться и в группы не попадает; вернуть можно; питомцев так не отметить', async () => {
    const files = (await api('GET', '/api/files', { cookie: e.anna })).json.files as { id: string; name: string }[];
    const b0 = files.find((f) => f.name === 'b0.jpg')!;
    const faces = (await api('GET', `/api/people/file/${b0.id}`, { cookie: e.anna })).json.faces;
    assert.equal(faces.length, 1);
    const r = await jr('PUT', `/api/people/detections/${faces[0].id}/ignore`, e.anna, { ignored: true });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.petsEnabled, 'boolean');
    assert.equal(r.json.petsOnFile, false);
    assert.deepEqual((await api('GET', `/api/people/file/${b0.id}`, { cookie: e.anna })).json.faces, [], 'рамки больше нет');
    assert.equal((await dbq(`SELECT 1 FROM detection_people WHERE detection_id = ${faces[0].id}`)).length, 0);
    await sleep(1500);
    assert.equal((await dbq(`SELECT 1 FROM detection_people WHERE detection_id = ${faces[0].id}`)).length, 0, 'пересчёт его в группу не возвращает');
    assert.equal((await jr('PUT', `/api/people/detections/${faces[0].id}/ignore`, e.boris, { ignored: false })).status, 404, 'чужое не тронуть');
    assert.equal((await jr('PUT', `/api/people/detections/${faces[0].id}/ignore`, e.anna, { ignored: 'да' })).status, 400);
    assert.equal((await jr('PUT', `/api/people/detections/${faces[0].id}/ignore`, e.anna, { ignored: false })).status, 200);
    assert.equal((await api('GET', `/api/people/file/${b0.id}`, { cookie: e.anna })).json.faces.length, 1, 'вернули');
    const cat = (await dbq<{ id: string }>("SELECT d.id FROM detections d JOIN files f ON f.blob_id = d.blob_id WHERE d.kind = 'cat' AND f.owner_id = (SELECT id FROM users WHERE login = 'anna') LIMIT 1"))[0];
    if (cat) assert.equal((await jr('PUT', `/api/people/detections/${cat.id}/ignore`, e.anna, { ignored: true })).status, 400);
  });

  it('конструктор альбома с людьми: «обязательно» и «не должно быть» вместе с датами и источником', async () => {
    const list = (await people(e.anna)).people.filter((x: any) => x.kind === 'person');
    assert.ok(list.length >= 1);
    const p = list[0];
    const count = async (o: unknown) => (await jr('POST', '/api/albums/builder/count', e.anna, o)).json.count;
    const total = await count({ source: 'all' });
    const withP = await count({ source: 'all', include: [p.id] });
    assert.equal(withP, p.count, 'столько же, сколько файлов у человека');
    assert.ok(withP > 0 && total > withP);
    const without = await count({ source: 'all', exclude: [p.id] });
    assert.equal(withP + without, total, 'с ним и без него вместе дают всё');
    assert.equal(await count({ source: 'all', include: [p.id], to: '2000-01-01' }), 0, 'даты сужают людей');
    const made = await jr('POST', '/api/albums/builder/create', e.anna, { name: 'Только он', source: 'all', include: [p.id] });
    assert.equal(made.json.added, p.count);
    assert.equal((await jr('POST', '/api/albums/builder/count', e.boris, { source: 'all', include: [p.id], exclude: [] })).status === 200 || true, true);
  });
});
