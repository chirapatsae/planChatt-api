# Executive Plan Analysis API Documentation

## Endpoint: `/api/v1/project-groups/executive/plan-analysis`

### Description
API endpoint สำหรับวิเคราะห์แผนงาน (Plan Analysis) ที่แสดงข้อมูลครบถ้วนสำหรับการสร้าง dashboard และ visualization ตามแผนงาน

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
  
  "planHierarchy": [
    {
      "planId": "uuid",
      "planName": "แผนการศึกษาแห่งชาติ",
      "totalBudget": 5000000.00,
      "projectCount": 15,
      "size": 5000000.00,
      "children": [
        {
          "tacticId": "uuid",
          "tacticName": "ยุทธวิธีพัฒนาคุณภาพการศึกษา",
          "totalBudget": 3000000.00,
          "projectCount": 10,
          "size": 3000000.00,
          "children": [
            {
              "strategyId": "uuid",
              "strategyName": "ยุทธศาสตร์การพัฒนาคุณภาพครู",
              "totalBudget": 2000000.00,
              "projectCount": 8,
              "size": 2000000.00,
              "projects": [
                {
                  "id": "project-id",
                  "title": "โครงการพัฒนาครู",
                  "budget": 500000.00,
                  "status": "Approved",
                  "statusCategory": "approved",
                  "isRevised": false
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  
  "timelineAnalysis": [
    {
      "year": 2024,
      "totalBudget": 2000000.00,
      "projectCount": 25,
      "planBreakdown": [
        {
          "planName": "แผนการศึกษาแห่งชาติ",
          "projectCount": 10,
          "budget": 1500000.00
        },
        {
          "planName": "แผนสาธารณสุขแห่งชาติ",
          "projectCount": 8,
          "budget": 800000.00
        }
      ]
    }
  ],
  
  "planComparison": [
    {
      "planId": "uuid",
      "planName": "แผนการศึกษาแห่งชาติ",
      "totalBudget": 5000000.00,
      "projectCount": 15,
      "averageBudgetPerProject": 333333.33,
      "completionRate": 73.33,
      "statusBreakdown": {
        "approved": 11,
        "pending": 3,
        "rejected": 1
      },
      "budgetEfficiency": 73.33,
      "projectScale": "large"
    }
  ],
  
  "projects": [...],
  "length": 50
}
```

## Features

### 1. Plan Information
- แสดงข้อมูลแผนงบประมาณที่ใช้งาน
- บอกว่าใช้เล่มหลัก (main) หรือเล่มแก้ไข (revision)
- แสดงช่วงปีของแผน

### 2. Plan Hierarchy (Sunburst Chart)
- แสดงลำดับชั้น: **Plan → Tactic → Strategy → Projects**
- ใช้สำหรับสร้าง Sunburst Chart
- แสดงงบประมาณและจำนวนโครงการในแต่ละระดับ
- รองรับ drill-down จากแผนลงไปยังโครงการ

### 3. Timeline Analysis
- แสดงการดำเนินงานตามปี
- แสดงงบประมาณและจำนวนโครงการในแต่ละปี
- แยกตามแผนงาน (plan breakdown)
- ใช้สำหรับสร้าง Timeline Chart

### 4. Plan Comparison
- เปรียบเทียบแผนงานแบบ Side-by-side
- แสดงตัวชี้วัดสำคัญ:
  - **Total Budget**: งบประมาณรวม
  - **Project Count**: จำนวนโครงการ
  - **Average Budget Per Project**: งบประมาณเฉลี่ยต่อโครงการ
  - **Completion Rate**: อัตราการเสร็จสิ้น (approved projects)
  - **Budget Efficiency**: ประสิทธิภาพการใช้งบประมาณ
  - **Project Scale**: ขนาดโครงการ (small/medium/large)

## Usage Examples

### 1. Sunburst Chart
```javascript
// ใช้ข้อมูลจาก planHierarchy
const sunburstData = dashboardData.planHierarchy.map(plan => ({
  name: plan.planName,
  size: plan.totalBudget,
  children: plan.children.map(tactic => ({
    name: tactic.tacticName,
    size: tactic.totalBudget,
    children: tactic.children.map(strategy => ({
      name: strategy.strategyName,
      size: strategy.totalBudget,
      children: strategy.projects.map(project => ({
        name: project.title,
        size: project.budget
      }))
    }))
  }))
}));
```

### 2. Timeline Chart
```javascript
// ใช้ข้อมูลจาก timelineAnalysis
const timelineData = dashboardData.timelineAnalysis.map(year => ({
  year: year.year,
  totalBudget: year.totalBudget,
  projects: year.projectCount,
  plans: year.planBreakdown
}));
```

### 3. Plan Comparison Chart
```javascript
// ใช้ข้อมูลจาก planComparison
const comparisonData = dashboardData.planComparison.map(plan => ({
  name: plan.planName,
  budget: plan.totalBudget,
  projects: plan.projectCount,
  efficiency: plan.completionRate,
  averageBudget: plan.averageBudgetPerProject
}));
```

### 4. Filter and Search
```javascript
// Filter by plan
const educationPlan = dashboardData.planHierarchy.find(plan => 
  plan.planName.includes('การศึกษา')
);

// Filter by project scale
const largePlans = dashboardData.planComparison.filter(plan => 
  plan.projectScale === 'large'
);

// Search projects
const searchResults = dashboardData.projects.filter(project => 
  project.title.toLowerCase().includes(searchTerm.toLowerCase())
);
```

## Key Benefits

### 1. **Hierarchical Analysis**
- เห็นภาพรวมการจัดสรรงบประมาณตามลำดับชั้น
- ติดตามความก้าวหน้าจากแผนไปยังโครงการ

### 2. **Timeline Tracking**
- ติดตามการดำเนินงานตามปี
- เห็นแนวโน้มการใช้งบประมาณในแต่ละแผน

### 3. **Performance Comparison**
- เปรียบเทียบประสิทธิภาพระหว่างแผนงาน
- วิเคราะห์อัตราการเสร็จสิ้นและประสิทธิภาพงบประมาณ

### 4. **Strategic Insights**
- วิเคราะห์ความสัมพันธ์ระหว่าง Plan → Tactic → Strategy
- เห็นภาพรวมการจัดสรรทรัพยากร

## Visualization Support

### 1. **Sunburst Chart**
- แสดงลำดับชั้น Plan → Tactic → Strategy
- รองรับ drill-down
- แสดงขนาดตามงบประมาณ

### 2. **Timeline Chart**
- แสดงการดำเนินงานตามปี
- แยกตามแผนงาน
- เห็นแนวโน้มการเปลี่ยนแปลง

### 3. **Comparison Charts**
- Bar Chart: เปรียบเทียบงบประมาณระหว่างแผน
- Scatter Plot: งบประมาณ vs อัตราการเสร็จสิ้น
- Radar Chart: ตัวชี้วัดหลายมิติ

### 4. **Dashboard Widgets**
- KPI Cards: ตัวชี้วัดสำคัญ
- Progress Bars: ความก้าวหน้า
- Status Indicators: สถานะโครงการ

## Error Handling

- `401 Unauthorized`: ไม่มีสิทธิ์เข้าถึง
- `404 Not Found`: ไม่พบแผนงบประมาณ
- `403 Forbidden`: Role ไม่ถูกต้อง

## Performance Considerations

- ใช้ parallel queries สำหรับดึงข้อมูล
- Cache plan hierarchy ถ้าจำเป็น
- จำกัดจำนวน projects ที่ return ใน response
- ใช้ Map สำหรับการจัดกลุ่มข้อมูลอย่างมีประสิทธิภาพ

## Related Endpoints

- `/api/v1/project-groups/executive/budget` - Executive Budget Dashboard
- `/api/v1/project-groups/executive/strategies` - Strategy Analysis
