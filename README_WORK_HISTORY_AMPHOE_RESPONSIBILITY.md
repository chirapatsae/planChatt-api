# Work History Amphoe Responsibility Module

## การเปลี่ยนแปลง

ได้แยก `work-history-amphoe-responsibility` ออกจาก `work-history` module เพื่อให้มีโครงสร้างที่ชัดเจนและแยกความรับผิดชอบ

## โครงสร้างใหม่

### 1. Work History Amphoe Responsibility Module
- **Path**: `src/work-history-amphoe-responsibility/`
- **Entity**: `WorkHistoryAmphoeResponsibility`
- **Service**: `WorkHistoryAmphoeResponsibilityService`
- **Controller**: `WorkHistoryAmphoeResponsibilityController`

### 2. Endpoints ใหม่

#### POST `/v1/work-history-amphoe-responsibility`
สร้าง responsibility ใหม่
```json
{
  "workHistoryId": "uuid",
  "amphoeId": "uuid",
  "assignedByWorkHistoryId": "uuid" // optional
}
```

#### GET `/v1/work-history-amphoe-responsibility`
ดึงข้อมูล responsibility ทั้งหมด

#### GET `/v1/work-history-amphoe-responsibility/:id`
ดึงข้อมูล responsibility ตาม ID

#### GET `/v1/work-history-amphoe-responsibility/work-history/:workHistoryId`
ดึงข้อมูล responsibility ตาม work history ID

#### GET `/v1/work-history-amphoe-responsibility/amphoe/:amphoeId`
ดึงข้อมูล responsibility ตาม amphoe ID

#### PATCH `/v1/work-history-amphoe-responsibility/:id`
อัปเดตข้อมูล responsibility

#### PATCH `/v1/work-history-amphoe-responsibility/transfer/:id`
โอนย้าย responsibility ไปยัง work history อื่น
```json
{
  "newWorkHistoryId": "uuid"
}
```

#### DELETE `/v1/work-history-amphoe-responsibility/:id`
ลบ responsibility

## การเปลี่ยนแปลงใน Work History Module

### ลบออกจาก Work History Service:
- `addResponsibility()`
- `removeResponsibility()`
- `getResponsibilitiesByWorkHistory()`
- `getResponsibilitiesByAmphoe()`
- `transferResponsibility()`
- `findAllAdminWorkHistories()`
- `findAdminWorkHistoriesByAmphoe()`

### ลบออกจาก Work History Controller:
- `POST /responsibilities`
- `GET /responsibilities/work-history/:workHistoryId`
- `GET /responsibilities/amphoe/:amphoeId`
- `PATCH /responsibilities/:id`
- `DELETE /responsibilities/:id`
- `GET /admins`
- `GET /admins/by-amphoe/:amphoeId`

### ลบออกจาก Work History Entity:
- `responsibilities` relationship

## ประโยชน์

1. **Separation of Concerns**: แยกความรับผิดชอบระหว่าง work history และ responsibility
2. **Maintainability**: ง่ายต่อการบำรุงรักษาและแก้ไข
3. **Scalability**: สามารถขยายฟีเจอร์ได้ง่าย
4. **Testability**: ง่ายต่อการเขียน unit test
5. **API Clarity**: API endpoints ชัดเจนและเข้าใจง่าย

## การใช้งาน

```typescript
// Import module ใหม่
import { WorkHistoryAmphoeResponsibilityModule } from './work-history-amphoe-responsibility/work-history-amphoe-responsibility.module';

// ใช้ใน app.module.ts
@Module({
  imports: [
    // ... other modules
    WorkHistoryAmphoeResponsibilityModule,
  ],
})
export class AppModule {}
``` 