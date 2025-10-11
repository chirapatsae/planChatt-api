# 📚 คู่มือเข้าใจ Union Query Pattern แบบง่ายๆ

> อธิบาย `findByStatusApproved()` ให้เข้าใจได้ภายใน 5 นาที!

---

## 🎯 ปัญหาที่เจอ

### สถานการณ์เดิม (Before)

ลองจินตนาการว่าคุณมีห้องสมุดเก็บหนังสือ:

```
📗 หนังสือต้นฉบับ (ProjectGroup)
   "แผนพัฒนาจังหวัด ปี 2567" 
   → สถานะ: อนุมัติแล้ว ✅ (เมื่อ 3 เดือนที่แล้ว)

📘 หนังสือฉบับแก้ไข (RevisedProjectGroup) 
   "แผนพัฒนาจังหวัด ปี 2567 (แก้ไขครั้งที่ 2)" 
   → สถานะ: รอตรวจสอบ ⏳ (ฉบับล่าสุด!)
```

**ปัญหา:** เมื่อคนมาถามว่า "เอาหนังสือที่อนุมัติแล้วมา"

```diff
- เดิม: เอาแค่ 📗 หนังสือต้นฉบับมาให้ (ข้อมูลเก่า 3 เดือน!)
+ ควรจะเป็น: เอา 📘 ฉบับแก้ไขมา (ข้อมูลล่าสุด!)
```

---

## ✨ วิธีแก้ใหม่: Union Query Pattern

### กฎง่ายๆ

```
ถ้าโครงการมีฉบับแก้ไข (Revised) 
  → เอาฉบับแก้ไขมา ✅ (ข้อมูลปัจจุบัน)
  
ถ้าโครงการไม่มีฉบับแก้ไข 
  → เอาฉบับต้นฉบับมา ✅ (ข้อมูลเดิม)
```

**ผลลัพธ์:** ได้ข้อมูล **ล่าสุด** เสมอ!

---

## 🔍 มาดูโค้ดทีละส่วน

### ภาพรวมการทำงาน

```typescript
async findByStatusApproved(option) {
  // 1️⃣ เช็คสิทธิ์ user
  // 2️⃣ Query ข้อมูล 2 แบบพร้อมกัน
  // 3️⃣ รวมผลลัพธ์และเรียงลำดับ
  // 4️⃣ ส่งกลับ
}
```

---

## 1️⃣ เช็คสิทธิ์ User (บรรทัด 1268-1290)

```typescript
// เช็คว่า user นี้มีสิทธิ์เข้าถึงข้อมูลไหม?
const workHistory = await this.workHistoryRepo.findOne({
  where: { user: { id: userId } },
  relations: ['workStatus', 'role'],
});

// เช็คว่า status = "approved" หรือยัง?
if (workHistory.workStatus.name !== 'approved')
  throw new UnauthorizedException('คุณยังไม่ได้รับสิทธิ์');

// เช็คว่า role ถูกต้องไหม?
const allowedRoles = ['staff', 'admin', 'super-admin', 'c-level'];
if (!allowedRoles.includes(workHistory.role.name))
  throw new UnauthorizedException('คุณไม่มีสิทธิ์เข้าถึง');
```

**💡 เหมือนกับ:** ยามประตูห้องสมุดเช็คว่าคุณมีบัตรและเป็นสมาชิกหรือเปล่า

**เงื่อนไขผ่าน:**
- ✅ User ต้องมี workStatus = "approved"
- ✅ Role ต้องเป็น staff/admin/super-admin/c-level

---

## 2️⃣ Query ข้อมูล 2 แบบพร้อมกัน (บรรทัด 1292-1296)

```typescript
// ดึงข้อมูลพร้อมกัน (Parallel Execution)
const [originalProjects, revisedProjects] = await Promise.all([
  this.findOriginalApprovedProjects(budgetPlanId),  // 📗 หาต้นฉบับ
  this.findRevisedApprovedProjects(budgetPlanId),   // 📘 หาฉบับแก้ไข
]);
```

**💡 ทำไมใช้ Promise.all?**
- ⚡ เร็วกว่า! (query พร้อมกัน แทนที่จะทีละอัน)
- 🎯 ได้ผลทั้ง 2 แบบมาพร้อมกัน

### ⏱️ เปรียบเทียบเวลา

```
แบบเดิม (Sequential):
  Query 1: 500ms
  Query 2: 500ms
  ────────────────
  รวม: 1,000ms

แบบใหม่ (Parallel):
  Query 1: 500ms ┐
  Query 2: 500ms ┴─ ทำพร้อมกัน!
  ────────────────
  รวม: 500ms ⚡
```

---

## 3️⃣ Helper Function ที่ 1: `findOriginalApprovedProjects`

```typescript
private async findOriginalApprovedProjects(budgetPlanId: string) {
  // หาโครงการต้นฉบับที่:
  // ✅ Status = "Approved"
  // ✅ ไม่มีฉบับแก้ไข (ไม่มี active revision)
  // ✅ อยู่ใน budget plan ที่ระบุ
}
```

### 🔑 ส่วนสำคัญที่สุด

```typescript
// Join เพื่อเช็คว่ามี revision ไหม
.leftJoin(RevisedProjectGroup, 'revisedProjects', 
  'revisedProjects.projectGroup = projectGroup.id')
.leftJoin(DevelopmentPlanRevision, 'activeRevision',
  'activeRevision.id = revisedProjects.developmentPlanRevision 
   AND activeRevision.isLatest = true')

// ต้องไม่มี active revision!
.andWhere('activeRevision.id IS NULL')  // ← สำคัญมาก!
```

### 📊 ตัวอย่าง

| โครงการ | สถานะ | มี Revision? | ผลลัพธ์ |
|---------|-------|--------------|---------|
| โครงการ A | Approved | ❌ ไม่มี | ✅ **เอา** |
| โครงการ B | Approved | ✅ มี (และเป็น latest) | ❌ **ไม่เอา** |
| โครงการ C | Pending | ❌ ไม่มี | ❌ ไม่เอา (status ไม่ตรง) |

**💡 Logic:** ถ้ามีฉบับใหม่แล้ว ไม่ต้องเอาฉบับเก่า!

---

## 4️⃣ Helper Function ที่ 2: `findRevisedApprovedProjects`

```typescript
private async findRevisedApprovedProjects(budgetPlanId: string) {
  // หาโครงการฉบับแก้ไขที่:
  // ✅ Status = "Approved"
  // ✅ เป็น version ล่าสุด (isLatest = true)
  // ✅ อยู่ใน budget plan ที่ระบุ
}
```

### 🔑 เงื่อนไขสำคัญ

```typescript
.andWhere('revisedProject.isDraft = :isDraft', { isDraft: false })
.andWhere('developmentPlanRevision.isLatest = :isLatest', { isLatest: true })
.andWhere('trackingStatus.isLatest = :isLatest', { isLatest: true })
.andWhere('status.name = :statusName', { statusName: 'Approved' })
```

### 📊 ตัวอย่าง

| โครงการ | Version | isLatest? | Status | ผลลัพธ์ |
|---------|---------|-----------|--------|---------|
| โครงการ B (v1) | แก้ไขครั้งที่ 1 | ❌ | Approved | ❌ **ไม่เอา** (ไม่ใช่ latest) |
| โครงการ B (v2) | แก้ไขครั้งที่ 2 | ✅ | Approved | ✅ **เอา** |
| โครงการ D (v1) | แก้ไขครั้งที่ 1 | ✅ | Pending | ❌ ไม่เอา (status ไม่ตรง) |

**💡 Logic:** เอาแค่ฉบับล่าสุดที่ approved แล้ว!

---

## 5️⃣ รวมผลลัพธ์ (บรรทัด 1303-1315)

```typescript
// 1. แปลงเป็นรูปแบบเดียวกัน (Unified Format)
const unifiedOriginals = originalProjects.map(project =>
  UnifiedProjectMapper.fromProjectGroup(project)
);

const unifiedRevised = revisedProjects.map(project =>
  UnifiedProjectMapper.fromRevisedProjectGroup(project)
);

// 2. รวมเข้าด้วยกัน
const combined = [...unifiedOriginals, ...unifiedRevised];

// 3. เรียงตามวันที่สร้าง (ใหม่สุดก่อน)
combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

return combined;
```

### 🎨 ภาพประกอบ

```
📗 Original Projects        📘 Revised Projects
┌──────────────────┐       ┌──────────────────┐
│ โครงการ A       │       │ โครงการ B (v2)  │
│ โครงการ C       │       │ โครงการ E (v1)  │
└────────┬─────────┘       └────────┬─────────┘
         │                          │
         └──────────┬───────────────┘
                    │
         ┌──────────▼──────────┐
         │   แปลงเป็น         │
         │   Unified Format    │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   รวมเข้าด้วยกัน   │
         │   [...originals,   │
         │    ...revised]      │
         └──────────┬──────────┘
                    │
         ┌──────────▼──────────┐
         │   เรียงตามวันที่    │
         │   (ใหม่สุดก่อน)    │
         └──────────┬──────────┘
                    │
                    ▼
              ส่งกลับผลลัพธ์
```

---

## 📋 ตัวอย่างผลลัพธ์จริง

### Input API Call

```http
GET /v1/project-groups/by-status-approved?budgetPlanId=abc-123
```

### Output Response

```json
[
  {
    "id": "revised-1",
    "title": "โครงการก่อสร้างถนน (แก้ไขครั้งที่ 2)",
    "projectType": "revised",           // ← บอกว่ามาจากฉบับแก้ไข
    "originalProjectId": "project-1",   // ← reference โครงการต้นฉบับ
    "status": "Approved",
    "createdAt": "2024-02-01T10:00:00Z",
    "budgetPlan": { ... },
    "trackingStatus": [ ... ]
  },
  {
    "id": "project-2",
    "title": "โครงการขุดลอกคลอง",
    "projectType": "original",          // ← บอกว่ามาจากต้นฉบับ
    "originalProjectId": null,
    "status": "Approved",
    "createdAt": "2024-01-15T10:00:00Z",
    "budgetPlan": { ... },
    "trackingStatus": [ ... ]
  },
  {
    "id": "project-3",
    "title": "โครงการปลูกป่า",
    "projectType": "original",
    "status": "Approved",
    "createdAt": "2024-01-10T10:00:00Z"
  }
]
```

**💡 สังเกต:**
- `projectType` บอกว่ามาจากไหน (original หรือ revised)
- `originalProjectId` มีค่าถ้ามาจาก revised project
- เรียงตามวันที่ใหม่สุดก่อน

---

## 🎭 Flow Chart แบบละเอียด

```
┌─────────────────────────────────────────────────┐
│  User เรียก API                                 │
│  GET /by-status-approved?budgetPlanId=xxx       │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Step 1: เช็คสิทธิ์                             │
│  ────────────────────────────────────────       │
│  ✓ User มีอยู่ใน system ไหม?                   │
│  ✓ workStatus = "approved" ไหม?                 │
│  ✓ role อยู่ใน allowedRoles ไหม?               │
│                                                  │
│  ❌ ไม่ผ่าน → throw UnauthorizedException       │
│  ✅ ผ่าน → ดำเนินการต่อ                        │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Step 2: เช็ค Budget Plan                      │
│  ────────────────────────────────────────       │
│  ✓ budgetPlanId มีค่าไหม?                      │
│  ✓ Budget Plan มีอยู่จริงไหม?                  │
│                                                  │
│  ❌ ไม่มี → throw NotFoundException             │
│  ✅ มี → ดำเนินการต่อ                          │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Step 3: Query ข้อมูลพร้อมกัน                  │
│  Promise.all([...])                             │
├────────────────────┬────────────────────────────┤
│                    │                            │
│  ┌─────────────────▼─────┐  ┌────────────────▼─┐│
│  │ findOriginal          │  │ findRevised      ││
│  │ ApprovedProjects      │  │ ApprovedProjects ││
│  │                       │  │                  ││
│  │ 📗 เงื่อนไข:         │  │ 📘 เงื่อนไข:    ││
│  │ • Approved           │  │ • Approved       ││
│  │ • ไม่มี revision    │  │ • isLatest=true  ││
│  │ • budgetPlan ตรง    │  │ • budgetPlan ตรง ││
│  └───────────┬───────────┘  └─────────┬────────┘│
│              │                        │         │
│              └────────┬───────────────┘         │
└───────────────────────┼─────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│  Step 4: แปลงเป็น Unified Format               │
│  ────────────────────────────────────────       │
│  originalProjects.map(...)                      │
│    → IUnifiedProjectDisplay[]                   │
│                                                  │
│  revisedProjects.map(...)                       │
│    → IUnifiedProjectDisplay[]                   │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Step 5: รวมและเรียงลำดับ                      │
│  ────────────────────────────────────────       │
│  const combined = [                             │
│    ...unifiedOriginals,                         │
│    ...unifiedRevised                            │
│  ];                                              │
│                                                  │
│  combined.sort(                                  │
│    (a, b) => b.createdAt - a.createdAt          │
│  );                                              │
└───────────────────┬─────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────┐
│  Step 6: Return ผลลัพธ์                        │
│  ────────────────────────────────────────       │
│  ถ้า countOnly = true                           │
│    → return จำนวนทั้งหมด (number)              │
│                                                  │
│  ถ้า countOnly = false                          │
│    → return array ของ IUnifiedProjectDisplay   │
└─────────────────────────────────────────────────┘
```

---

## 🆚 เปรียบเทียบก่อนและหลัง

### ❌ วิธีเดิม (Before)

```typescript
// Query แค่โครงการต้นฉบับ
const projects = await this.projectGroupRepo
  .createQueryBuilder('projectGroup')
  .where('status = Approved')
  .getMany();

// ปัญหา:
// 1. ไม่ได้เช็คว่ามี revision หรือเปล่า
// 2. อาจได้ข้อมูลเก่าที่ไม่ตรงปัจจุบัน
// 3. ไม่แสดงสถานะล่าสุดของโครงการที่มี revision
```

**ผลลัพธ์:**
```json
[
  {
    "id": "project-1",
    "title": "โครงการ A",
    "status": "Approved",
    "updatedAt": "2023-10-01"  // ← ข้อมูลเก่า 4 เดือน!
  }
]
```

### ✅ วิธีใหม่ (After - Union Query)

```typescript
// Query 2 แบบแยกกัน แล้วรวมกัน
const [original, revised] = await Promise.all([
  this.findOriginalApprovedProjects(budgetPlanId),
  this.findRevisedApprovedProjects(budgetPlanId),
]);

// ข้อดี:
// 1. เช็คว่ามี revision อย่างละเอียด
// 2. ได้ข้อมูลล่าสุดเสมอ
// 3. แสดงสถานะปัจจุบันที่ถูกต้อง
```

**ผลลัพธ์:**
```json
[
  {
    "id": "revised-1",
    "title": "โครงการ A (แก้ไขครั้งที่ 3)",
    "projectType": "revised",
    "status": "Approved",
    "updatedAt": "2024-02-01"  // ← ข้อมูลล่าสุด!
  }
]
```

---

## 🎯 สรุปหลักการ 3 ข้อ

### 1. แยก Query ชัดเจน

```
📗 Original Projects   →  ไม่มี active revision
📘 Revised Projects    →  มี revision ที่เป็น latest
```

### 2. Query พร้อมกัน (Parallel)

```typescript
Promise.all([query1, query2])  // ⚡ เร็วกว่า!
```

### 3. รวมและเรียงลำดับ

```typescript
[...originals, ...revised].sort(...)  // ใหม่สุดก่อน
```

---

## 🔧 การใช้งานใน Controller

```typescript
@Get('/by-status-approved')
async findByStatusApproved(
  @Req() req: Request & { user: JwtPayloadUser },
  @Query('countOnly') countOnly?: string,
  @Query('budgetPlanId', ParseUUIDPipe) budgetPlanId?: string,
) {
  return this.projectGroupsService.findByStatusApproved({
    userId: req.user.userId,
    countOnly: countOnly === 'true' || countOnly === '1',
    budgetPlanId,
  });
}
```

### ตัวอย่างการเรียกใช้

```bash
# ขอข้อมูลทั้งหมด
GET /v1/project-groups/by-status-approved?budgetPlanId=abc-123

# ขอแค่จำนวน
GET /v1/project-groups/by-status-approved?budgetPlanId=abc-123&countOnly=true

# Response เป็นตัวเลข: 15
```

---

## 💡 Tips & Best Practices

### 1. เช็คสิทธิ์ก่อนเสมอ

```typescript
// ✅ ดี - เช็คสิทธิ์ก่อน query
if (!hasPermission) throw new UnauthorizedException();
const data = await this.query();

// ❌ ไม่ดี - query ก่อน แล้วค่อยเช็ค
const data = await this.query();
if (!hasPermission) throw new UnauthorizedException();
```

### 2. ใช้ Promise.all สำหรับ independent queries

```typescript
// ✅ ดี - query พร้อมกัน
const [a, b] = await Promise.all([queryA(), queryB()]);

// ❌ ไม่ดี - query ทีละอัน
const a = await queryA();
const b = await queryB();
```

### 3. Return type ที่ชัดเจน

```typescript
// ✅ ดี - บอก return type ชัดเจน
async findByStatusApproved(): Promise<IUnifiedProjectDisplay[] | number>

// ❌ ไม่ดี - ไม่บอก type
async findByStatusApproved()
```

---

## 🐛 Common Pitfalls (ข้อผิดพลาดที่พบบ่อย)

### 1. ลืมเช็ค isLatest

```typescript
// ❌ ผิด - ไม่ได้เช็ค isLatest
.where('status = Approved')

// ✅ ถูก - เช็ค isLatest ด้วย
.where('status = Approved')
.andWhere('trackingStatus.isLatest = true')
.andWhere('developmentPlanRevision.isLatest = true')
```

### 2. ลืมเช็คว่ามี active revision

```typescript
// ❌ ผิด - อาจได้ทั้งต้นฉบับและฉบับแก้ไข (ซ้ำกัน)
const originals = await findOriginals();

// ✅ ถูก - เอาแค่ที่ไม่มี active revision
.leftJoin('activeRevision', ...)
.andWhere('activeRevision.id IS NULL')
```

### 3. ไม่ sort ผลลัพธ์

```typescript
// ❌ ผิด - ลำดับสุ่ม
return [...originals, ...revised];

// ✅ ถูก - เรียงตามวันที่
const combined = [...originals, ...revised];
combined.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
return combined;
```

---

## 🧪 Test Cases

### Test Case 1: โครงการไม่มี revision

```
Input:
  - โครงการ A (original)
  - Status: Approved
  - ไม่มี revision

Expected Output:
  ✅ แสดงโครงการ A จาก ProjectGroup
```

### Test Case 2: โครงการมี revision

```
Input:
  - โครงการ B (original) - Status: Approved
  - โครงการ B (revised v1) - Status: Approved, isLatest: false
  - โครงการ B (revised v2) - Status: Approved, isLatest: true

Expected Output:
  ✅ แสดงแค่โครงการ B (revised v2) - version ล่าสุด
  ❌ ไม่แสดงโครงการ B (original)
  ❌ ไม่แสดงโครงการ B (revised v1)
```

### Test Case 3: Mixed projects

```
Input:
  - โครงการ A (original) - Approved, ไม่มี revision
  - โครงการ B (revised v2) - Approved, isLatest: true
  - โครงการ C (original) - Approved, ไม่มี revision

Expected Output:
  ✅ แสดง: [B (revised v2), C (original), A (original)]
  เรียงตามวันที่สร้างล่าสุด
```

---

## 🚀 Performance Tips

### 1. Index ที่ควรมี

```sql
-- สำหรับ tracking_status
CREATE INDEX idx_tracking_status_latest 
ON tracking_status(is_latest, project_group_id, revised_project_group_id);

-- สำหรับ development_plan_revision
CREATE INDEX idx_dev_plan_revision_latest 
ON development_plan_revision(is_latest, budget_plan_id);
```

### 2. Eager Loading ที่เหมาะสม

```typescript
// ✅ ดี - load relation ที่จำเป็นเท่านั้น
.leftJoinAndSelect('project.trackingStatus', 'ts')
.leftJoinAndSelect('ts.statusId', 'status')

// ❌ ไม่ดี - load ทุกอย่าง
.leftJoinAndSelect('project', 'all_relations')
```

### 3. Limit และ Pagination

```typescript
// ถ้าข้อมูลเยอะมาก ควรเพิ่ม pagination
const query = baseQuery
  .take(limit)
  .skip(offset);
```

---

## 📚 Related Files

| ไฟล์ | หน้าที่ |
|------|---------|
| `project-groups.service.ts` | Service หลัก (มี findByStatusApproved) |
| `revised-project-group.entity.ts` | Entity สำหรับโครงการแก้ไข |
| `tracking-status.entity.ts` | Entity เก็บสถานะ |
| `unified-project-display.dto.ts` | Interface สำหรับ unified format |
| `project-groups.controller.ts` | Controller เรียก service |

---

## 🤔 FAQ

### Q: ทำไมต้อง query 2 ครั้ง?

**A:** เพื่อแยก logic ให้ชัดเจน:
- Query 1: โครงการที่ไม่มี revision (ใช้ของเดิม)
- Query 2: โครงการที่มี revision (ใช้ของใหม่)

### Q: ทำไมไม่ใช้ UNION ใน SQL?

**A:** เพราะ TypeORM QueryBuilder ไม่ support UNION ที่ดี และการทำแบบนี้:
- 💡 ยืดหยุ่นกว่า (แยก logic ชัดเจน)
- 🐛 Debug ง่ายกว่า
- 🧪 Test ง่ายกว่า

### Q: Performance จะดีพอไหม?

**A:** ดีกว่าการ query ซ้ำซ้อน เพราะ:
- ⚡ Query พร้อมกัน (Parallel)
- 🎯 แต่ละ query เฉพาะเจาะจง
- 📊 ใช้ index ได้ดี

---

## 🎓 สรุปสุดท้าย

### แนวคิดหลัก

```
🎯 เป้าหมาย: ได้ข้อมูลล่าสุดเสมอ

📋 วิธีการ:
   1. แยก query original และ revised
   2. Query พร้อมกัน (Parallel)
   3. รวมและเรียงลำดับ

✨ ผลลัพธ์:
   - ข้อมูลถูกต้องและทันสมัย
   - Performance ดี
   - Code maintainable
```

### Key Takeaways

✅ **แยกแล้วรวม** ดีกว่ารวมแล้วแยก  
✅ **Query พร้อมกัน** เร็วกว่าทีละอัน  
✅ **Type-safe** ช่วยให้ debug ง่าย  
✅ **Unified format** ทำให้ frontend handle ง่าย  

---

## 📞 Need Help?

หากยังสงสัยหรือต้องการคำอธิบายเพิ่มเติม:
1. อ่าน `IMPLEMENTATION_SUMMARY.md` สำหรับ technical details
2. ดู diagram ใน file นี้
3. ทดสอบด้วย Postman/curl

**Remember:** Code นี้เขียนเพื่อให้:
- ✅ ถูกต้อง (Correctness)
- ⚡ เร็ว (Performance)  
- 🧹 Clean (Maintainability)

---

**สร้างเมื่อ:** 2024-02-08  
**Pattern:** Union Query (Option 1)  
**Author:** Development Team
