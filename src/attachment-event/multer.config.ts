import { memoryStorage } from 'multer';
import { BadRequestException } from '@nestjs/common';

// Fix V3: Allowlist of accepted MIME types for attachment uploads
// see security-review-book-assembly.md
const ALLOWED_MIME_TYPES = [
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Archives
  'application/zip',
  'application/x-rar-compressed',
];

export const multerConfig = {
  storage: memoryStorage(),
  fileFilter: (
    req: any,
    file: Express.Multer.File,
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      callback(
        new BadRequestException(
          `ประเภทไฟล์ไม่รองรับ: ${file.mimetype}`,
        ),
        false,
      );
      return;
    }
    callback(null, true);
  },
};