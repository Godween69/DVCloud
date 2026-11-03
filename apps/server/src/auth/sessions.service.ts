import { HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Config } from '../config';
import { DbService } from '../db/db.service';
import { CONFIG } from '../tokens';
import { UserRow, UsersService } from '../users/users.service';
import { dummyHash, verifyPassword } from './password';

const MAX_FAILS_PER_LOGIN = 5; // за 15 минут
const MAX_FAILS_PER_IP = 30; // за 15 минут
const MAX_SESSION_DAYS = 90; // сессия не живёт дольше, даже если ею пользуются каждый день

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

@Injectable()
export class SessionsService {
  constructor(
    private readonly db: DbService,
    private readonly users: UsersService,
    @Inject(CONFIG) private readonly cfg: Config,
  ) {}

  // Проверка пароля с ограничением перебора. Сессию не создаёт: это нужно и для входа, и для подтверждения паролем в настройках.
  async checkCredentials(login: string, password: string, ip: string): Promise<UserRow> {
    const key = login.toLowerCase().slice(0, 64);
    await this.assertNotLocked(key, ip);
    const user = await this.users.findByLogin(key);
    const passwordOk = await verifyPassword(password, user ? user.password_hash : await dummyHash());
    if (!user || !passwordOk || user.disabled) {
      await this.recordFail(key, ip);
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    return user;
  }

  // Слишком много неудач за 15 минут по логину или по адресу: ответ 429.
  async assertNotLocked(key: string, ip: string): Promise<void> {
    await this.db.query("DELETE FROM login_attempts WHERE at < now() - interval '1 day'");
    const c = await this.db.query<{ by_login: string; by_ip: string }>(
      `SELECT (SELECT count(*) FROM login_attempts WHERE login = $1 AND at > now() - interval '15 minutes') AS by_login,
              (SELECT count(*) FROM login_attempts WHERE ip = $2 AND at > now() - interval '15 minutes') AS by_ip`,
      [key, ip],
    );
    if (Number(c.rows[0].by_login) >= MAX_FAILS_PER_LOGIN || Number(c.rows[0].by_ip) >= MAX_FAILS_PER_IP) {
      throw new HttpException('Слишком много попыток входа. Подождите 15 минут.', 429);
    }
  }

  async recordFail(key: string, ip: string): Promise<void> {
    await this.db.query('INSERT INTO login_attempts (login, ip) VALUES ($1, $2)', [key, ip]);
  }

  async clearFails(key: string): Promise<void> {
    await this.db.query('DELETE FROM login_attempts WHERE login = $1', [key]);
  }

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.query('INSERT INTO sessions (user_id, token_hash) VALUES ($1, $2)', [userId, sha256(token)]);
    return token;
  }

  // Вход без второго фактора (если он у человека не включён).
  async login(login: string, password: string, ip: string): Promise<{ token: string; user: UserRow }> {
    const user = await this.checkCredentials(login, password, ip);
    await this.clearFails(user.login);
    return { token: await this.createSession(user.id), user };
  }

  async authenticate(token: string | undefined): Promise<UserRow | null> {
    if (!token || token.length !== 43) return null;
    const hash = sha256(token);
    const r = await this.db.query<UserRow & { session_id: string }>(
      `SELECT u.*, s.id AS session_id
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND NOT u.disabled
          AND s.last_seen_at > now() - make_interval(days => $2)
          AND s.created_at > now() - make_interval(days => $3)`,
      [hash, this.cfg.sessionIdleDays, MAX_SESSION_DAYS],
    );
    const row = r.rows[0];
    if (!row) return null;
    await this.db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'", [row.session_id]);
    return row;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  }
}
