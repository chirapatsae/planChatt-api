import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ClassSerializerInterceptor, ValidationPipe, VersioningType } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ['http://localhost:5173', 'https://9094fafecec2.ngrok-free.app'], // ✅ ระบุให้ตรง
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'Secret-Key'], // ✅ สำหรับ custom header
  });
  app.enableVersioning({
    type: VersioningType.URI,
  });
  app.setGlobalPrefix('api');
  // main.ts
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, // ลบ field ที่ไม่ได้อยู่ใน DTO
    forbidNonWhitelisted: true, // ถ้ามี field แปลก จะ throw error
    transform: true, // แปลง string เป็น number อัตโนมัติถ้า type ตรง
  }));
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

