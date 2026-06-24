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

// Env var loading is owned exclusively by `ConfigModule.forRoot(...)` in
// `app.module.ts` — it loads `.env.${NODE_ENV}` (e.g. `.env.development`
// or `.env.production`). The legacy `dotenv.config()` + `.env` fallback
// was removed (2026-05-17) after diff confirmed `.env` had zero unique
// vars vs the env-specific files; keeping the fallback hid which file
// was actually authoritative at runtime.

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

  // ── CORS allow-list (2026-05-29) ──────────────────────────────────
  // Source of truth: `CORS_ALLOWED_ORIGINS` env var (comma-separated
  // exact-match origins). Falls back to a hard-coded list so dev / known
  // production origins always work even when the env is missing. Empty
  // string entries are filtered out so a trailing comma doesn't allow
  // `''` origin (which Chromium emits for some cross-origin contexts).
  //
  // Production fix 2026-05-29 — moved from purely hard-coded list so a
  // new public origin can be added by ops without a code change /
  // redeploy. Mismatched origins are LOGGED at WARN level (not just
  // silently 403'd) so CORS issues are diagnosable from logs.
  const defaultAllowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'https://pb.koratpao.go.th',
    'http://pb.thaiakitech.co.th:8080',
    'http://pb.thaiakitech.co.th',          // proxy may rewrite without port
    'https://pb.thaiakitech.co.th',         // https variant
    'https://pb.thaiakitech.co.th:8080',
  ];
  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))   // strip trailing slash
    .filter(Boolean);
  const allowedOrigins = Array.from(
    new Set([...defaultAllowedOrigins, ...envOrigins]),
  );

  // Security middleware - Helmet
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "frame-ancestors": ["'self'", ...allowedOrigins],
      },
    },
  }));

  app.enableCors({
    // Use a callback so we can log rejections — easier to debug than a
    // bare array (which 403s silently). The callback also tolerates an
    // empty `origin` (same-origin / curl) by allowing the request.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);                 // same-origin / non-browser
      const normalized = origin.replace(/\/$/, '');
      if (allowedOrigins.includes(normalized)) {
        return callback(null, true);
      }
      // eslint-disable-next-line no-console
      console.warn(`[CORS] rejected origin: ${origin}`);
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'Secret-Key'],
    optionsSuccessStatus: 204,                                  // some legacy proxies need 204 on OPTIONS
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
