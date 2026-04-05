/**
 * Upload part validation — this DTO is intentionally minimal because the file
 * arrives via multipart/form-data (not JSON body). Validation on the file itself
 * (must be PDF, must not be empty) is handled in the controller/service layer.
 *
 * Route params (sourceType, sourceId, partNumber) are validated by pipe + enum.
 */
export class UploadPartParams {
  /** Validated via ParseIntPipe + range check in the service */
  partNumber: number;
}
