# Executive Map District API Documentation

## Endpoint: `/api/v1/project-groups/executive/map-district`

### Description
API endpoint สำหรับแสดงโครงการแยกตามอำเภอ > อปท > โครงการ ของจังหวัดนครราชสีมา โดยแสดงโครงสร้างข้อมูลแบบลำดับชั้นพร้อมรายละเอียดโครงการครบถ้วน

### Method
`GET`

### Authentication
- Required: JWT Token
- Roles: `staff`, `admin`, `super-admin`, `c-level`

### Response Structure

```json
{
  "planInfo": {
    "budgetPlanId": "uuid",
    "budgetPlanName": "แผนพัฒนาท้องถิ่น (พ.ศ.2566-2570)",
    "startYear": 2566,
    "endYear": 2570,
    "isUsingMainPlan": false,
    "planType": "revision"
  },
  
  "districts": [
    {
      "amphoeId": "uuid",
      "amphoeName": "เมืองนครราชสีมา",
      "localOrgCount": 5,
      "projectCount": 25,
      "totalBudget": 15000000.00,
      "statusBreakdown": {
        "approved": 18,
        "pending": 5,
        "rejected": 2
      },
      "localOrganizations": [
        {
          "laoId": "uuid",
          "laoName": "เทศบาลนครนครราชสีมา",
          "laoType": "เทศบาลนคร",
          "projectCount": 8,
          "totalBudget": 5000000.00,
          "statusBreakdown": {
            "approved": 6,
            "pending": 2,
            "rejected": 0
          },
          "projects": [
            {
              "projectId": "uuid",
              "title": "โครงการพัฒนาแหล่งน้ำ",
              "objective": "เพื่อพัฒนาแหล่งน้ำในชุมชน",
              "goal": "ชุมชนมีแหล่งน้ำสำรองเพียงพอตลอดปี",
              "indicator": "ปริมาณน้ำสำรองเพิ่มขึ้น",
              "expected": "มีปริมาณน้ำสำรองไม่น้อยกว่า 10,000 ลูกบาศก์เมตร",
              "projectYear": 2566,
              
              "budget": 500000.00,
              "budgetByYear": [
                {
                  "year": 2566,
                  "amount": 300000.00
                },
                {
                  "year": 2567,
                  "amount": 200000.00
                }
              ],
              
              "status": "Approved",
              "statusCategory": "approved",
              
              "strategy": {
                "id": "uuid",
                "name": "ยุทธศาสตร์การพัฒนาโครงสร้างพื้นฐาน",
                "color": "#FF6B6B"
              },
              
              "tactic": {
                "id": "uuid",
                "name": "ยุทธวิธีพัฒนาแหล่งน้ำ"
              },
              
              "plan": {
                "id": "uuid",
                "name": "แผนการพัฒนาโครงสร้างพื้นฐาน"
              },
              
              "originAgency": {
                "id": "uuid",
                "name": "เทศบาลนครนครราชสีมา",
                "type": "เทศบาลนคร",
                "amphoe": "เมืองนครราชสีมา"
              },
              
              "responsibleAgency": {
                "id": "uuid",
                "name": "กองช่าง"
              },
              
              "isRevised": false,
              "isDraft": false,
              "createdAt": "2024-01-15T10:30:00.000Z"
            }
          ]
        },
        {
          "laoId": "uuid",
          "laoName": "เทศบาลตำบลในเมือง",
          "laoType": "เทศบาลตำบล",
          "projectCount": 3,
          "totalBudget": 2000000.00,
          "statusBreakdown": {
            "approved": 2,
            "pending": 1,
            "rejected": 0
          },
          "projects": [...]
        }
      ]
    },
    {
      "amphoeId": "uuid",
      "amphoeName": "โนนไทย",
      "localOrgCount": 3,
      "projectCount": 12,
      "totalBudget": 8000000.00,
      "statusBreakdown": {
        "approved": 9,
        "pending": 2,
        "rejected": 1
      },
      "localOrganizations": [
        {
          "laoId": "uuid",
          "laoName": "เทศบาลตำบลโนนไทย",
          "laoType": "เทศบาลตำบล",
          "projectCount": 8,
          "totalBudget": 6000000.00,
          "statusBreakdown": {
            "approved": 6,
            "pending": 1,
            "rejected": 1
          },
          "projects": [...]
        },
        {
          "laoId": "uuid",
          "laoName": "องค์การบริหารส่วนตำบลโนนไทย",
          "laoType": "องค์การบริหารส่วนตำบล",
          "projectCount": 4,
          "totalBudget": 2000000.00,
          "statusBreakdown": {
            "approved": 3,
            "pending": 1,
            "rejected": 0
          },
          "projects": [...]
        }
      ]
    }
  ],
  
  "statistics": {
    "totalProjects": 150,
    "totalBudget": 50000000.00,
    "totalLocalOrgs": 45,
    "averageProjectsPerDistrict": 15.50,
    "averageBudgetPerDistrict": 5000000.00,
    "statusBreakdown": {
      "approved": 110,
      "pending": 30,
      "rejected": 10
    },
    "topDistrictsByProject": [
      {
        "name": "เมืองนครราชสีมา",
        "projectCount": 25,
        "totalBudget": 15000000.00
      },
      {
        "name": "โนนไทย",
        "projectCount": 12,
        "totalBudget": 8000000.00
      }
    ],
    "topDistrictsByBudget": [
      {
        "name": "เมืองนครราชสีมา",
        "projectCount": 25,
        "totalBudget": 15000000.00
      },
      {
        "name": "โนนไทย",
        "projectCount": 12,
        "totalBudget": 8000000.00
      }
    ],
    "districtsWithProjects": 8,
    "districtsWithoutProjects": 4
  },
  
  "totalAmphoes": 12,
  "totalLocalOrgs": 45,
  "totalProjects": 150
}
```

## Data Structure

### 🏛️ **จังหวัดนครราชสีมา**
```
├── อำเภอเมืองนครราชสีมา
│   ├── เทศบาลนครนครราชสีมา (8 โครงการ, 5,000,000 บาท)
│   │   ├── โครงการพัฒนาแหล่งน้ำ (500,000 บาท, อนุมัติแล้ว)
│   │   ├── โครงการปรับปรุงถนน (800,000 บาท, อนุมัติแล้ว)
│   │   └── โครงการอื่นๆ...
│   ├── เทศบาลตำบลในเมือง (3 โครงการ, 2,000,000 บาท)
│   └── อบต.บางแห่ง (2 โครงการ, 1,500,000 บาท)
├── อำเภอโนนไทย
│   ├── เทศบาลตำบลโนนไทย (8 โครงการ, 6,000,000 บาท)
│   └── อบต.โนนไทย (4 โครงการ, 2,000,000 บาท)
└── อำเภออื่นๆ...
```

## Features

### 1. **Hierarchical Structure**
- **อำเภอ** → **อปท** → **โครงการ**
- แสดงทุกอำเภอและทุกอปท (แม้ไม่มีโครงการก็แสดง array เปล่า)
- เรียงลำดับตามจำนวนโครงการ (จากมากไปน้อย)

### 2. **Complete Project Details**
- ข้อมูลโครงการครบถ้วนเหมือน `/executive/map`
- Budget breakdown by year
- Strategy, tactic, plan information
- Status tracking

### 3. **Comprehensive Statistics**
- **District Level**: จำนวนโครงการ, งบประมาณ, สถานะในแต่ละอำเภอ
- **LAO Level**: จำนวนโครงการ, งบประมาณ, สถานะในแต่ละอปท
- **Provincial Level**: สถิติรวมทั้งจังหวัด

### 4. **Smart Data Handling**
- รองรับทั้ง original และ revised projects
- ใช้ `budgetPlan.isLatest` และ `developmentPlanRevision.isLatest`
- จัดการ edge cases (LAO ที่มีโครงการแต่ไม่มี record)

## Usage Examples

### 1. Display District Overview
```javascript
// แสดงข้อมูลอำเภอทั้งหมด
data.districts.forEach(district => {
  console.log(`${district.amphoeName}: ${district.projectCount} โครงการ`);
  console.log(`งบประมาณ: ${district.totalBudget.toLocaleString()} บาท`);
  
  district.localOrganizations.forEach(lao => {
    console.log(`  ${lao.laoName}: ${lao.projectCount} โครงการ`);
  });
});
```

### 2. Filter by District
```javascript
// กรองตามอำเภอ
const cityDistrict = data.districts.find(d => d.amphoeName === 'เมืองนครราชสีมา');

// กรองตามอปท
const cityLAOs = cityDistrict.localOrganizations.filter(lao => 
  lao.laoType === 'เทศบาลนคร'
);
```

### 3. Statistics Dashboard
```javascript
// สถิติรวม
const stats = data.statistics;
console.log(`โครงการทั้งหมด: ${stats.totalProjects}`);
console.log(`งบประมาณรวม: ${stats.totalBudget.toLocaleString()} บาท`);
console.log(`อปท ที่มีโครงการ: ${stats.totalLocalOrgs}`);

// Top districts
stats.topDistrictsByProject.forEach((district, index) => {
  console.log(`${index + 1}. ${district.name}: ${district.projectCount} โครงการ`);
});
```

### 4. Status Analysis
```javascript
// วิเคราะห์สถานะโครงการ
data.districts.forEach(district => {
  const approvalRate = (district.statusBreakdown.approved / district.projectCount) * 100;
  console.log(`${district.amphoeName}: ${approvalRate.toFixed(1)}% อนุมัติแล้ว`);
});
```

### 5. Budget Analysis
```javascript
// วิเคราะห์งบประมาณ
const budgetAnalysis = data.districts.map(district => ({
  name: district.amphoeName,
  totalBudget: district.totalBudget,
  avgBudgetPerProject: district.totalBudget / district.projectCount,
  budgetPerLAO: district.totalBudget / district.localOrgCount
}));

// เรียงตามงบประมาณ
budgetAnalysis.sort((a, b) => b.totalBudget - a.totalBudget);
```

## Data Sources

### 1. **Project Data**
- ใช้ `findOriginalLatestProjects(budgetPlan.id)` และ `findRevisedLatestProjects(budgetPlan.id)`
- รองรับทั้ง original และ revised projects
- กรองตาม `budgetPlan` ที่ `isLatest = true`

### 2. **Geographic Data**
- **Amphoes**: ดึงจาก `amphoe` table
- **Local Administrative Organizations**: ดึงจาก `local_administrative_organizations` table
- **Relations**: `originAgencyId` → `LocalAdministrativeOrganization` → `Amphoe`

### 3. **Project-Agency Mapping**
- โครงการเชื่อมกับอปทผ่าน `originAgencyId`
- อปทเชื่อมกับอำเภอผ่าน `amphoe_id`
- จัดกลุ่มโครงการตามลำดับชั้น

## Key Benefits

### 1. **Complete Geographic Coverage**
- แสดงทุกอำเภอและทุกอปท
- ไม่มีข้อมูลหายไป
- เห็นภาพรวมทั้งจังหวัด

### 2. **Detailed Project Information**
- ข้อมูลโครงการครบถ้วนเหมือน interactive map
- Budget, status, strategy ทุกอย่าง

### 3. **Multi-level Statistics**
- สถิติระดับอำเภอ, อปท, และจังหวัด
- เปรียบเทียบประสิทธิภาพได้

### 4. **Flexible Filtering**
- กรองตามอำเภอ, อปท, สถานะ
- เรียงลำดับตามเกณฑ์ต่างๆ

## Error Handling

- `401 Unauthorized`: ไม่มีสิทธิ์เข้าถึง
- `404 Not Found`: ไม่พบแผนงบประมาณ
- `403 Forbidden`: Role ไม่ถูกต้อง

## Performance Considerations

- ใช้ parallel queries สำหรับดึงข้อมูล
- Group by operations เพื่อประสิทธิภาพ
- Sort operations จำกัดเฉพาะข้อมูลที่จำเป็น

## Related Endpoints

- `/api/v1/project-groups/executive/map` - Interactive Map
- `/api/v1/project-groups/executive/budget` - Budget Dashboard
- `/api/v1/project-groups/executive/plan` - Plan Analysis

## Frontend Usage

### Tree View Component
```tsx
function DistrictTreeView({ data }) {
  return (
    <div className="district-tree">
      {data.districts.map(district => (
        <div key={district.amphoeId} className="district">
          <h3>{district.amphoeName}</h3>
          <div className="stats">
            {district.projectCount} โครงการ | {district.totalBudget.toLocaleString()} บาท
          </div>
          
          {district.localOrganizations.map(lao => (
            <div key={lao.laoId} className="lao">
              <h4>{lao.laoName}</h4>
              <div className="stats">
                {lao.projectCount} โครงการ | {lao.totalBudget.toLocaleString()} บาท
              </div>
              
              {lao.projects.map(project => (
                <div key={project.projectId} className="project">
                  <h5>{project.title}</h5>
                  <div className="details">
                    งบประมาณ: {project.budget.toLocaleString()} บาท
                    <span className={`status ${project.statusCategory}`}>
                      {project.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

API นี้พร้อมใช้งานแล้ว! 🚀
