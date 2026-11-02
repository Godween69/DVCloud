import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { generatePassword, hashPassword } from '../auth/password';

export interface UserRow {
  id: string;
  login: string;
  display_name: string;
  password_hash: string;
  is_admin: boolean;
  disabled: boolean;
  quota_bytes: string | null;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  login: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  quotaBytes: number | null;
  createdAt: string;
}

export const LOGIN_RE = /^[a-z0-9_]{2,32}$/;

// Пароль и хеш наружу не отдаются никогда.
export function toPublic(u: UserRow): PublicUser {
  return {
    id: u.id,
    login: u.login,
    displayName: u.display_name,
    isAdmin: u.is_admin,
    disabled: u.disabled,
    quotaBytes: u.quota_bytes === null ? null : Number(u.quota_bytes),
    createdAt: u.created_at.toISOString(),
  };
}

function checkPassword(p: string): void {
  if (p.length < 10 || p.length > 200) throw new BadRequestException('Пароль: от 10 до 200 символов');
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async findByLogin(login: string): Promise<UserRow | null> {
    const r = await this.db.query<UserRow>('SELECT * FROM users WHERE login = $1', [login]);
    return r.rows[0] ?? null;
  }

  async list(): Promise<UserRow[]> {
    return (await this.db.query<UserRow>('SELECT * FROM users ORDER BY id')).rows;
  }

  // Если пароль не передан, сервер придумывает его сам и возвращает один раз.
  async create(login: string, displayName: string, password?: string): Promise<{ user: UserRow; generatedPassword?: string }> {
    if (!LOGIN_RE.test(login)) {
      throw new BadRequestException('Логин: 2-32 символа, только a-z, 0-9 и _');
    }
    if (displayName.trim().length < 1 || displayName.length > 64) {
      throw new BadRequestException('Имя: от 1 до 64 символов');
    }
    if (password !== undefined) checkPassword(password);
    const plain = password ?? generatePassword();
    const hash = await hashPassword(plain);
    try {
      const r = await this.db.query<UserRow>(
        'INSERT INTO users (login, display_name, password_hash) VALUES ($1, $2, $3) RETURNING *',
        [login, displayName.trim(), hash],
      );
      return { user: r.rows[0], generatedPassword: password === undefined ? plain : undefined };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ConflictException('Такой логин уже есть');
      throw e;
    }
  }

  async update(login: string, patch: { disabled?: boolean; quotaBytes?: number | null }): Promise<UserRow> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.disabled !== undefined) {
      vals.push(patch.disabled);
      sets.push(`disabled = $${vals.length}`);
    }
    if (patch.quotaBytes !== undefined) {
      vals.push(patch.quotaBytes);
      sets.push(`quota_bytes = $${vals.length}`);
    }
    if (!sets.length) throw new BadRequestException('Нечего менять');
    vals.push(login);
    const r = await this.db.query<UserRow>(`UPDATE users SET ${sets.join(', ')} WHERE login = $${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) throw new NotFoundException('Нет такого человека');
    if (patch.disabled === true) await this.db.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
    return r.rows[0];
  }

  // Смена пароля завершает все сессии этого человека.
  async resetPassword(login: string, password?: string): Promise<{ generatedPassword?: string }> {
    if (password !== undefined) checkPassword(password);
    const plain = password ?? generatePassword();
    const r = await this.db.query<UserRow>('UPDATE users SET password_hash = $1 WHERE login = $2 RETURNING id', [
      await hashPassword(plain),
      login,
    ]);
    if (!r.rows[0]) throw new NotFoundException('Нет такого человека');
    await this.db.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
    return { generatedPassword: password === undefined ? plain : undefined };
  }
}
