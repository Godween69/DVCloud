// Сбор групп по сходству лиц без базы: как порог меняет число групп и как работают отказы.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProfile, groupFree, MARGIN, MIN_GROUP, profileScore } from '../src/files/people.service';

// Вектор на единичной окружности: косинус между двумя равен cos(разницы углов).
const at = (deg: number): Float32Array => new Float32Array([Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)]);
const row = (n: number, step: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: String(from + i + 1), v: at((from + i) * step) }));

test('чем строже порог, тем больше групп; при мягком порогe лица сливаются', async () => {
  const free = row(12, 12); // от 0 до 132 градусов, соседи похожи на 0,978
  const count = async (t: number) => (await groupFree(free, new Map(), new Map(), t)).fresh.filter((g) => g.dets.length >= MIN_GROUP).length;
  const strict = await count(0.99), mid = await count(0.9), loose = await count(0.3);
  assert.equal(strict, 0, 'при 0,99 каждое лицо само по себе: групп из трёх нет');
  assert.ok(mid >= loose, `строже не бывает меньше групп: ${mid} против ${loose}`);
  assert.ok(loose >= 1 && loose <= 2, `при 0,3 почти всё в одной группе: ${loose}`);
  const all = (await groupFree(free, new Map(), new Map(), 0.3)).fresh.reduce((n, g) => n + g.dets.length, 0);
  assert.equal(all, 12, 'ни одно лицо не теряется');
});

test('лица идут к существующей группе, если похожи на её центр, и не идут, если человек отказал', async () => {
  const cent = new Map([['7', at(0)]]);
  const free = [{ id: '1', v: at(5) }, { id: '2', v: at(80) }, { id: '3', v: at(8) }];
  const r = await groupFree(free, cent, new Map([['3', new Set(['7'])]]), 0.5);
  assert.deepEqual(r.toExisting, [{ det: '1', person: '7' }], 'лицо 2 далеко, лицо 3 отклонено для этой группы');
  assert.deepEqual(r.fresh.map((g) => g.dets).sort(), [['2'], ['3']]);
});

// ── Профили людей: эталоны, порог человека, запас до второго ──
test('человек с двумя разными видами (0° и 90°): центр между ними не узнаёт, эталоны узнают', () => {
  const vs = [...Array.from({ length: 12 }, (_, i) => at(i)), ...Array.from({ length: 12 }, (_, i) => at(90 + i))];
  const pr = buildProfile(vs, 0.8);
  assert.ok(pr.protos.length >= 2, `эталонов: ${pr.protos.length}`);
  const probe = at(96);
  const centerOnly = Math.cos((51 * Math.PI) / 180); // центр лежит около 50°
  assert.ok(centerOnly < 0.8);
  assert.ok(profileScore(pr, probe) >= 0.8, `по эталону узнан: ${profileScore(pr, probe)}`);
});

test('порог человека: у тех, чьи лица почти одинаковы, строже; у разных на фото мягче; границы T-0,05 и T+0,08', () => {
  const tight = buildProfile(Array.from({ length: 20 }, (_, i) => at(i * 0.2)), 0.45);
  const loose = buildProfile(Array.from({ length: 20 }, (_, i) => at(i * 8)), 0.45);
  const few = buildProfile([at(0), at(2)], 0.45);
  assert.ok(Math.abs(tight.thr - 0.53) < 1e-6, `строже, но не выше T+0,08: ${tight.thr}`);
  assert.ok(loose.thr < tight.thr && loose.thr >= 0.4 - 1e-6, `мягче: ${loose.thr}`);
  assert.equal(few.thr, 0.45, 'мало примеров: общий порог');
});

test('запас до второго: лицо посередине между двумя людьми остаётся свободным, ясное присоединяется', async () => {
  const mk = (deg: number, n = 12) => buildProfile(Array.from({ length: n }, (_, i) => at(deg + (i % 3))), 0.45);
  const profiles = new Map([['1', mk(0)], ['2', mk(20)]]);
  const free = [{ id: 'near1', v: at(-5) }, { id: 'between', v: at(11) }];
  const r = await groupFree(free, new Map(), new Map(), 0.45, profiles);
  assert.deepEqual(r.toExisting, [{ det: 'near1', person: '1' }]);
  assert.deepEqual(r.unsure, ['between']);
  assert.ok(MARGIN > 0);
  assert.deepEqual(r.fresh, [], 'сомнительное не заводит новую группу');
});
