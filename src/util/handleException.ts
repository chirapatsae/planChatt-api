import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
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
      const detail = error.driverError?.detail || '';
      const constraint = error.driverError?.constraint || '';
      
      // Parse the detail message to extract field name
      // PostgreSQL detail format: "Key (field_name)=(value) already exists."
      const detailMatch = detail.match(/Key \(([^)]+)\)=/);
      const fieldName = detailMatch ? detailMatch[1] : null;
      
      // Map database column names to user-friendly field names
      const fieldMapping: Record<string, string> = {
        'citizen_id': 'citizen ID',
        'citizen_id_hash': 'citizen ID',
        'email': 'email',
        'phone': 'phone number',
      };
      
      const friendlyFieldName = fieldName 
        ? (fieldMapping[fieldName] || fieldName)
        : 'field';
      
      const message = `${friendlyFieldName.charAt(0).toUpperCase() + friendlyFieldName.slice(1)} already exists.`;
      
      throw new BadRequestException(message);
    }
  }
  // 4. Default to a generic internal server error
  throw new InternalServerErrorException(
    'An unexpected error occurred on the server.',
  );
}
