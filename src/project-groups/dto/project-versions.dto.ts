import { IUnifiedProjectDisplay } from './unified-project-display.dto';

/**
 * Response DTO สำหรับแสดงประวัติทุก version ของโครงการ
 */
export interface IProjectVersionsResponse {
  // โครงการแม่ (ต้นฉบับ)
  originalProject: IUnifiedProjectDisplay | null;
  
  // รายการ revision ทั้งหมด (เรียงตาม revisionNumber)
  revisions: IUnifiedProjectDisplay[];
  
  // จำนวน version ทั้งหมด (รวมแม่)
  totalVersions: number;
  
  // ข้อมูล version ล่าสุด
  latestVersion: {
    id: string;
    revisionNumber?: number;
    isOriginal: boolean;
  } | null;
}

