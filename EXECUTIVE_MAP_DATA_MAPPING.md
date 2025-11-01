# Executive Map - Data Mapping & Implementation Guide

## 📊 ข้อมูลที่เอามาใช้ (Data Sources)

### 1. **ProjectGroup Entity**
```typescript
{
  // ข้อมูลพื้นฐาน
  id: string
  title: string
  objective: string
  projectYear: number
  
  // 🗺️ ตำแหน่งที่ตั้ง (สำคัญที่สุดสำหรับ Map!)
  startLat: decimal(10,7)    // จุดเริ่มต้นโครงการ
  startLng: decimal(10,7)
  endLat: decimal(10,7)      // จุดสิ้นสุดโครงการ
  endLng: decimal(10,7)
  
  // Relations
  strategy: Strategy         // สำหรับสี marker
  plan: Plan                 // ข้อมูลแผนงาน
  budgetPlan: BudgetPlan     // แผนงบประมาณ
  originAgencyId: LocalAdministrativeOrganization  // สำหรับ clustering ตามอำเภอ
  responsibleAgency: GovernmentAgency
  budgets: Budget[]          // คำนวณงบประมาณรวม
  trackingStatus: TrackingStatus[]  // สถานะปัจจุบัน
}
```

### 2. **LocalAdministrativeOrganization**
```typescript
{
  id: string
  name: string               // ชื่อหน่วยงาน (เช่น "เทศบาลตำบลโนนไทย")
  type: string               // ประเภท (เช่น "เทศบาลตำบล")
  amphoe: Amphoe             // 🎯 ใช้สำหรับ Cluster Markers!
}
```

### 3. **Amphoe**
```typescript
{
  id: string
  name: string               // ชื่ออำเภอ (เช่น "เมืองนครราชสีมา", "โนนไทย")
}
```

### 4. **Strategy**
```typescript
{
  id: string
  name: string               // ชื่อยุทธศาสตร์
  // 🎨 ใช้ id เพื่อ generate สีสำหรับ marker
}
```

## 🔄 Data Transformation Flow

### Step 1: Filter Projects with Location
```typescript
// เอาเฉพาะโครงการที่มีตำแหน่งที่ตั้ง
const hasLocation = (project.startLat && project.startLng) || 
                    (project.endLat && project.endLng);
```

### Step 2: Transform to Marker Format
```typescript
{
  projectId: "uuid",
  title: "ชื่อโครงการ",
  
  // Location Data
  location: {
    latitude: 14.9799,      // Primary location (start > end)
    longitude: 102.0977
  },
  startLocation: {...},     // ถ้ามี
  endLocation: {...},       // ถ้ามี
  
  // Display Data
  budget: 500000.00,        // จาก budgets.reduce(sum)
  status: "Approved",       // จาก trackingStatus[isLatest]
  statusCategory: "approved", // map จาก status
  
  // Strategy (สำหรับสี marker)
  strategy: {
    id: "uuid",
    name: "ยุทธศาสตร์...",
    color: "#FF6B6B"        // Generated from strategyId
  },
  
  // Agency (สำหรับ clustering)
  originAgency: {
    amphoe: "เมืองนครราชสีมา"  // 🎯 Key for clustering!
  }
}
```

### Step 3: Group by Amphoe (Clustering)
```typescript
// จัดกลุ่มตามอำเภอ
const markersByAmphoe = [
  {
    amphoeName: "เมืองนครราชสีมา",
    projectCount: 15,
    totalBudget: 5000000.00,
    center: {
      latitude: avg(markers.latitude),   // คำนวณจุดกลาง
      longitude: avg(markers.longitude)
    },
    markers: [...]  // markers ในอำเภอนี้
  }
]
```

## 🎨 Strategy Color Mapping

### Color Palette (10 colors)
```typescript
const strategyColors = {
  '#FF6B6B': 'Red',          // ยุทธศาสตร์ที่ 1
  '#4ECDC4': 'Teal',         // ยุทธศาสตร์ที่ 2
  '#45B7D1': 'Blue',         // ยุทธศาสตร์ที่ 3
  '#FFA07A': 'Light Salmon', // ยุทธศาสตร์ที่ 4
  '#98D8C8': 'Mint',         // ยุทธศาสตร์ที่ 5
  '#F7DC6F': 'Yellow',       // ยุทธศาสตร์ที่ 6
  '#BB8FCE': 'Purple',       // ยุทธศาสตร์ที่ 7
  '#85C1E2': 'Sky Blue',     // ยุทธศาสตร์ที่ 8
  '#F8B739': 'Orange',       // ยุทธศาสตร์ที่ 9
  '#52B788': 'Green',        // ยุทธศาสตร์ที่ 10
};
```

### Color Generation Algorithm
```typescript
function getStrategyColor(strategyId: string): string {
  const colors = ['#FF6B6B', '#4ECDC4', ...];
  
  // Hash strategyId
  let hash = 0;
  for (let i = 0; i < strategyId.length; i++) {
    hash = strategyId.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Return consistent color
  return colors[Math.abs(hash) % colors.length];
}
```

**เหตุผล**: ยุทธศาสตร์เดียวกันจะได้สีเดียวกันเสมอ (consistent)

## 📍 Location Data Priority

### Logic
```typescript
// Primary location ใช้ start ก่อน
if (startLat && startLng) {
  location = { lat: startLat, lng: startLng };
} else if (endLat && endLng) {
  location = { lat: endLat, lng: endLng };
} else {
  // Skip this project (no location)
}
```

### Use Cases
1. **โครงการก่อสร้างถนน**: มีทั้ง start และ end → วาดเส้นเชื่อม
2. **โครงการก่อสร้างอาคาร**: มีแค่ start → วาง marker ตำแหน่งเดียว
3. **โครงการจัดกิจกรรม**: มีแค่ end → ใช้ตำแหน่ง end

## 🗺️ Map Configuration

### Nakhon Ratchasima Province Center
```typescript
const mapCenter = {
  latitude: 14.9799,      // ศูนย์กลางจังหวัดนครราชสีมา
  longitude: 102.0977,
  zoom: 9                 // เห็นทั้งจังหวัด
};
```

### Zoom Levels
- **Zoom 9**: ดูทั้งจังหวัด (default)
- **Zoom 11**: ดูระดับอำเภอ (cluster view)
- **Zoom 13**: ดูระดับตำบล (individual markers)
- **Zoom 15**: ดูรายละเอียดโครงการ (popup view)

## 📊 Statistics Calculation

### 1. Status Breakdown
```typescript
statusBreakdown: {
  approved: markers.filter(m => m.statusCategory === 'approved').length,
  pending: markers.filter(m => m.statusCategory === 'pending').length,
  rejected: markers.filter(m => m.statusCategory === 'rejected').length
}
```

### 2. Strategy Breakdown
```typescript
strategyBreakdown: {
  "ยุทธศาสตร์ที่ 1": 12,
  "ยุทธศาสตร์ที่ 2": 10,
  ...
}
```

### 3. Location Completeness
```typescript
{
  projectsWithBothLocations: 15,    // มีทั้ง start และ end
  projectsWithStartOnly: 10,        // มีแค่ start
  projectsWithEndOnly: 5            // มีแค่ end
}
```

## 🎯 Implementation Checklist

### Backend (✅ Done)
- [x] Create `/executive/map` endpoint
- [x] Transform projects to markers
- [x] Group markers by amphoe
- [x] Calculate map statistics
- [x] Generate strategy colors
- [x] Handle both original and revised projects

### Frontend (To Do)
- [ ] เลือก Map Library (Leaflet แนะนำ)
- [ ] ติดตั้ง dependencies
- [ ] Setup Map Component
- [ ] Display markers on map
- [ ] Implement marker clustering
- [ ] Create custom marker icons by strategy
- [ ] Add popup with project details
- [ ] Add filter controls (status, strategy, amphoe)
- [ ] Add search functionality
- [ ] Draw routes for projects with both locations

## 🔧 Frontend Implementation Guide

### Using Leaflet + React

#### 1. Install Dependencies
```bash
npm install leaflet react-leaflet
npm install leaflet.markercluster
npm install @types/leaflet @types/leaflet.markercluster
```

#### 2. Basic Map Setup
```tsx
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

function ExecutiveMap({ data }) {
  return (
    <MapContainer
      center={[data.mapCenter.latitude, data.mapCenter.longitude]}
      zoom={data.mapCenter.zoom}
      style={{ height: '100vh', width: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; OpenStreetMap contributors'
      />
      
      {data.markers.map(marker => (
        <Marker
          key={marker.projectId}
          position={[marker.location.latitude, marker.location.longitude]}
        >
          <Popup>
            <h3>{marker.title}</h3>
            <p>งบประมาณ: {marker.budget.toLocaleString()} บาท</p>
            <p>สถานะ: {marker.status}</p>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
```

#### 3. Custom Marker Icons
```tsx
import L from 'leaflet';

function createStrategyIcon(color: string) {
  return L.divIcon({
    className: 'custom-marker',
    html: `
      <div style="
        background-color: ${color};
        width: 25px;
        height: 35px;
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        border: 2px solid white;
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
      "></div>
    `,
    iconSize: [25, 35],
    iconAnchor: [12, 35]
  });
}
```

#### 4. Marker Clustering
```tsx
import MarkerClusterGroup from 'react-leaflet-cluster';

<MarkerClusterGroup>
  {data.markers.map(marker => (
    <Marker
      key={marker.projectId}
      position={[marker.location.latitude, marker.location.longitude]}
      icon={createStrategyIcon(marker.strategy?.color)}
    >
      <Popup>...</Popup>
    </Marker>
  ))}
</MarkerClusterGroup>
```

## 🎨 UI Components Suggestion

### 1. Map Legend
```tsx
<MapLegend>
  {data.strategyColors.map(strategy => (
    <LegendItem
      key={strategy.strategyId}
      color={strategy.color}
      label={strategy.strategyName}
    />
  ))}
</MapLegend>
```

### 2. Filter Panel
```tsx
<FilterPanel>
  <StatusFilter />      // Approved, Pending, Rejected
  <StrategyFilter />    // แยกตามยุทธศาสตร์
  <AmphoeFilter />      // แยกตามอำเภอ
  <SearchBox />         // ค้นหาโครงการ
</FilterPanel>
```

### 3. Statistics Overlay
```tsx
<StatsOverlay>
  <StatCard
    title="โครงการทั้งหมด"
    value={data.projectsWithLocation}
  />
  <StatCard
    title="งบประมาณรวม"
    value={data.statistics.totalBudget.toLocaleString()}
  />
</StatsOverlay>
```

## 💡 Additional Features (Nice to Have)

### 1. Heat Map
- แสดงความหนาแน่นของโครงการ
- ใช้ budget เป็น weight

### 2. Route Drawing
- เชื่อม start → end สำหรับโครงการก่อสร้างถนน
- แสดงระยะทาง

### 3. Time Slider
- Filter โครงการตามปี (projectYear)
- Animation แสดงการเปลี่ยนแปลงตามเวลา

### 4. Export Map
- Save เป็น PNG/PDF
- Print preview

## 📝 Summary

### ข้อมูลหลักที่ใช้:
1. **startLat, startLng, endLat, endLng** → วาง Markers
2. **strategy.id** → สี Marker
3. **originAgency.amphoe.name** → Clustering
4. **budgets** → แสดงในPopup และ Statistics
5. **trackingStatus** → Filter และแสดงสถานะ

### ความสอดคล้อง:
- ✅ ใช้ `budgetPlan.isLatest` และ `developmentPlanRevision.isLatest` เหมือน API อื่นๆ
- ✅ มี `planInfo` สอดคล้องกับทุก endpoint
- ✅ รองรับทั้ง original และ revised projects
- ✅ Status mapping เหมือนกันทั้งระบบ

API นี้พร้อมใช้งานแล้ว! 🚀

