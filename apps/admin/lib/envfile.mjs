// Запись одной строки KEY='значение' в файл окружения: заменяет существующую или добавляет в конец.
export function upsertEnvLine(text, key, value) {
  if (value.includes("'") || value.includes('\n')) throw new Error('Недопустимое значение для файла окружения');
  const line = `${key}='${value}'`;
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) {
    lines[i] = line;
    return lines.join('\n');
  }
  return text.endsWith('\n') || text === '' ? `${text}${line}\n` : `${text}\n${line}\n`;
}
