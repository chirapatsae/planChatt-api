# Executive Interactive Map API Documentation

## Endpoint: `/api/v1/project-groups/executive/map`

### Description
API endpoint สำหรับ Interactive Map ที่แสดงโครงการบนแผนที่จังหวัดนครราชสีมา พร้อมข้อมูลตำแหน่ง, markers, clustering และ statistics

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
  
  "mapCenter": {
    "latitude": 14.9799,
    "longitude": 102.0977,
    "zoom": 9
  },
  
  "markers": [
    {
      "projectId": "uuid",
      "title": "โครงการพัฒนาแหล่งน้ำ",
      "objective": "เพื่อพัฒนาแหล่งน้ำในชุมชน",
      "goal": "ชุมชนมีแหล่งน้ำสำรองเพียงพอตลอดปี",
      "indicator": "ปริมาณน้ำสำรองเพิ่มขึ้น",
      "expected": "มีปริมาณน้ำสำรองไม่น้อยกว่า 10,000 ลูกบาศก์เมตร",
      
      "startLocation": {
        "latitude": 14.9799,
        "longitude": 102.0977,
        "type": "start"
      },
      
      "endLocation": {
        "latitude": 15.0123,
        "longitude": 102.1234,
        "type": "end"
      },
      
      "location": {
        "latitude": 14.9799,
        "longitude": 102.0977
      },
      
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
        "name": "เทศบาลตำบลโนนไทย",
        "type": "เทศบาลตำบล",
        "amphoe": "โนนไทย"
      },
      
      "responsibleAgency": {
        "id": "uuid",
        "name": "กองช่าง"
      },
      
      "isRevised": false,
      "isDraft": false,
      "projectYear": 2566,
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  
  "markersByAmphoe": [
    {
      "amphoeName": "เมืองนครราชสีมา",
      "projectCount": 15,
      "totalBudget": 5000000.00,
      "center": {
        "latitude": 14.9799,
        "longitude": 102.0977
      },
      "markers": [...]
    },
    {
      "amphoeName": "โนนไทย",
      "projectCount": 8,
      "totalBudget": 2500000.00,
      "center": {
        "latitude": 15.2123,
        "longitude": 102.5678
      },
      "markers": [...]
    }
  ],
  
  "statistics": {
    "totalBudget": 15000000.00,
    "averageBudget": 500000.00,
    "statusBreakdown": {
      "approved": 20,
      "pending": 8,
      "rejected": 2
    },
    "strategyBreakdown": {
      "ยุทธศาสตร์การพัฒนาโครงสร้างพื้นฐาน": 12,
      "ยุทธศาสตร์การพัฒนาสังคม": 10,
      "ยุทธศาสตร์การพัฒนาเศรษฐกิจ": 8
    },
    "projectsWithBothLocations": 15,
    "projectsWithStartOnly": 10,
    "projectsWithEndOnly": 5
  },
  
  "strategyColors": [
    {
      "strategyId": "uuid",
      "strategyName": "ยุทธศาสตร์การพัฒนาโครงสร้างพื้นฐาน",
      "color": "#FF6B6B"
    }
  ],
  
  "totalProjects": 50,
  "projectsWithLocation": 30,
  "projectsWithoutLocation": 20
}
```

## Data Mapping

### ข้อมูลที่ใช้จากฐานข้อมูล

#### 1. **Location Data (ตำแหน่งที่ตั้งโครงการ)**
- `startLat`, `startLng`: ตำแหน่งเริ่มต้นโครงการ (latitude, longitude)
- `endLat`, `endLng`: ตำแหน่งสิ้นสุดโครงการ (latitude, longitude)
- **เหตุผล**: ใช้สำหรับวาง marker บนแผนที่ และแสดงเส้นทางถ้ามีทั้ง start และ end

#### 2. **Strategy (ยุทธศาสตร์)**
- ใช้สำหรับ: **Custom Marker Icons**
- แต่ละยุทธศาสตร์จะมีสีเฉพาะ (generated จาก strategyId)
- ช่วยให้แยกแยะโครงการตามยุทธศาสตร์ได้ง่าย

#### 3. **Origin Agency & Amphoe (หน่วยงานต้นทางและอำเภอ)**
- ใช้สำหรับ: **Cluster Markers**
- จัดกลุ่มโครงการตามอำเภอ
- คำนวณจุดศูนย์กลาง (center) ของแต่ละอำเภอ

#### 4. **Budget & Status (งบประมาณและสถานะ)**
- แสดงใน: **Popup รายละเอียดโครงการ**
- ใช้สำหรับ: กรองและแสดงสถิติบนแผนที่

#### 5. **Plan Information (ข้อมูลแผน)**
- ใช้เพื่อ: ระบุว่ากำลังดูข้อมูลจากแผนหลัก (main) หรือแผนแก้ไข (revision)
- สอดคล้องกับ API อื่นๆ (budget, plan-analysis)

## Features

### 1. **Map Center**
- จุดศูนย์กลางแผนที่: จังหวัดนครราชสีมา
- Latitude: 14.9799, Longitude: 102.0977
- Default Zoom: 9

### 2. **Markers**
- แต่ละ marker แสดงโครงการ 1 โครงการ
- มีทั้ง `startLocation` และ `endLocation` (ถ้ามี)
- `location` (primary) ใช้ start ถ้ามี, ไม่งั้นใช้ end

### 3. **Cluster Markers**
- จัดกลุ่มโครงการตามอำเภอ
- แสดงจำนวนโครงการและงบประมาณรวมในแต่ละอำเภอ
- คำนวณจุดศูนย์กลางของ cluster อัตโนมัติ

### 4. **Custom Marker Icons**
- สีของ marker ตามยุทธศาสตร์
- 10 สีที่แตกต่างกัน (เพียงพอสำหรับยุทธศาสตร์ทั้งหมด)
- สีสอดคล้องกันเสมอ (hash จาก strategyId)

### 5. **Statistics**
- งบประมาณรวมและเฉลี่ย
- แยกตามสถานะ (approved, pending, rejected)
- แยกตามยุทธศาสตร์
- นับโครงการที่มีตำแหน่งครบ/ไม่ครบ

## Usage Examples

### 1. Display Map with Markers
```javascript
// Using Leaflet
const map = L.map('map').setView(
  [mapData.mapCenter.latitude, mapData.mapCenter.longitude],
  mapData.mapCenter.zoom
);

// Add markers
mapData.markers.forEach(marker => {
  const icon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="background-color: ${marker.strategy?.color}"></div>`
  });
  
  L.marker([marker.location.latitude, marker.location.longitude], { icon })
    .addTo(map)
    .bindPopup(`
      <div class="project-popup">
        <h3>${marker.title}</h3>
        <div class="popup-section">
          <strong>วัตถุประสงค์:</strong>
          <p>${marker.objective}</p>
        </div>
        <div class="popup-section">
          <strong>เป้าหมาย:</strong>
          <p>${marker.goal}</p>
        </div>
        <div class="popup-section">
          <strong>งบประมาณรวม:</strong> ${marker.budget.toLocaleString()} บาท
          ${marker.budgetByYear.map(b => 
            `<div>ปี ${b.year}: ${b.amount.toLocaleString()} บาท</div>`
          ).join('')}
        </div>
        <div class="popup-section">
          <strong>สถานะ:</strong> 
          <span class="status-${marker.statusCategory}">${marker.status}</span>
        </div>
        <div class="popup-section">
          <strong>แผนงาน:</strong> ${marker.plan?.name || '-'}<br>
          <strong>ยุทธศาสตร์:</strong> ${marker.strategy?.name || '-'}<br>
          <strong>ยุทธวิธี:</strong> ${marker.tactic?.name || '-'}
        </div>
        <div class="popup-section">
          <strong>หน่วยงานต้นทาง:</strong> ${marker.originAgency?.name || '-'}<br>
          <strong>อำเภอ:</strong> ${marker.originAgency?.amphoe || '-'}<br>
          <strong>ผู้รับผิดชอบ:</strong> ${marker.responsibleAgency?.name || '-'}
        </div>
        <div class="popup-section">
          <strong>ปีที่ดำเนินการ:</strong> ${marker.projectYear}
          ${marker.isRevised ? '<span class="badge-revised">แก้ไข</span>' : ''}
          ${marker.isDraft ? '<span class="badge-draft">ฉบับร่าง</span>' : ''}
        </div>
        <button onclick="viewProjectDetail('${marker.projectId}')">
          ดูรายละเอียดเพิ่มเติม
        </button>
      </div>
    `);
});
```

### 2. Cluster Markers by Amphoe
```javascript
// Using Leaflet MarkerCluster
const clusterGroup = L.markerClusterGroup();

mapData.markersByAmphoe.forEach(amphoe => {
  const clusterMarker = L.marker(
    [amphoe.center.latitude, amphoe.center.longitude]
  ).bindPopup(`
    <h3>${amphoe.amphoeName}</h3>
    <p>โครงการ: ${amphoe.projectCount} โครงการ</p>
    <p>งบประมาณรวม: ${amphoe.totalBudget.toLocaleString()} บาท</p>
  `);
  
  clusterGroup.addLayer(clusterMarker);
});

map.addLayer(clusterGroup);
```

### 3. Custom Marker Icons by Strategy
```javascript
// Create icon for each strategy
const strategyIcons = {};
mapData.strategyColors.forEach(strategy => {
  strategyIcons[strategy.strategyId] = L.divIcon({
    className: 'strategy-marker',
    html: `
      <div class="marker-pin" style="background-color: ${strategy.color}">
        <span>${strategy.strategyName[0]}</span>
      </div>
    `,
    iconSize: [30, 42],
    iconAnchor: [15, 42]
  });
});

// Use icon when adding marker
mapData.markers.forEach(marker => {
  const icon = strategyIcons[marker.strategy?.id] || defaultIcon;
  L.marker([marker.location.latitude, marker.location.longitude], { icon })
    .addTo(map);
});
```

### 4. Filter Projects on Map
```javascript
// Filter by status
const approvedMarkers = mapData.markers.filter(
  m => m.statusCategory === 'approved'
);

// Filter by strategy
const infrastructureProjects = mapData.markers.filter(
  m => m.strategy?.name.includes('โครงสร้างพื้นฐาน')
);

// Filter by amphoe
const amphoeMarkers = mapData.markersByAmphoe.find(
  a => a.amphoeName === 'เมืองนครราชสีมา'
)?.markers || [];
```

### 5. Show Route (if both start and end locations exist)
```javascript
mapData.markers
  .filter(m => m.startLocation && m.endLocation)
  .forEach(marker => {
    const route = L.polyline([
      [marker.startLocation.latitude, marker.startLocation.longitude],
      [marker.endLocation.latitude, marker.endLocation.longitude]
    ], {
      color: marker.strategy?.color || '#3388ff',
      weight: 3,
      opacity: 0.7
    }).addTo(map);
    
    route.bindPopup(`เส้นทางโครงการ: ${marker.title}`);
  });
```

## Map Libraries Recommendation

### 1. **Leaflet** (แนะนำ)
- Open Source, Free
- เบา, รวดเร็ว
- Plugin ecosystem ดี (MarkerCluster, Heatmap, etc.)
- ไม่ต้องใช้ API Key

```bash
npm install leaflet react-leaflet
npm install leaflet.markercluster
```

### 2. **Mapbox**
- สวยงาม, Customizable
- ต้องใช้ API Key (Free tier: 50,000 loads/month)
- 3D features

```bash
npm install mapbox-gl react-map-gl
```

### 3. **Google Maps**
- คุ้นเคย, Familiar UX
- ต้องใช้ API Key (ราคาแพง)
- Features ครบ

```bash
npm install @react-google-maps/api
```

## Key Benefits

### 1. **Geospatial Visualization**
- เห็นการกระจายตัวของโครงการบนแผนที่
- วิเคราะห์พื้นที่ที่ต้องการการพัฒนา

### 2. **Clustering Support**
- จัดกลุ่มโครงการตามอำเภอ
- แสดง overview ได้ง่าย

### 3. **Strategy-Based Markers**
- แยกสีตามยุทธศาสตร์
- มองเห็นการกระจายของแต่ละยุทธศาสตร์

### 4. **Interactive Popup**
- รายละเอียดโครงการครบถ้วน
- Budget, Status, Agency ทุกอย่างอยู่ใน Popup

### 5. **Flexible Filtering**
- กรองตามสถานะ, ยุทธศาสตร์, อำเภอ
- Search โครงการตามชื่อหรือพื้นที่

## Performance Considerations

- ใช้ Marker Clustering สำหรับโครงการจำนวนมาก
- Lazy load markers เมื่อ zoom เข้า
- Cache strategyColors สำหรับ marker icons
- ใช้ WebWorker สำหรับ calculate center points

## Related Endpoints

- `/api/v1/project-groups/executive/budget` - Budget Dashboard
- `/api/v1/project-groups/executive/plan` - Plan Analysis
- `/api/v1/project-groups/executive/strategies` - Strategy Overview

## Error Handling

- `401 Unauthorized`: ไม่มีสิทธิ์เข้าถึง
- `404 Not Found`: ไม่พบแผนงบประมาณ
- `403 Forbidden`: Role ไม่ถูกต้อง

