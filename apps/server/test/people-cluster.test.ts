// Сбор групп по сходству лиц без базы: как порог меняет число групп и как работают отказы.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupFree, MIN_GROUP } from '../src/files/people.service';

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
