export enum BookAssemblySourceType {
  MAIN_PLAN = 'main_plan',
  EDIT_REVISION = 'edit_revision',
  CHANGE_REVISION = 'change_revision',
}

export enum PartUploadStatus {
  PENDING = 'pending',
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum AssemblyDraftStatus {
  PREPARING = 'preparing',
  READY = 'ready',
  MERGED = 'merged',
  CANCELED = 'canceled',
}

export enum BookAssemblyVersionStatus {
  COMPLETED = 'completed',
  DEPRECATED = 'deprecated',
}

export enum CorrectionMode {
  CANCELLATION = 'cancellation',
  CORRECTION_PART1 = 'correction_part1',
  CORRECTION_PART2 = 'correction_part2',
  CORRECTION_PART3 = 'correction_part3',
}

export enum PartSource {
  UPLOADED = 'uploaded',
  GENERATED = 'generated',
  REUSED = 'reused',
}

export enum DeprecationAuditAction {
  SUCCESS = 'success',
  FAILED = 'failed',
  RESTORED = 'restored',
}

export enum BookProjectType {
  PROJECT_GROUP = 'project_group',
  REVISED_PROJECT_GROUP = 'revised_project_group',
}
