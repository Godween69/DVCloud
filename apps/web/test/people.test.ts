import assert from 'node:assert/strict';
import test from 'node:test';
import { boxRect, faceLabel, mergePlan, sameName, sortGroups, suggest } from '../src/lib/people.ts';
import type { PeopleGroup } from '../src/types.ts';

const g = (id: string, name: string | null, kind: 'person' | 'pet', count = 1): PeopleGroup => ({ id, name, kind, hidden: false, count, cover: id });

test('подписи рамок', () => {
  assert.equal(faceLabel({ kind: 'face', name: 'Валя' }), 'Валя');
  assert.equal(faceLabel({ kind: 'face', name: null }), 'Кто это?');
  assert.equal(faceLabel({ kind: 'cat', name: null }), 'Чей кот?');
});

test('рамка считается от картинки с учётом сдвига окна', () => {
  const r = boxRect([0.5, 0.25, 0.1, 0.2], { left: 110, top: 60, width: 400, height: 200 }, { left: 10, top: 10, width: 800, height: 600 });
  assert.deepEqual(r, { left: 300, top: 100, width: 40, height: 40 });
});

test('подсказки: по типу, начало имени раньше вхождения', () => {
  const l = [g('1', 'Валя', 'person'), g('2', 'Наваль', 'person'), g('3', 'Ефим', 'pet'), g('4', null, 'person')];
  assert.deepEqual(suggest(l, 'ва', 'face').map((p) => p.id), ['1', '2']);
  assert.deepEqual(suggest(l, '', 'cat').map((p) => p.id), ['3']);
  assert.deepEqual(suggest(l, 'еф', 'face'), []);
});

test('то же имя без учёта регистра находит существующего', () => {
  const l = [g('1', 'Валя', 'person')];
  assert.equal(sameName(l, ' валя ', 'face')?.id, '1');
  assert.equal(sameName(l, 'валя', 'cat'), null);
  assert.equal(sameName(l, '', 'face'), null);
});

test('порядок групп: названные по числу файлов, потом безымянные', () => {
  const l = [g('1', null, 'person', 50), g('2', 'А', 'person', 3), g('3', 'Б', 'person', 9)];
  assert.deepEqual(sortGroups(l).map((p) => p.id), ['3', '2', '1']);
});

test('объединение пачкой: цель названная с большим числом файлов, пропадающие имена перечислены', () => {
  const l = [g('1', null, 'person', 80), g('2', 'Валя', 'person', 10), g('3', 'Ефим', 'person', 30), g('4', null, 'person', 5)];
  const plan = mergePlan(l)!;
  assert.equal(plan.into.id, '3');
  assert.deepEqual(plan.from.map((p) => p.id).sort(), ['1', '2', '4']);
  assert.deepEqual(plan.lostNames, ['Валя']);
});

test('объединение пачкой: без названных цель самая большая; одну группу или смесь людей и питомцев не объединить', () => {
  const l = [g('1', null, 'person', 8), g('2', null, 'person', 60)];
  assert.equal(mergePlan(l)!.into.id, '2');
  assert.deepEqual(mergePlan(l)!.lostNames, []);
  assert.equal(mergePlan([l[0]]), null);
  assert.equal(mergePlan([l[0], g('9', null, 'pet', 4)]), null);
});
