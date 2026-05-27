/**
 * Empty body — caller is identified by JWT.
 *
 * Defined as a class (not `Record<string, never>`) so the controller
 * decorator chain (`@Body()`) stays uniform across endpoints and Nest's
 * validation pipe has a target type to whitelist against.
 */
export class TotpEnrollInitDto {}
