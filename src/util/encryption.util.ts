import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scrypt,
  createHmac,
} from 'crypto';
import { promisify } from 'util';
import * as dotenv from 'dotenv';

// Load environment variables at module level
dotenv.config();

const algorithm = process.env.ALGORITHM || ''
const secretKey = process.env.SECRET_KEY || ''
const salt = process.env.SALT || ''

// Validate that required environment variables are set
if (!secretKey) {
  throw new Error('SECRET_KEY environment variable is required');
}
if (!salt) {
  throw new Error('SALT environment variable is required');
}
if (!algorithm) {
  throw new Error('ALGORITHM environment variable is required');
}

async function generateKey(): Promise<Buffer> {
  return (await promisify(scrypt)(secretKey, salt, 32)) as Buffer;
}

export async function encryption(citizenId: string): Promise<string> {
  const iv = randomBytes(16);
  const key = await generateKey();
  const cipher = createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(citizenId, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

export async function decryption(encryptedData: string): Promise<string> {
  const [ivHex, encrypted] = encryptedData.split(':');
  const key = await generateKey();
  const decipher = createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function hashCitizenId(citizenId: string): string {
  return createHmac('sha256', secretKey)
    .update(citizenId)
    .digest('hex');
}
