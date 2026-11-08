import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MEDIA, parseMediaPatch, videoParams } from '../src/files/media-settings';

test('настройки: по умолчанию превью включены, перекодирование видео выключено', () => {
  assert.equal(DEFAULT_MEDIA.previewEnabled, true);
  assert.equal(DEFAULT_MEDIA.videoEnabled, false);
  assert.equal(DEFAULT_MEDIA.previewMaxSide, 2000);
});

test('настройки: допустимое изменение проходит', () => {
  assert.deepEqual(parseMediaPatch({ previewMaxSide: 1600, previewQuality: 75, videoHeight: 1080, videoEnabled: true }), {
    previewMaxSide: 1600,
    previewQuality: 75,
    videoHeight: 1080,
    videoEnabled: true,
  });
});

test('настройки: значения вне границ и чужие поля отклоняются', () => {
  for (const bad of [{ previewMaxSide: 100 }, { previewMaxSide: 5000 }, { previewQuality: 20 }, { previewQuality: 80.5 }, { videoHeight: 700 }, { videoCrf: 40 }, { previewEnabled: 'да' }, { hack: 1 }, { timezone: 'Нигде/Никогда' }, { timezone: 5 }, null, [1]]) {
    assert.throws(() => parseMediaPatch(bad), /./, JSON.stringify(bad));
  }
});

test('настройки: метка параметров видео', () => {
  assert.equal(videoParams({ videoHeight: 720, videoCrf: 28 }), '720-28');
});

test('настройки: поиск по смыслу по умолчанию выключен, порог 80 процентов', () => {
  assert.equal(DEFAULT_MEDIA.searchEnabled, false);
  assert.equal(DEFAULT_MEDIA.searchCutoff, 80);
  assert.deepEqual(parseMediaPatch({ searchEnabled: true, searchCutoff: 60 }), { searchEnabled: true, searchCutoff: 60 });
  for (const bad of [{ searchEnabled: 1 }, { searchCutoff: 49 }, { searchCutoff: 96 }, { searchCutoff: 70.5 }, { searchCutoff: '80' }]) {
    assert.throws(() => parseMediaPatch(bad), /./, JSON.stringify(bad));
  }
});
