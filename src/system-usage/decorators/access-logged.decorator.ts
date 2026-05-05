/**
 * W107-BE-PR2 — `@AccessLogged()` decorator.
 *
 * Marks a handler so that `AccessLogInterceptor` will write a row to
 * `stats_access_log` after a successful 2xx response.
 *
 * Decoupled from the interceptor by the metadata key constant so neither
 * file imports the other (avoids a circular-import footgun).
 *
 * §17.3 — this decorator never references a project / plan / book table.
 * §17.11 — there is no role-aware variant; all callers are logged uniformly.
 */

import { SetMetadata } from '@nestjs/common';

export const ACCESS_LOGGED_METADATA_KEY = 'system-usage:access-logged';

export const AccessLogged = (): MethodDecorator =>
  SetMetadata(ACCESS_LOGGED_METADATA_KEY, true);
