import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * W97-API-BINDINGS — Body DTO for
 * `POST /admin/notifications/line-bindings/:id/reveal`.
 *
 * Source of truth: docs/tasks/wave97/W97-API-BINDINGS.md §3.
 *
 * `purpose` is the operator's textual justification for unmasking. It is
 * persisted in `line_binding_admin_actions.reason` (the column does
 * double-duty for both the force-unlink reason and the reveal purpose;
 * the DB CHECK only enforces 12..200 on the force-unlink branch, so the
 * application layer enforces 12..200 here too).
 *
 * `purpose` is operator free text; downstream consumers MUST escape on
 * render. Stored verbatim for audit fidelity.
 */
export class RevealLineBindingBodyDto {
  @IsString({ message: 'purpose ต้องเป็นข้อความ' })
  @MinLength(12, { message: 'purpose ต้องมีความยาวอย่างน้อย 12 ตัวอักษร' })
  @MaxLength(200, { message: 'purpose ต้องมีความยาวไม่เกิน 200 ตัวอักษร' })
  purpose: string;
}
