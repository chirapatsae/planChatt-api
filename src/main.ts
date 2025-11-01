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
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // Security middleware - Helmet
  app.use(helmet());
  
  app.enableCors({
    origin: ['http://localhost:5173', 'https://watched-usage-facility-structural.trycloudflare.com'], 
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'Secret-Key'],
  });

  // Serve static files from uploads directory
  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });
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
