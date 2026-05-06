import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class StorageService {
    private readonly logger = new Logger(StorageService.name);

    // Set the base upload directory at project root
    private readonly baseUploadDir = path.join(process.cwd(), 'uploads');

    constructor() {
        this.ensureDirectoryExists(this.baseUploadDir);
    }

    /**
     * Saves a file locally and returns the relative path/URL to be served statically.
     * @param file The Multer file object
     * @param folder The subfolder name (e.g. 'profiles')
     * @param overrideExt Optional sniffed extension (e.g. '.jpg') from a
     *   magic-byte check. When provided, this is used instead of
     *   `path.extname(file.originalname)`. Callers that perform a sniff
     *   (e.g. UsersService.uploadProfileImage) MUST pass the sniffed
     *   extension to close the rename-extension attack (BE-IMPL-01 P2-E).
     * @returns The relative URL path (e.g. '/uploads/profiles/some-uuid.jpg')
     */
    async saveFile(
        file: Express.Multer.File,
        folder: string,
        overrideExt?: string,
    ): Promise<string> {
        try {
            const folderPath = path.join(this.baseUploadDir, folder);
            this.ensureDirectoryExists(folderPath);

            // Prefer caller-provided sniffed extension (BE-IMPL-01 P0-3 / P2-E);
            // fall back to originalname's extension only when the caller has
            // not sniffed.
            const extension = overrideExt
                ? overrideExt.toLowerCase()
                : path.extname(file.originalname).toLowerCase();
            // Generate a unique filename: uuid + extension
            const filename = `${uuidv4()}${extension}`;
            const filePath = path.join(folderPath, filename);

            // Write file buffer to disk
            await fs.promises.writeFile(filePath, file.buffer);

            this.logger.log(`File saved locally: ${filePath}`);

            // Return the public URL path
            // Note: NestJS useStaticAssets maps /uploads to the physical 'uploads' folder
            return `/uploads/${folder}/${filename}`;
        } catch (error) {
            this.logger.error(`Error saving file locally`, error);
            throw new InternalServerErrorException('Failed to save file');
        }
    }

    /**
     * Helper to ensure directories exist before writing
     */
    private ensureDirectoryExists(dirPath: string) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }

    /**
     * Helper to delete file if it exists (useful for replacing images to save space)
     * @param fileUrl The URL of the file stored in the DB (e.g. '/uploads/profiles/xxx.jpg')
     */
    async deleteFileIfExist(fileUrl: string | null | undefined): Promise<void> {
        if (!fileUrl) return;

        try {
            // Assuming fileUrl matches '/uploads/...'
            const relativePath = fileUrl.replace(/^\/uploads\//, '');
            const fullPath = path.join(this.baseUploadDir, relativePath);

            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
                this.logger.log(`Deleted file locally: ${fullPath}`);
            }
        } catch (error) {
            this.logger.warn(`Failed to delete file: ${fileUrl}`, error);
        }
    }
}
