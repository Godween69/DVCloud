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
import { PeopleController } from './files/people.controller';
import { PeopleScanService } from './files/people-scan.service';
import { PeopleService } from './files/people.service';
import { VideoService } from './files/video.service';
import { MediaSettingsService } from './files/media-settings';
import { AdminMediaService } from './files/admin-media.service';
import { MlClient } from './files/ml-client';
import { EmbedService } from './files/embed.service';
import { SearchService } from './files/search.service';
import { SearchController } from './files/search.controller';
import { LoginClient } from './yandex/login.client';
import { YandexController } from './yandex/yandex.controller';
import { YandexService } from './yandex/yandex.service';
import { HealthController } from './health.controller';
import { InternalTokenGuard } from './internal/internal-token.guard';
import { InternalHealthController, InternalBackupController, InternalFacesController, InternalMediaController, InternalStorageController, InternalUsersController } from './internal/internal.controller';
import { AdminStorageService } from './files/admin-storage.service';
import { AdminDuplicatesService } from './files/admin-duplicates.service';
import { BackupService } from './files/backup.service';
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
      controllers: [HealthController, AuthController, SecurityController, FilesController, AlbumsController, ZipController, SimilarController, SearchController, PeopleController, UploadsController, YandexController],
      providers: [SessionGuard, ActivityService, StorageService, ThumbsService, VideoService, MediaSettingsService, MlClient, EmbedService, PeopleService, PeopleScanService, SearchService, FilesService, AlbumsService, FingerprintService, SimilarService, UploadsService, LoginClient, YandexService],
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
      controllers: [InternalHealthController, InternalUsersController, InternalStorageController, InternalMediaController, InternalFacesController, InternalBackupController],
      providers: [InternalTokenGuard, ActivityService, StorageForAdmin, AdminStorageService, AdminDuplicatesService, MediaSettingsService, MlClient, PeopleService, AdminMediaService, BackupService],
    };
  }
}
