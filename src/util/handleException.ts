import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

export function handleException(logger: Logger, error: any): never {
  // 1. Log the error using the provided logger instance
  logger.error(error.message, error.stack);

  // 2. Re-throw any NestJS HttpException as-is
  if (error instanceof HttpException) throw error;

  // 3. Handle specific database errors
  if (error instanceof QueryFailedError) {
    // '23505' is the error code for unique_violation in PostgreSQL
    if (error.driverError?.code === '23505') {
      throw new BadRequestException('Data with this value already exists.');
    }
  }

  // 4. Default to a generic internal server error
  throw new InternalServerErrorException(
    'An unexpected error occurred on the server.',
  );
}