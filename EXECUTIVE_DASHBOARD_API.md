# Executive Dashboard API Documentation

## Endpoint: `/api/v1/project-groups/executive-dashboard`

### Description
API endpoint สำหรับดึงข้อมูล Executive Dashboard ที่รวมข้อมูลครบถ้วนสำหรับการสร้าง dashboard และ visualization ต่างๆ

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
    "budgetPlanName": "ชื่อแผนงบประมาณ",
    "startYear": 2024,
    "endYear": 2028,
    "isUsingMainPlan": true,
    "planType": "main" | "revision"
  },
  
  "projectCounts": {
    "approved": 15,
    "pending": 8,
    "rejected": 2,
    "total": 25
  },
  
  "approvalRate": 60.0,
  
  "strategyStatistics": [
    {
      "strategyId": "uuid",
      "strategyName": "ยุทธศาสตร์การพัฒนาเศรษฐกิจ",
      "totalProjects": 12,
      "totalBudget": 5000000.00,
      "approvedCount": 8,
      "pendingCount": 3,
      "rejectedCount": 1,
      "projects": [
        {
          "id": "project-id",
          "title": "ชื่อโครงการ",
          "objective": "วัตถุประสงค์",
          "projectYear": 2024,
          "budget": 500000.00,
          "status": "Approved",
          "statusCategory": "approved",
          "isRevised": false,
          "createdAt": "2024-01-15T00:00:00.000Z"
        }
      ]
    }
  ],
  
  "budgetByYear": [
    {
      "year": 2024,
      "totalBudget": 2000000.00,
      "projectCount": 10,
      "projects": [
        {
          "id": "project-id",
          "title": "ชื่อโครงการ",
          "budget": 500000.00,
          "status": "Approved",
          "statusCategory": "approved",
          "isRevised": false
        }
      ]
    }
  ],
  
  "budgetByStrategy": [
    {
      "strategyId": "uuid",
      "strategyName": "ยุทธศาสตร์การพัฒนาเศรษฐกิจ",
      "totalBudget": 5000000.00,
      "projectCount": 12,
      "statusBreakdown": {
        "approved": 8,
        "pending": 3,
        "rejected": 1
      },
      "size": 5000000.00,
      "children": [
        {
          "projectId": "uuid",
          "projectTitle": "ชื่อโครงการ",
          "budget": 500000.00,
          "status": "Approved",
          "statusCategory": "approved"
        }
      ]
    }
  ],
  
  "budgetByAgencies": [
    {
      "agencyId": "uuid",
      "agencyName": "กระทรวงการพัฒนาสังคมและความมั่นคงของมนุษย์",
      "agencyType": "responsible",
      "totalBudget": 3000000.00,
      "projectCount": 8,
      "statusBreakdown": {
        "approved": 5,
        "pending": 2,
        "rejected": 1
      },
      "size": 3000000.00,
      "children": [
        {
          "projectId": "uuid",
          "projectTitle": "ชื่อโครงการ",
          "budget": 400000.00,
          "status": "Approved",
          "statusCategory": "approved",
          "strategy": "ยุทธศาสตร์การพัฒนาสังคม",
          "isRevised": false
        }
      ],
      "projects": [...]
    }
  ],
  
  "trendAnalysis": {
    "yearlyTrend": [
      {
        "year": 2024,
        "totalBudget": 2000000.00,
        "projectCount": 10,
        "approvedProjects": 6,
        "approvalRate": 60.0
      }
    ],
    "monthlyTrend": [
      {
        "year": 2024,
        "month": 1,
        "monthName": "มกราคม",
        "newProjects": 3
      }
    ],
    "budgetGrowth": [
      {
        "year": 2025,
        "growthRate": 15.5
      }
    ],
    "projectGrowth": [
      {
        "year": 2025,
        "growthRate": 20.0
      }
    ],
    "summary": {
      "totalBudget": 10000000.00,
      "averageYearlyBudget": 2000000.00,
      "totalProjects": 50,
      "averageApprovalRate": 65.5
    }
  },
  
  "projects": [...],
  "length": 25
}
```

## Features

### 1. Plan Information
- แสดงข้อมูลแผนงบประมาณที่ใช้งาน
- บอกว่าใช้เล่มหลัก (main) หรือเล่มแก้ไข (revision)
- แสดงช่วงปีของแผน

### 2. Project Counts & Approval Rate
- จำนวนโครงการแยกตามสถานะ (approved, pending, rejected)
- อัตราอนุมัติเป็นเปอร์เซ็นต์

### 3. Strategy Statistics
- สถิติแยกตามยุทธศาสตร์
- รวมงบประมาณและจำนวนโครงการในแต่ละยุทธศาสตร์
- รายการโครงการในยุทธศาสตร์นั้นๆ

### 4. Budget by Year (Waterfall Chart)
- แสดงงบประมาณแยกตามปี
- รายการโครงการในแต่ละปี
- ใช้สำหรับสร้าง Waterfall Chart

### 5. Budget by Strategy (Treemap)
- แสดงการจัดสรรงบประมาณตามยุทธศาสตร์
- มี `size` สำหรับ treemap visualization
- มี `children` สำหรับ drill-down

### 6. Budget by Government Agencies
- แสดงการจัดสรรงบประมาณตามหน่วยงานรัฐ
- แยกประเภทหน่วยงาน (`responsible` = หน่วยงานรับผิดชอบ, `origin` = หน่วยงานต้นทาง)
- แสดงสถานะโครงการในแต่ละหน่วยงาน
- เรียงลำดับตามงบประมาณรวม (จากมากไปน้อย)
- รองรับทั้ง original และ revised projects

### 7. Trend Analysis
- **Yearly Trend**: แนวโน้มรายปี
- **Monthly Trend**: แนวโน้มรายเดือน (12 เดือนล่าสุด)
- **Growth Rates**: อัตราการเติบโตของงบประมาณและโครงการ
- **Summary**: สรุปข้อมูลทั้งหมด

## Usage Examples

### 1. Executive Dashboard Overview
```javascript
// ใช้ข้อมูลจาก strategyStatistics และ projectCounts
const dashboardData = await fetch('/api/v1/project-groups/executive-dashboard');
```

### 2. Waterfall Chart
```javascript
// ใช้ข้อมูลจาก budgetByYear
const waterfallData = dashboardData.budgetByYear.map(year => ({
  year: year.year,
  budget: year.totalBudget,
  projects: year.projectCount
}));
```

### 3. Treemap Visualization
```javascript
// ใช้ข้อมูลจาก budgetByStrategy
const treemapData = dashboardData.budgetByStrategy.map(strategy => ({
  name: strategy.strategyName,
  size: strategy.totalBudget,
  children: strategy.children
}));

// หรือใช้ข้อมูลจาก budgetByAgencies
const agencyTreemapData = dashboardData.budgetByAgencies.map(agency => ({
  name: agency.agencyName,
  size: agency.totalBudget,
  children: agency.children
}));
```

### 4. Trend Charts
```javascript
// ใช้ข้อมูลจาก trendAnalysis
const yearlyChart = dashboardData.trendAnalysis.yearlyTrend;
const monthlyChart = dashboardData.trendAnalysis.monthlyTrend;
const growthChart = dashboardData.trendAnalysis.budgetGrowth;
```

## Key Benefits

1. **Single API Call**: ได้ข้อมูลครบถ้วนในครั้งเดียว
2. **Plan Type Awareness**: รู้ว่าใช้เล่มหลักหรือเล่มแก้ไข
3. **Rich Data**: มีข้อมูลสำหรับสร้าง visualization หลากหลาย
4. **Performance**: ใช้ Promise.all สำหรับ parallel queries
5. **Flexible**: รองรับทั้ง original และ revised projects

## Error Handling

- `401 Unauthorized`: ไม่มีสิทธิ์เข้าถึง
- `404 Not Found`: ไม่พบแผนงบประมาณ
- `403 Forbidden`: Role ไม่ถูกต้อง

## Performance Considerations

- ใช้ parallel queries สำหรับดึงข้อมูล
- Cache strategy statistics ถ้าจำเป็น
- จำกัดจำนวน projects ที่ return ใน response
