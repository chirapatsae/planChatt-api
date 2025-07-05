# Admin Responsibilities Management

## Overview
ระบบจัดการความรับผิดชอบของ admin สำหรับอำเภอต่างๆ โดยใช้ junction entity `WorkHistoryAmphoeResponsibility` เพื่อเก็บข้อมูลเพิ่มเติม

## Architecture

### Entities
- **WorkHistory**: เก็บประวัติการทำงานของ user
- **Amphoe**: ข้อมูลอำเภอ
- **WorkHistoryAmphoeResponsibility**: Junction entity เก็บข้อมูลความรับผิดชอบ

### Junction Entity Fields
```typescript
{
  id: string;                    // Primary key
  workHistory: WorkHistory;      // Reference to work history (admin ที่รับผิดชอบ)
  amphoe: Amphoe;                // Reference to amphoe
  assignedByWorkHistory?: WorkHistory; // workHistory ที่เป็นคน assign (optional)
  createdAt: Date;               // วันที่สร้าง record
}
```

## API Endpoints

### Responsibilities Management

#### 1. เพิ่มความรับผิดชอบ
```http
POST /api/v1/work-history/responsibilities
Authorization: Bearer <token>

{
  "workHistoryId": "uuid",           // admin workHistory ที่รับผิดชอบ
  "amphoeId": "uuid",                // อำเภอที่รับผิดชอบ
  "assignedByWorkHistoryId": "uuid"  // (optional) workHistory ที่เป็นคน assign
}
```

#### 2. อัปเดตความรับผิดชอบ (เปลี่ยน assignedByWorkHistory ได้)
```http
PATCH /api/v1/work-history/responsibilities/:id
Authorization: Bearer <token>

{
  "assignedByWorkHistoryId": "uuid"
}
```

#### 3. ลบความรับผิดชอบ
```http
DELETE /api/v1/work-history/responsibilities/:id
Authorization: Bearer <token>
```

#### 4. ดึงความรับผิดชอบตาม Work History
```http
GET /api/v1/work-history/responsibilities/work-history/:workHistoryId
Authorization: Bearer <token>
```

#### 5. ดึงความรับผิดชอบตาม Amphoe
```http
GET /api/v1/work-history/responsibilities/amphoe/:amphoeId
Authorization: Bearer <token>
```

### Legacy Endpoints (ยังคงใช้งานได้)

#### 1. อัปเดต Admin Responsibilities
```http
PATCH /api/v1/work-history/:id/admin-responsibilities
Authorization: Bearer <token>

{
  "responsibleAmphoeIds": ["uuid1", "uuid2"]
}
```

#### 2. ดึง Admin Work Histories ตาม Amphoe
```http
GET /api/v1/work-history/admins/by-amphoe/:amphoeId
Authorization: Bearer <token>
```

#### 3. ดึง Admin Work Histories ทั้งหมด
```http
GET /api/v1/work-history/admins
Authorization: Bearer <token>
```

#### 4. ดึง Eligible Admin Work Histories
```http
GET /api/v1/work-history/admins/eligible
Authorization: Bearer <token>
```

#### 5. ดึง Work Histories ที่มี Responsibilities
```http
GET /api/v1/work-history/with-responsibilities
Authorization: Bearer <token>
```

#### 6. ดึง Admin Work Histories ที่มี Responsibilities
```http
GET /api/v1/work-history/admins/with-responsibilities
Authorization: Bearer <token>
```

## Business Rules

### 1. การมอบหมายความรับผิดชอบ
- เฉพาะ user ที่มี role เป็น 'admin' เท่านั้นที่สามารถมีความรับผิดชอบได้
- WorkHistory ต้องเป็น active
- ไม่สามารถมอบหมายความรับผิดชอบซ้ำสำหรับ workHistory และ amphoe เดียวกัน

### 2. การตรวจสอบสิทธิ์
- Admin ต้องทำงานในอำเภอเมืองและ อปท. อบจ.นม.
- ระบบจะตรวจสอบ `amphoe.name` และ `localAdministrativeOrganization.name`

### 3. การจัดการข้อมูล
- `createdAt` จะถูกสร้างอัตโนมัติเมื่อสร้าง record ใหม่
- `assignedByWorkHistoryId` เป็น optional สำหรับระบุผู้มอบหมาย

## Database Schema

### Table: work_history_amphoe_responsibilities
```sql
CREATE TABLE work_history_amphoe_responsibilities (
  id varchar(36) NOT NULL,
  work_history_id varchar(36) NOT NULL,
  amphoe_id varchar(36) NOT NULL,
  assigned_by_work_history_id varchar(36) DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_work_history_amphoe (work_history_id, amphoe_id),
  FOREIGN KEY (work_history_id) REFERENCES work_history(id) ON DELETE CASCADE,
  FOREIGN KEY (amphoe_id) REFERENCES amphoes(id) ON DELETE CASCADE,
  FOREIGN KEY (assigned_by_work_history_id) REFERENCES work_history(id) ON DELETE SET NULL
);
```

## Usage Examples

### 1. เพิ่มความรับผิดชอบให้ admin
```typescript
const responsibility = await workHistoryService.addResponsibility({
  workHistoryId: "work-history-uuid",
  amphoeId: "amphoe-uuid",
  assignedByWorkHistoryId: "assigner-work-history-uuid"
});
```

### 2. ตรวจสอบ admin ที่รับผิดชอบอำเภอ
```typescript
const responsibilities = await workHistoryService.getResponsibilitiesByAmphoe("amphoe-uuid");
```

### 3. อัปเดตผู้มอบหมาย
```typescript
await workHistoryService.updateResponsibility("responsibility-uuid", {
  assignedByWorkHistoryId: "new-assigner-work-history-uuid"
});
```

## Migration

รัน migration เพื่อสร้าง table:
```bash
# รัน SQL migration
mysql -u username -p database_name < src/work-history/migrations/create-work-history-amphoe-responsibilities.sql
```

## Notes

- ระบบใหม่ใช้ junction entity แทน Many-to-Many relationship เพื่อเก็บข้อมูลเพิ่มเติม
- Legacy endpoints ยังคงใช้งานได้เพื่อความเข้ากันได้
- ระบบจะตรวจสอบสิทธิ์และ business rules อัตโนมัติ
- ข้อมูลจะถูก soft delete เมื่อลบ record 