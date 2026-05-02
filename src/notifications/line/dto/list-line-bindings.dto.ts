import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * W97-API-BINDINGS — Query DTO for `GET /admin/notifications/line-bindings`.
 *
 * Source of truth: docs/tasks/wave97/W97-API-BINDINGS.md §3.
 *
 * Notes:
 *   - `q` matches `users.firstname` / `users.lastname` / `users.email_hash`
 *     ONLY. It MUST NEVER match `lineUserId` (Q9 — PII reverse-lookup
 *     vector). The service layer enforces this; this DTO only validates
 *     length.
 *   - `forbidNonWhitelisted: true` is globally enabled in `main.ts`, so
 *     every accepted query param MUST be declared here.
 *   - Defaults: `status='active'`, `page=1`, `pageSize=50` — applied at
 *     the controller layer (after class-validator runs).
 */
export class ListLineBindingsQueryDto {
  @IsOptional()
  @IsString({ message: 'q ต้องเป็นข้อความ' })
  @MaxLength(100, { message: 'q ต้องมีความยาวไม่เกิน 100 ตัวอักษร' })
  q?: string;

  @IsOptional()
  @IsIn(['active', 'unlinked', 'all'], {
    message: "status ต้องเป็น 'active' / 'unlinked' / 'all'",
  })
  status?: 'active' | 'unlinked' | 'all';

  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null ? Number(value) : value,
  )
  @IsInt({ message: 'page ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'page ต้องมากกว่าหรือเท่ากับ 1' })
  @Max(10_000, { message: 'page ต้องไม่เกิน 10000' })
  page?: number;

  @IsOptional()
  @Transform(({ value }) =>
    value !== undefined && value !== null ? Number(value) : value,
  )
  @IsInt({ message: 'pageSize ต้องเป็นจำนวนเต็ม' })
  @Min(1, { message: 'pageSize ต้องมากกว่าหรือเท่ากับ 1' })
  @Max(100, { message: 'pageSize ต้องไม่เกิน 100' })
  pageSize?: number;

  @IsOptional()
  @IsUUID('4', { message: 'userId ต้องเป็น UUID' })
  userId?: string;
}
