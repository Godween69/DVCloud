import { DynamicModule, Global, Module } from '@nestjs/common';
import { AuthController } from './auth/auth.controller';
import { SecurityController } from './auth/security.controller';
import { DvAuthClient } from './auth/dvauth.client';
import { SessionGuard } from './auth/session.guard';
import { SessionsService } from './auth/sessions.service';
import { Config } from './config';
import { AuditService } from './db/audit.service';
import { DbService } from './db/db.service';
import { AlbumsController, ZipController } from './files/albums.controller';
import { AlbumsService } from './files/albums.service';
import { ActivityService } from './files/activity.service';
import { UploadsController } from './files/uploads.controller';
import { UploadsService } from './files/uploads.service';
import { FilesController } from './files/files.controller';
import { FingerprintService } from './files/fingerprint.service';
import { SimilarController } from './files/similar.controller';
import { SimilarService } from './files/similar.service';
import { FilesService } from './files/files.service';
import { StorageService } from './files/storage.service';
import { ThumbsService } from './files/thumbs.service';
import { HealthController } from './health.controller';
import { InternalTokenGuard } from './internal/internal-token.guard';
import { InternalHealthController, InternalStorageController, InternalUsersController } from './internal/internal.controller';
import { AdminStorageService } from './files/admin-storage.service';
import { StorageService as StorageForAdmin } from './files/storage.service';
import { CONFIG } from './tokens';
import { UsersService } from './users/users.service';

// Общие службы: конфигурация, база, люди, сессии. Одни и те же для публичного и внутреннего порта.
@Global()
@Module({})
export class CoreModule {
  static forRoot(cfg: Config): DynamicModule {
    const providers = [{ provide: CONFIG, useValue: cfg }, DbService, AuditService, UsersService, SessionsService, DvAuthClient];
    return { module: CoreModule, providers, exports: providers.map((p) => (typeof p === 'function' ? p : p.provide)) };
  }
}

// Публичный порт: вход, выход, кто я, состояние, файлы.
@Module({})
export class AppModule {
  static forRoot(cfg: Config): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(cfg)],
      controllers: [HealthController, AuthController, SecurityController, FilesController, AlbumsController, ZipController, SimilarController, UploadsController],
      providers: [SessionGuard, ActivityService, StorageService, ThumbsService, FilesService, AlbumsService, FingerprintService, SimilarService, UploadsService],
    };
  }
}

// Внутренний порт: управление людьми для локальной админки.
@Module({})
export class InternalModule {
  static forRoot(cfg: Config): DynamicModule {
    return {
      module: InternalModule,
      imports: [CoreModule.forRoot(cfg)],
      controllers: [InternalHealthController, InternalUsersController, InternalStorageController],
      providers: [InternalTokenGuard, StorageForAdmin, AdminStorageService],
    };
  }
}
