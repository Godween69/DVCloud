import sharp from 'sharp';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { MlClient, MlError } from '../src/files/ml-client';
import { FakeMl } from './helpers/fakeml';

const cfg = (url: string) => loadConfig({ DVCLOUD_DATABASE_URL: 'postgres://x', DVCLOUD_INTERNAL_TOKEN: 'x'.repeat(32), DVCLOUD_ML_URL: url });

test('клиент ML: без адреса служба не настроена, health пуст, запрос даёт ошибку', async () => {
  const c = new MlClient(cfg(''));
  assert.equal(c.configured, false);
  assert.equal(await c.health(), null);
  await assert.rejects(() => c.text('x'), (e: unknown) => e instanceof MlError && e.unavailable);
});

test('клиент ML: вектор приходит буфером float32, ошибки разделены на «плохой запрос» и «служба недоступна»', async () => {
  const ml = new FakeMl();
  await ml.start();
  try {
    const c = new MlClient(cfg(ml.url));
    assert.deepEqual(await c.health(), { model: 'fake-color-v1', ready: true, faces: { ready: true, model: 'fake-faces-v1' }, pets: { ready: true, model: 'fake-pets-v1' } });
    const v = await c.text('красный');
    assert.equal(v.vector.length, 16);
    assert.equal(v.model, 'fake-color-v1');
    const f = await c.faces(await sharp({ create: { width: 40, height: 40, channels: 3, background: '#ff0000' } }).jpeg().toBuffer());
    assert.equal(f.model, 'fake-faces-v1');
    assert.equal(f.detections.length, 1);
    assert.equal(f.detections[0].kind, 'face');
    assert.equal(f.detections[0].vector.length, 32);
    const p = await c.pets(await sharp({ create: { width: 40, height: 40, channels: 3, background: '#f0f000' } }).jpeg().toBuffer());
    assert.deepEqual(p.detections.map((d) => d.kind), ['cat']);
    await assert.rejects(() => c.faces(Buffer.from('не картинка')), (e: unknown) => e instanceof MlError && e.status === 400 && !e.unavailable);
    await assert.rejects(() => c.image(Buffer.from('не картинка')), (e: unknown) => e instanceof MlError && e.status === 400 && !e.unavailable);
    ml.ready = false;
    assert.deepEqual(await c.health(), { model: 'fake-color-v1', ready: false, faces: { ready: true, model: 'fake-faces-v1' }, pets: { ready: true, model: 'fake-pets-v1' } });
  } finally {
    await ml.stop();
  }
  const dead = new MlClient(cfg(ml.url));
  assert.equal(await dead.health(), null, 'после остановки службы health пуст');
  await assert.rejects(() => dead.text('x'), (e: unknown) => e instanceof MlError && e.status === 0 && e.unavailable);
});
