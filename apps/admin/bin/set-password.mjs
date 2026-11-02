// Задаёт пароль администратора: спрашивает дважды (символы не видны), записывает только хеш в файл окружения.
// Запуск: node apps/admin/bin/set-password.mjs dvcloud.env
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { upsertEnvLine } from '../lib/envfile.mjs';
import { hashPassword } from '../lib/password.mjs';
import { readHidden } from '../lib/prompt.mjs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.error('Укажи существующий файл окружения, например: dvcloud.env');
  process.exit(1);
}
try {
  console.log('Пароль администратора: не короче 12 символов. При вводе символы не отображаются, это нормально.');
  const a = await readHidden('Новый пароль: ');
  if (a.length < 12) throw new Error('Пароль короче 12 символов. Ничего не записано.');
  const b = await readHidden('Повтори пароль: ');
  if (a !== b) throw new Error('Пароли не совпали. Ничего не записано.');
  // Файл перезаписывается на месте, права доступа (600) сохраняются.
  writeFileSync(file, upsertEnvLine(readFileSync(file, 'utf8'), 'DVCLOUD_ADMIN_PASSWORD_HASH', hashPassword(a)));
  console.log('Готово: хеш пароля записан в', file);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
