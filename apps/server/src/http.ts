// Мелкие помощники для разбора запросов (без внешних библиотек валидации).
import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request } from 'express';

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Ожидается JSON-объект');
  }
  return body as Record<string, unknown>;
}

export function strField(o: Record<string, unknown>, name: string, min: number, max: number): string {
  const v = o[name];
  if (typeof v !== 'string' || v.length < min || v.length > max) {
    throw new BadRequestException(`Поле ${name}: строка длиной от ${min} до ${max}`);
  }
  return v;
}

export function optStrField(o: Record<string, unknown>, name: string, min: number, max: number): string | undefined {
  return o[name] === undefined ? undefined : strField(o, name, min, max);
}

// Изменяющие запросы принимаются только как JSON: так чужой сайт не отправит их из формы.
export function requireJson(req: Request): void {
  if (!req.is('application/json')) {
    throw new UnsupportedMediaTypeException('Нужен Content-Type: application/json');
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
