import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  ClassSerializerInterceptor,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import helmet from 'helmet';
import { join } from 'path';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as dotenv from 'dotenv';

// Load environment variables at the very beginning
dotenv.config();

async function bootstrap() {
  // `rawBody: true` enables `req.rawBody` (Buffer) on every request.
  // Required by W86 LINE webhook signature verification — the HMAC is
  // computed over the EXACT bytes LINE transmitted, not a re-stringified
  // parsed JSON. See `backend/src/line/line-signature.guard.ts`.
  // Memory cost is bounded by the body parser limit and is paid only
  // for routes that read `req.rawBody`; standard JSON handling on every
  // other route is unaffected.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  // Security middleware - Helmet
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "frame-ancestors": ["'self'", "http://localhost:5173", "https://pb.koratpao.go.th", "http://pb.thaiakitech.co.th:8080"],
      },
    },
  }));

  app.enableCors({
    origin: ['http://localhost:5173', 'https://pb.koratpao.go.th', 'http://pb.thaiakitech.co.th:8080'],
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'Secret-Key'],
  });
  app.set('trust proxy', true);
  // Serve static files from uploads directory.
  //
  // BE-IMPL-01 P2-A — UUID-based filenames change per upload, so URLs
  // are version-safe and we can declare profile-image responses
  // immutable. The header is scoped to the `profiles/` subfolder via
  // `setHeaders`. Other subfolders (event attachments, etc.) get the
  // Express default (no `Cache-Control`) so we do not over-cache
  // content with mutable URLs.
  // Use `process.cwd()` (= `backend/`) instead of `__dirname + '..'`
  // because `nest start --watch` compiles to `dist/src/main.js` and
  // `__dirname + '..'` would resolve to `dist/uploads` (empty) instead
  // of the actual `backend/uploads` where files are stored. Mirrors the
  // public assets pattern on the next call.
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
    setHeaders: (res, filePath) => {
      // Normalize separator for cross-platform safety.
      const normalized = filePath.replace(/\\/g, '/');
      if (normalized.includes('/uploads/profiles/')) {
        res.setHeader(
          'Cache-Control',
          'public, max-age=31536000, immutable',
        );
      }
    },
  });
  // Serve public assets (LINE flex icons, brand logos) at root so URLs like
  // `${APP_URL}/line-icons/project-submitted-owner.png` resolve. Used by the
  // LINE Flex template renderer (FlexRenderContext.iconBase).
  //
  // Uses `process.cwd()` (= `backend/`) instead of `__dirname` because the
  // app boots from `dist/src/main.js` — `__dirname + '..'` would resolve to
  // `dist/public` which does not exist after `nest build`.
  app.useStaticAssets(join(process.cwd(), 'public'));
  app.enableVersioning({
    type: VersioningType.URI,
  });
  app.setGlobalPrefix('api');
  // main.ts
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // ลบ field ที่ไม่ได้อยู่ใน DTO
      forbidNonWhitelisted: true, // ถ้ามี field แปลก จะ throw error
      forbidUnknownValues: true, // ป้องกัน unknown values
      transform: true, // แปลง string เป็น number อัตโนมัติถ้า type ตรง
      transformOptions: {
        enableImplicitConversion: true, // แปลง string เป็น number อัตโนมัติถ้า type ตรง
      }
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
