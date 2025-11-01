# AI Insights & SWOT Analysis API Documentation

## Overview
API endpoints สำหรับ AI Insights Dashboard ที่ให้บริการวิเคราะห์ SWOT และข้อมูลเชิงลึกจากข้อมูลโครงการ

## Base URL
```
/api/v1/ai/insights
```

## Authentication
ทุก endpoint ต้องใช้ JWT Token ใน Authorization header

## Endpoints

### 1. Get Dashboard Data
```
GET /insights/dashboard-data
```
**Description**: ดึงข้อมูลรวมสำหรับ AI analysis
**Response**:
```json
{
  "dashboardData": {
    "projectCounts": {
      "total": 150,
      "approved": 120,
      "pending": 20,
      "rejected": 10
    },
    "totalBudget": 50000000,
    "approvalRate": 80.0,
    "strategyStatistics": [...],
    "budgetByYear": [...],
    "budgetByStrategy": [...],
    "budgetByAgencies": [...],
    "trendAnalysis": {...}
  },
  "planAnalysisData": {...},
  "mapData": {...},
  "districtData": {...},
  "timestamp": "2025-10-16T16:30:00.000Z",
  "analysisDimensions": ["strategy", "district", "budget"]
}
```

### 2. SWOT Analysis
```
POST /insights/swot-analysis
```
**Description**: วิเคราะห์ SWOT แบบครบถ้วน
**Request Body**:
```json
{
  "dimension": "strategy", // "strategy" | "district" | "budget"
  "targetId": "uuid-string" // optional
}
```
**Response**:
```json
{
  "dimension": "strategy",
  "targetId": "uuid-string",
  "analysis": "รายงานการวิเคราะห์ SWOT อย่างละเอียด...",
  "timestamp": "2025-10-16T16:30:00.000Z",
  "dataSource": "comprehensive-dashboard"
}
```

### 3. Strengths Analysis
```
POST /insights/strengths-analysis
```
**Description**: วิเคราะห์จุดแข็ง (Strengths)
**Request Body**:
```json
{
  "dimension": "district",
  "targetId": "uuid-string" // optional
}
```
**Response**:
```json
{
  "type": "strengths",
  "dimension": "district",
  "targetId": "uuid-string",
  "analysis": "การวิเคราะห์จุดแข็ง...",
  "timestamp": "2025-10-16T16:30:00.000Z"
}
```

### 4. Weaknesses Analysis
```
POST /insights/weaknesses-analysis
```
**Description**: วิเคราะห์จุดอ่อนและช่องว่าง (Weaknesses)
**Request Body**: เหมือนกับ Strengths Analysis
**Response**: เหมือนกับ Strengths Analysis แต่ `type: "weaknesses"`

### 5. Opportunities Analysis
```
POST /insights/opportunities-analysis
```
**Description**: วิเคราะห์โอกาส (Opportunities)
**Request Body**: เหมือนกับ Strengths Analysis
**Response**: เหมือนกับ Strengths Analysis แต่ `type: "opportunities"`

### 6. Threats Analysis
```
POST /insights/threats-analysis
```
**Description**: วิเคราะห์ความเสี่ยง (Threats)
**Request Body**: เหมือนกับ Strengths Analysis
**Response**: เหมือนกับ Strengths Analysis แต่ `type: "threats"`

### 7. SWOT Matrix
```
POST /insights/swot-matrix
```
**Description**: สร้าง SWOT Matrix ในรูปแบบตาราง 4 ช่อง
**Request Body**: เหมือนกับ SWOT Analysis
**Response**:
```json
{
  "type": "swot-matrix",
  "dimension": "strategy",
  "targetId": "uuid-string",
  "matrix": "SWOT Matrix ในรูปแบบตาราง...",
  "timestamp": "2025-10-16T16:30:00.000Z"
}
```

### 8. Export SWOT to PDF
```
POST /insights/export-swot-pdf
```
**Description**: สร้างรายงาน SWOT พร้อม export เป็น PDF
**Request Body**: เหมือนกับ SWOT Analysis
**Response**:
```json
{
  "type": "swot-pdf-export",
  "dimension": "budget",
  "targetId": "uuid-string",
  "content": "เนื้อหารายงาน PDF...",
  "timestamp": "2025-10-16T16:30:00.000Z",
  "format": "pdf-ready"
}
```

### 9. Refresh Analysis
```
POST /insights/refresh-analysis
```
**Description**: รีเฟรชข้อมูลและวิเคราะห์ใหม่
**Request Body**: เหมือนกับ SWOT Analysis
**Response**:
```json
{
  "type": "refresh-analysis",
  "dimension": "district",
  "targetId": "uuid-string",
  "message": "Analysis refreshed successfully",
  "timestamp": "2025-10-16T16:30:00.000Z",
  "freshData": {...}
}
```

## Analysis Dimensions

### Strategy Dimension
- วิเคราะห์ตามยุทธศาสตร์ (Strategy)
- เปรียบเทียบประสิทธิภาพระหว่างยุทธศาสตร์
- วิเคราะห์การกระจายงบประมาณตามยุทธศาสตร์

### District Dimension
- วิเคราะห์ตามอำเภอ (Amphoe)
- เปรียบเทียบประสิทธิภาพระหว่างอำเภอ
- วิเคราะห์การกระจายโครงการตามพื้นที่

### Budget Dimension
- วิเคราะห์ตามงบประมาณ
- วิเคราะห์ประสิทธิภาพการใช้จ่าย
- วิเคราะห์แนวโน้มการใช้งบประมาณ

## Data Sources
AI Analysis จะใช้ข้อมูลจาก:
- Executive Dashboard Data
- Plan Analysis Data
- Map Data (Geographic)
- District Data
- Project Groups & Revised Project Groups
- Budget Plans & Development Plan Revisions

## AI Model
- **Model**: GPT-4o-mini
- **Temperature**: 0.7 (เพื่อความสมดุลระหว่างความแม่นยำและความคิดสร้างสรรค์)
- **Max Tokens**: 2000
- **Language**: ไทย

## Error Handling
```json
{
  "statusCode": 500,
  "message": "เกิดข้อผิดพลาดในการวิเคราะห์ข้อมูลจาก AI",
  "error": "Internal Server Error"
}
```

## Usage Examples

### Frontend Integration
```javascript
// Get dashboard data
const dashboardData = await fetch('/api/v1/ai/insights/dashboard-data', {
  headers: { 'Authorization': `Bearer ${token}` }
});

// Perform SWOT analysis
const swotResult = await fetch('/api/v1/ai/insights/swot-analysis', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    dimension: 'strategy',
    targetId: 'strategy-uuid'
  })
});

// Generate SWOT matrix
const matrixResult = await fetch('/api/v1/ai/insights/swot-matrix', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    dimension: 'district'
  })
});
```

## Frontend Dashboard Features

### 1. AI Insights Page
- แสดงข้อมูลรวมจาก dashboard
- เลือกมิติการวิเคราะห์ (Strategy/District/Budget)
- แสดงผลการวิเคราะห์แบบ Real-time

### 2. SWOT Analysis Visualization
- แสดง SWOT Matrix ในรูปแบบ 4 ช่อง
- แสดงผลการวิเคราะห์แต่ละด้าน (S/W/O/T)
- Interactive charts และ graphs

### 3. Export Features
- Export SWOT Report เป็น PDF
- Download analysis results
- Share analysis reports

### 4. Refresh Analysis
- ปุ่ม Refresh Analysis
- Real-time data updates
- Cache management

## Performance Considerations
- AI analysis อาจใช้เวลา 2-5 วินาที
- ควรมี loading states
- ควร cache ผลการวิเคราะห์
- Rate limiting สำหรับ API calls

## Security
- JWT authentication required
- User-specific data access
- Input validation สำหรับ dimension และ targetId
- AI prompt injection protection
