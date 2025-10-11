# API สำหรับติดตามโครงการที่ถูกแก้ไข/เปลี่ยนแปลง

## ภาพรวม

API นี้ออกแบบมาเพื่อติดตามโครงการที่มีการแก้ไขหรือเปลี่ยนแปลงตามแนวทางของระบบแผนพัฒนาท้องถิ่น โดยรองรับการเปรียบเทียบข้อมูลระหว่างเล่มแม่ เล่มแก้ไข และเล่มเปลี่ยนแปลง

## โครงสร้างระบบแผนพัฒนา

### 📌 ความเข้าใจที่สำคัญ

**`revisionNumber`** = นับต่อเนื่อง (1, 2, 3, 4, ...) **ไม่ว่าจะเป็น type ไหน**

**`revisionType.name`** = "แก้ไข" หรือ "เปลี่ยนแปลง" (แยกประเภท)

**"ครั้งที่"** = นับแยกตาม type (แก้ไขนับแก้ไข, เปลี่ยนแปลงนับเปลี่ยนแปลง)

### ตัวอย่าง Timeline

```
เล่มแม่ (ProjectGroup)
    ↓
Revision 1: type="แก้ไข" → แผนพัฒนาแก้ไขครั้งที่ 1 [เทียบกับเล่มแม่]
    ↓
Revision 2: type="เปลี่ยนแปลง" → แผนพัฒนาเปลี่ยนแปลงครั้งที่ 1 [เทียบกับ Revision 1]
    ↓
Revision 3: type="แก้ไข" → แผนพัฒนาแก้ไขครั้งที่ 2 [เทียบกับ Revision 2]
    ↓
Revision 4: type="เปลี่ยนแปลง" → แผนพัฒนาเปลี่ยนแปลงครั้งที่ 2 [เทียบกับ Revision 3]
    ↓
Revision 5: type="แก้ไข" → แผนพัฒนาแก้ไขครั้งที่ 3 [เทียบกับ Revision 4]
...และต่อไป
```

### สรุป Logic

| revisionNumber | revisionType | เรียกว่า | เปรียบเทียบกับ |
|----------------|--------------|----------|----------------|
| 1 | แก้ไข | แผนพัฒนาแก้ไขครั้งที่ 1 | เล่มแม่ (ProjectGroup) |
| 2 | เปลี่ยนแปลง | แผนพัฒนาเปลี่ยนแปลงครั้งที่ 1 | Revision 1 |
| 3 | แก้ไข | แผนพัฒนาแก้ไขครั้งที่ 2 | Revision 2 |
| 4 | เปลี่ยนแปลง | แผนพัฒนาเปลี่ยนแปลงครั้งที่ 2 | Revision 3 |
| 5 | แก้ไข | แผนพัฒนาแก้ไขครั้งที่ 3 | Revision 4 |

## Endpoints

### 1. ดึงรายการโครงการทั้งหมดจากแผนพัฒนาตัวล่าสุด

**Endpoint:** `GET /v1/revised-project-group/tracking/latest`

**Description:** ดึงรายการโครงการทั้งหมดที่อยู่ใน `developmentPlanRevision` ล่าสุด (isLatest = true)

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Response:**
```json
[
  {
    "id": "uuid",
    "title": "ชื่อโครงการ",
    "objective": "วัตถุประสงค์",
    "goal": "เป้าหมาย",
    "indicator": "ตัวชี้วัด",
    "expected": "ผลที่คาดว่าจะได้รับ",
    "projectYear": 2568,
    "isDraft": false,
    "startLat": 13.7563,
    "startLng": 100.5018,
    "endLat": null,
    "endLng": null,
    "additionalDetail": "รายละเอียดเพิ่มเติม",
    "createdAt": "2025-01-01T00:00:00.000Z",
    "developmentPlanRevision": {
      "id": "uuid",
      "revisionNumber": 1,
      "description": "แก้ไขครั้งที่ 1",
      "isLatest": true,
      "startDate": "2025-01-01T00:00:00.000Z",
      "endDate": "2025-12-31T00:00:00.000Z",
      "revisionType": {
        "id": "uuid",
        "name": "แก้ไข"
      },
      "budgetPlan": {
        "id": "uuid",
        "title": "แผนงบประมาณ 2568-2572",
        "startYear": 2568,
        "endYear": 2572
      }
    },
    "projectGroup": {
      "id": "uuid",
      "title": "ชื่อโครงการเดิม"
      // ... ข้อมูลโครงการแม่
    },
    "strategy": { /* ... */ },
    "tactic": { /* ... */ },
    "plan": { /* ... */ },
    "createdBy": { /* ... */ },
    "responsibleBy": { /* ... */ },
    "budgets": [
      {
        "id": "uuid",
        "year": 2568,
        "amount": 1000000,
        "source": "งบประมาณ"
      }
    ],
    "trackingStatus": [
      {
        "id": "uuid",
        "statusId": {
          "id": "uuid",
          "name": "รออนุมัติ"
        },
        "createdAt": "2025-01-01T00:00:00.000Z"
      }
    ],
    "originAgencyId": { /* ... */ },
    "responsibleAgency": { /* ... */ }
  }
]
```

**Use Case:**
- แสดงรายการโครงการทั้งหมดที่อยู่ในแผนพัฒนาล่าสุด
- ใช้สำหรับหน้าหลักของระบบติดตามโครงการ

---

### 2. ดึงรายละเอียดโครงการพร้อมเปรียบเทียบ

**Endpoint:** `GET /v1/revised-project-group/tracking/:id/comparison`

**Description:** ดึงรายละเอียดของโครงการพร้อมข้อมูลสำหรับเปรียบเทียบกับ version ก่อนหน้า

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Parameters:**
- `id` (path parameter): UUID ของ RevisedProjectGroup

**Response:**
```json
{
  "current": {
    "id": "uuid",
    "title": "ชื่อโครงการใหม่",
    "objective": "วัตถุประสงค์ใหม่",
    "goal": "เป้าหมายใหม่",
    "indicator": "ตัวชี้วัดใหม่",
    "expected": "ผลที่คาดว่าจะได้รับใหม่",
    "projectYear": 2568,
    "isDraft": false,
    "additionalDetail": "รายละเอียดเพิ่มเติมใหม่",
    "developmentPlanRevision": {
      "id": "uuid",
      "revisionNumber": 3,
      "description": "แก้ไขครั้งที่ 2",
      "revisionType": {
        "id": "uuid",
        "name": "แก้ไข"
      },
      "budgetPlan": {
        "id": "uuid",
        "title": "แผนงบประมาณ 2568-2572"
      }
    },
    "budgets": [
      {
        "year": 2568,
        "amount": 1500000,
        "source": "งบประมาณ"
      }
    ]
    // ... ข้อมูลทั้งหมดของโครงการปัจจุบัน
  },
  "previous": {
    "id": "uuid",
    "title": "ชื่อโครงการเดิม",
    "objective": "วัตถุประสงค์เดิม",
    "goal": "เป้าหมายเดิม",
    "indicator": "ตัวชี้วัดเดิม",
    "expected": "ผลที่คาดว่าจะได้รับเดิม",
    "projectYear": 2568,
    "additionalDetail": "รายละเอียดเพิ่มเติมเดิม",
    "developmentPlanRevision": {
      "revisionNumber": 2,
      "revisionType": {
        "name": "เปลี่ยนแปลง"
      }
    },
    "budgets": [
      {
        "year": 2568,
        "amount": 1000000,
        "source": "งบประมาณ"
      }
    ]
    // ... ข้อมูลทั้งหมดของ version ก่อนหน้า
  },
  "comparisonType": "revised",
  "revisionInfo": {
    "revisionNumber": 3,
    "revisionTypeName": "แก้ไข",
    "occurrence": 2,
    "displayName": "แผนพัฒนาแก้ไขครั้งที่ 2"
  }
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `current` | RevisedProjectGroup | ข้อมูลโครงการปัจจุบัน |
| `previous` | ProjectGroup \| RevisedProjectGroup \| null | ข้อมูลโครงการก่อนหน้า (null ถ้าเป็นโครงการใหม่) |
| `comparisonType` | string | ประเภทการเปรียบเทียบ |
| `revisionInfo` | object | ข้อมูลเกี่ยวกับ revision |
| `revisionInfo.revisionNumber` | number | เลข revision (1, 2, 3, ...) นับต่อเนื่อง |
| `revisionInfo.revisionTypeName` | string | ชื่อประเภท ("แก้ไข" หรือ "เปลี่ยนแปลง") |
| `revisionInfo.occurrence` | number | ครั้งที่ของ type นี้ (เช่น แก้ไขครั้งที่ 2) |
| `revisionInfo.displayName` | string | ชื่อแสดงผล (เช่น "แผนพัฒนาแก้ไขครั้งที่ 2") |

**Comparison Types:**
- `"original"` - เปรียบเทียบกับเล่มแม่ (ProjectGroup) เมื่อ revisionNumber = 1
- `"revised"` - เปรียบเทียบกับ revision ก่อนหน้า (revisionNumber - 1) ไม่ว่า type จะเหมือนกันหรือไม่
- `"new"` - โครงการใหม่ไม่มีข้อมูลเปรียบเทียบ (projectGroup = null)

**Use Case:**
- แสดงรายละเอียดโครงการเมื่อคลิกจากหน้ารายการ
- แสดงการเปลี่ยนแปลงระหว่าง version ปัจจุบันและ version ก่อนหน้า
- แสดงข้อความว่าเป็น "แก้ไขครั้งที่เท่าไหร่" หรือ "เปลี่ยนแปลงครั้งที่เท่าไหร่"
- ใช้สำหรับการตรวจสอบและอนุมัติการแก้ไข/เปลี่ยนแปลง

---

## ตัวอย่างการใช้งาน

### สถานการณ์ที่ 1: แก้ไขครั้งแรก (revisionNumber = 1)

```javascript
// คลิกดูรายละเอียดโครงการ
const comparison = await fetch('/v1/revised-project-group/tracking/abc-123/comparison', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Response:
{
  "current": { 
    /* โครงการจากเล่มแก้ไขครั้งที่ 1 */
    "developmentPlanRevision": { "revisionNumber": 1, "revisionType": { "name": "แก้ไข" } }
  },
  "previous": { /* โครงการจากเล่มแม่ (ProjectGroup) */ },
  "comparisonType": "original",
  "revisionInfo": {
    "revisionNumber": 1,
    "revisionTypeName": "แก้ไข",
    "occurrence": 1,
    "displayName": "แผนพัฒนาแก้ไขครั้งที่ 1"
  }
}
```

### สถานการณ์ที่ 2: เปลี่ยนแปลงครั้งแรก (revisionNumber = 2)

```javascript
// คลิกดูรายละเอียดโครงการ
const comparison = await fetch('/v1/revised-project-group/tracking/def-456/comparison', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Response:
{
  "current": { 
    /* โครงการจากเล่มเปลี่ยนแปลงครั้งที่ 1 */
    "developmentPlanRevision": { "revisionNumber": 2, "revisionType": { "name": "เปลี่ยนแปลง" } }
  },
  "previous": { 
    /* โครงการจาก revision 1 (แก้ไขครั้งที่ 1) */
    "developmentPlanRevision": { "revisionNumber": 1 }
  },
  "comparisonType": "revised",
  "revisionInfo": {
    "revisionNumber": 2,
    "revisionTypeName": "เปลี่ยนแปลง",
    "occurrence": 1,
    "displayName": "แผนพัฒนาเปลี่ยนแปลงครั้งที่ 1"
  }
}
```

### สถานการณ์ที่ 3: แก้ไขครั้งที่ 2 (revisionNumber = 3)

```javascript
// คลิกดูรายละเอียดโครงการ
const comparison = await fetch('/v1/revised-project-group/tracking/xyz-789/comparison', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Response:
{
  "current": { 
    /* โครงการจากเล่มแก้ไขครั้งที่ 2 */
    "developmentPlanRevision": { "revisionNumber": 3, "revisionType": { "name": "แก้ไข" } }
  },
  "previous": { 
    /* โครงการจาก revision 2 (เปลี่ยนแปลงครั้งที่ 1) */
    "developmentPlanRevision": { "revisionNumber": 2 }
  },
  "comparisonType": "revised",
  "revisionInfo": {
    "revisionNumber": 3,
    "revisionTypeName": "แก้ไข",
    "occurrence": 2,  // นับแก้ไขครั้งที่ 2 (มี revision 1 เป็นแก้ไขครั้งที่ 1 ก่อนหน้า)
    "displayName": "แผนพัฒนาแก้ไขครั้งที่ 2"
  }
}
```

### สถานการณ์ที่ 4: โครงการใหม่

```javascript
const comparison = await fetch('/v1/revised-project-group/tracking/new-999/comparison', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Response:
{
  "current": { /* โครงการใหม่ */ },
  "previous": null,  // ไม่มีข้อมูลเปรียบเทียบ
  "comparisonType": "new",
  "revisionInfo": {
    "revisionNumber": 3,
    "revisionTypeName": "แก้ไข",
    "occurrence": 2,
    "displayName": "แผนพัฒนาแก้ไขครั้งที่ 2"
  }
}
```

---

## การแสดงผลใน Frontend

### แนะนำการแสดงผลแบบ Comparison View

```tsx
function ProjectComparisonView({ comparisonData }) {
  const { current, previous, comparisonType, revisionInfo } = comparisonData;

  if (comparisonType === 'new') {
    return (
      <div>
        <h2>{revisionInfo.displayName}</h2>
        <ProjectDetailView project={current} />
      </div>
    );
  }

  return (
    <div className="comparison-container">
      <header>
        <h2>{revisionInfo.displayName}</h2>
        <div className="revision-meta">
          <span>Revision #{revisionInfo.revisionNumber}</span>
          <span>ประเภท: {revisionInfo.revisionTypeName}</span>
        </div>
      </header>

      <div className="comparison-grid">
        <div className="previous-version">
          <h3>
            {comparisonType === 'original' 
              ? 'เล่มแม่ (ฉบับเดิม)' 
              : `Revision ${previous.developmentPlanRevision.revisionNumber}`}
          </h3>
          <ProjectFields data={previous} />
        </div>
        
        <div className="changes-indicator">
          <ArrowRight />
          <span>เปลี่ยนแปลง</span>
        </div>
        
        <div className="current-version">
          <h3>{revisionInfo.displayName}</h3>
          <ProjectFields 
            data={current} 
            highlightChanges={true}
            previousData={previous}
          />
        </div>
      </div>
    </div>
  );
}
```

### ตัวอย่างการแสดง displayName

```tsx
function ProjectList({ projects }) {
  return (
    <div>
      {projects.map(project => (
        <Link 
          key={project.id} 
          to={`/tracking/${project.id}/comparison`}
        >
          <div className="project-card">
            <h3>{project.title}</h3>
            <div className="revision-badge">
              {/* แสดงชื่อที่คำนวณมาจาก API */}
              Revision #{project.developmentPlanRevision.revisionNumber}
              {' - '}
              {project.developmentPlanRevision.revisionType.name}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

// เมื่อคลิก จะเรียก comparison API และแสดง revisionInfo.displayName
// เช่น "แผนพัฒนาแก้ไขครั้งที่ 2"
```

### การเน้นการเปลี่ยนแปลง (Highlight Changes)

```tsx
function FieldComparison({ label, currentValue, previousValue }) {
  const hasChanged = currentValue !== previousValue;
  
  return (
    <div className={hasChanged ? 'field-changed' : 'field-unchanged'}>
      <label>{label}</label>
      {hasChanged && (
        <div className="change-indicator">
          <span className="old-value">{previousValue}</span>
          <ArrowRight size={12} />
          <span className="new-value">{currentValue}</span>
        </div>
      )}
      {!hasChanged && <span>{currentValue}</span>}
    </div>
  );
}
```

---

## หมายเหตุสำคัญ

### 1. การนับ revisionNumber และ occurrence

**revisionNumber:**
- นับต่อเนื่องไปเรื่อยๆ (1, 2, 3, 4, ...) ภายใน `budgetPlan` เดียวกัน
- ไม่สนใจว่าเป็น type "แก้ไข" หรือ "เปลี่ยนแปลง"

**occurrence (ครั้งที่):**
- นับแยกตาม `revisionType.name`
- ตัวอย่าง:
  ```
  Revision 1 (แก้ไข) → occurrence = 1 (แก้ไขครั้งที่ 1)
  Revision 2 (เปลี่ยนแปลง) → occurrence = 1 (เปลี่ยนแปลงครั้งที่ 1)
  Revision 3 (แก้ไข) → occurrence = 2 (แก้ไขครั้งที่ 2)
  Revision 4 (เปลี่ยนแปลง) → occurrence = 2 (เปลี่ยนแปลงครั้งที่ 2)
  ```

### 2. การเปรียบเทียบ

**กฎการเปรียบเทียบ:**
- **revisionNumber = 1:** เทียบกับเล่มแม่ (`ProjectGroup`) เสมอ
- **revisionNumber > 1:** เทียบกับ revision ก่อนหน้า (`revisionNumber - 1`) ไม่ว่า type จะเหมือนกันหรือไม่
- **projectGroup = null:** โครงการใหม่ ไม่มีข้อมูลเปรียบเทียบ

**ตัวอย่าง:**
- Revision 3 (แก้ไขครั้งที่ 2) → เทียบกับ Revision 2 (เปลี่ยนแปลงครั้งที่ 1)
- Revision 5 (แก้ไขครั้งที่ 3) → เทียบกับ Revision 4 (เปลี่ยนแปลงครั้งที่ 2)

### 3. โครงการใหม่

- ถ้า `projectGroup` เป็น `null` → โครงการใหม่ที่เพิ่มในเล่มแก้ไข/เปลี่ยนแปลง
- ไม่มีข้อมูลเปรียบเทียบ (`previous = null`, `comparisonType = "new"`)
- แต่ยังคงมี `revisionInfo` เพื่อบอกว่าอยู่ใน revision ไหน

### 4. การอนุมัติ

- ตรวจสอบ `trackingStatus` เพื่อดูสถานะการอนุมัติ
- สถานะจะถูกสร้างอัตโนมัติตอนสร้าง RevisedProjectGroup:
  - "แก้ไข" → statusId: `09b37525-31db-49f8-92be-7c8a14392ae1`
  - "เปลี่ยนแปลง" → statusId: `ac6275f0-0491-4cfe-86e7-307ed21a62a9`

### 5. งบประมาณ

- งบประมาณสามารถเปลี่ยนแปลงได้ในแต่ละ revision
- เปรียบเทียบ `budgets` array เพื่อดูการเปลี่ยนแปลงของงบประมาณ
- แต่ละ revision สามารถมีงบประมาณหลายปีได้

### 6. การใช้ displayName

- ใช้ `revisionInfo.displayName` เพื่อแสดงชื่อ revision แบบเป็นมิตร
- ตัวอย่าง: "แผนพัฒนาแก้ไขครั้งที่ 2", "แผนพัฒนาเปลี่ยนแปลงครั้งที่ 1"
- ระบบคำนวณให้อัตโนมัติ ไม่ต้องนับเอง

---

## Error Handling

### Possible Errors:

**404 Not Found**
```json
{
  "statusCode": 404,
  "message": "RevisedProjectGroup with id xxx not found"
}
```

**401 Unauthorized**
```json
{
  "statusCode": 401,
  "message": "Unauthorized"
}
```

---

## ตัวอย่าง cURL

```bash
# 1. ดึงรายการโครงการล่าสุด
curl -X GET \
  'http://localhost:3000/v1/revised-project-group/tracking/latest' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'

# 2. ดึงรายละเอียดพร้อมเปรียบเทียบ
curl -X GET \
  'http://localhost:3000/v1/revised-project-group/tracking/abc-123-def-456/comparison' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN'
```

---

## สรุป

API ทั้งสองนี้ทำงานร่วมกันเพื่อ:
1. แสดงรายการโครงการที่ถูกแก้ไข/เปลี่ยนแปลงล่าสุด (`/tracking/latest`)
2. แสดงรายละเอียดพร้อมเปรียบเทียบกับ version ก่อนหน้า (`/tracking/:id/comparison`)
3. รองรับการติดตามประวัติการแก้ไขตามลำดับ (chain of revisions)
4. คำนวณ "ครั้งที่" ของแต่ละ type อัตโนมัติ

### Key Features

✅ **นับ revisionNumber ต่อเนื่อง** (1, 2, 3, ...) ไม่สนใจ type  
✅ **นับ occurrence แยกตาม type** (แก้ไขครั้งที่ X, เปลี่ยนแปลงครั้งที่ Y)  
✅ **เปรียบเทียบกับ revision ก่อนหน้าอัตโนมัติ** (ไม่ว่า type จะเหมือนกันหรือไม่)  
✅ **สร้าง displayName อัตโนมัติ** ("แผนพัฒนาแก้ไขครั้งที่ 2")  
✅ **รองรับโครงการใหม่** (projectGroup = null)  

ระบบจะเลือกข้อมูลเปรียบเทียบและคำนวณ "ครั้งที่" ให้อัตโนมัติ ทำให้ง่ายต่อการใช้งานและแสดงผล

---

## Quick Start

```bash
# 1. ดึงรายการโครงการล่าสุด
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/v1/revised-project-group/tracking/latest

# 2. ดูรายละเอียดพร้อมเปรียบเทียบ
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:3000/v1/revised-project-group/tracking/{PROJECT_ID}/comparison
```

Response จะมี `revisionInfo` บอกว่า:
- `revisionNumber`: เลข revision
- `revisionTypeName`: "แก้ไข" หรือ "เปลี่ยนแปลง"
- `occurrence`: ครั้งที่ของ type นี้
- `displayName`: ชื่อแสดงผล (เช่น "แผนพัฒนาแก้ไขครั้งที่ 2")

