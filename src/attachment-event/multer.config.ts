import { memoryStorage } from 'multer';

export const multerConfig = {
  storage: memoryStorage(),
  fileFilter: (req, file, callback) => {
    // Allow all file types for now, but you can add restrictions here
    callback(null, true);
  },
};