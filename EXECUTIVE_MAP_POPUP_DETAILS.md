# Executive Map - Marker Popup Details

## 📋 รายละเอียดข้อมูลที่แสดงใน Popup

### ✅ ข้อมูลครบถ้วนในแต่ละ Marker

```json
{
  // 1. ข้อมูลพื้นฐานโครงการ
  "projectId": "uuid",
  "title": "โครงการพัฒนาแหล่งน้ำ",
  "objective": "เพื่อพัฒนาแหล่งน้ำในชุมชน",
  "goal": "ชุมชนมีแหล่งน้ำสำรองเพียงพอตลอดปี",
  "indicator": "ปริมาณน้ำสำรองเพิ่มขึ้น",
  "expected": "มีปริมาณน้ำสำรองไม่น้อยกว่า 10,000 ลูกบาศก์เมตร",
  
  // 2. ตำแหน่งที่ตั้ง
  "location": {
    "latitude": 14.9799,
    "longitude": 102.0977
  },
  "startLocation": {...},  // ถ้ามี
  "endLocation": {...},    // ถ้ามี
  
  // 3. งบประมาณ
  "budget": 500000.00,
  "budgetByYear": [
    { "year": 2566, "amount": 300000.00 },
    { "year": 2567, "amount": 200000.00 }
  ],
  
  // 4. สถานะ
  "status": "Approved",
  "statusCategory": "approved",
  
  // 5. แผนงาน/ยุทธศาสตร์/ยุทธวิธี
  "plan": {
    "id": "uuid",
    "name": "แผนการพัฒนาโครงสร้างพื้นฐาน"
  },
  "strategy": {
    "id": "uuid",
    "name": "ยุทธศาสตร์การพัฒนาโครงสร้างพื้นฐาน",
    "color": "#FF6B6B"
  },
  "tactic": {
    "id": "uuid",
    "name": "ยุทธวิธีพัฒนาแหล่งน้ำ"
  },
  
  // 6. หน่วยงาน
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
  
  // 7. ข้อมูลเพิ่มเติม
  "projectYear": 2566,
  "isRevised": false,
  "isDraft": false,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

## 🎨 ตัวอย่าง Popup Design

### HTML Structure
```html
<div class="project-popup">
  <!-- Header -->
  <div class="popup-header">
    <h3 class="project-title">โครงการพัฒนาแหล่งน้ำ</h3>
    <div class="badges">
      <span class="badge badge-approved">อนุมัติแล้ว</span>
      <span class="badge badge-revised">แก้ไข</span>
    </div>
  </div>

  <!-- Main Content -->
  <div class="popup-body">
    <!-- วัตถุประสงค์ -->
    <section class="popup-section">
      <h4>📝 วัตถุประสงค์</h4>
      <p>เพื่อพัฒนาแหล่งน้ำในชุมชน</p>
    </section>

    <!-- เป้าหมาย -->
    <section class="popup-section">
      <h4>🎯 เป้าหมาย</h4>
      <p>ชุมชนมีแหล่งน้ำสำรองเพียงพอตลอดปี</p>
    </section>

    <!-- ตัวชี้วัด -->
    <section class="popup-section">
      <h4>📊 ตัวชี้วัด</h4>
      <p>ปริมาณน้ำสำรองเพิ่มขึ้น</p>
    </section>

    <!-- ผลที่คาดหวัง -->
    <section class="popup-section">
      <h4>✨ ผลที่คาดหวัง</h4>
      <p>มีปริมาณน้ำสำรองไม่น้อยกว่า 10,000 ลูกบาศก์เมตร</p>
    </section>

    <!-- งบประมาณ -->
    <section class="popup-section">
      <h4>💰 งบประมาณ</h4>
      <div class="budget-total">รวม: 500,000 บาท</div>
      <div class="budget-breakdown">
        <div class="budget-year">ปี 2566: 300,000 บาท</div>
        <div class="budget-year">ปี 2567: 200,000 บาท</div>
      </div>
    </section>

    <!-- แผนงาน/ยุทธศาสตร์ -->
    <section class="popup-section">
      <h4>📋 แผนงาน</h4>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">แผน:</span>
          <span class="value">แผนการพัฒนาโครงสร้างพื้นฐาน</span>
        </div>
        <div class="info-item">
          <span class="label">ยุทธศาสตร์:</span>
          <span class="value" style="color: #FF6B6B">
            ยุทธศาสตร์การพัฒนาโครงสร้างพื้นฐาน
          </span>
        </div>
        <div class="info-item">
          <span class="label">ยุทธวิธี:</span>
          <span class="value">ยุทธวิธีพัฒนาแหล่งน้ำ</span>
        </div>
      </div>
    </section>

    <!-- หน่วยงาน -->
    <section class="popup-section">
      <h4>🏢 หน่วยงาน</h4>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">หน่วยงานต้นทาง:</span>
          <span class="value">เทศบาลตำบลโนนไทย</span>
        </div>
        <div class="info-item">
          <span class="label">ประเภท:</span>
          <span class="value">เทศบาลตำบล</span>
        </div>
        <div class="info-item">
          <span class="label">อำเภอ:</span>
          <span class="value">โนนไทย</span>
        </div>
        <div class="info-item">
          <span class="label">ผู้รับผิดชอบ:</span>
          <span class="value">กองช่าง</span>
        </div>
      </div>
    </section>

    <!-- ข้อมูลเพิ่มเติม -->
    <section class="popup-section">
      <h4>ℹ️ ข้อมูลเพิ่มเติม</h4>
      <div class="info-grid">
        <div class="info-item">
          <span class="label">ปีที่ดำเนินการ:</span>
          <span class="value">2566</span>
        </div>
        <div class="info-item">
          <span class="label">สร้างเมื่อ:</span>
          <span class="value">15 ม.ค. 2567</span>
        </div>
      </div>
    </section>
  </div>

  <!-- Footer Actions -->
  <div class="popup-footer">
    <button class="btn-primary" onclick="viewProjectDetail('uuid')">
      ดูรายละเอียดเพิ่มเติม
    </button>
    <button class="btn-secondary" onclick="navigateToProject('uuid')">
      นำทางไปยังโครงการ
    </button>
  </div>
</div>
```

## 🎨 CSS Styling

```css
.project-popup {
  font-family: 'Sarabun', sans-serif;
  max-width: 400px;
  max-height: 600px;
  overflow-y: auto;
}

/* Header */
.popup-header {
  padding: 16px;
  border-bottom: 2px solid #e0e0e0;
}

.project-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: #1a1a1a;
}

.badges {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.badge-approved {
  background: #d4edda;
  color: #155724;
}

.badge-pending {
  background: #fff3cd;
  color: #856404;
}

.badge-rejected {
  background: #f8d7da;
  color: #721c24;
}

.badge-revised {
  background: #cce5ff;
  color: #004085;
}

.badge-draft {
  background: #e2e3e5;
  color: #383d41;
}

/* Body */
.popup-body {
  padding: 16px;
}

.popup-section {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.popup-section:last-child {
  border-bottom: none;
}

.popup-section h4 {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: #333;
}

.popup-section p {
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  color: #666;
}

/* Budget */
.budget-total {
  font-size: 16px;
  font-weight: 600;
  color: #2e7d32;
  margin-bottom: 8px;
}

.budget-breakdown {
  padding-left: 16px;
}

.budget-year {
  font-size: 13px;
  color: #666;
  margin: 4px 0;
}

/* Info Grid */
.info-grid {
  display: grid;
  gap: 8px;
}

.info-item {
  display: flex;
  font-size: 13px;
}

.info-item .label {
  font-weight: 600;
  color: #666;
  min-width: 120px;
}

.info-item .value {
  color: #333;
}

/* Footer */
.popup-footer {
  padding: 16px;
  border-top: 2px solid #e0e0e0;
  display: flex;
  gap: 8px;
}

.btn-primary,
.btn-secondary {
  flex: 1;
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: #1976d2;
  color: white;
}

.btn-primary:hover {
  background: #1565c0;
}

.btn-secondary {
  background: #f5f5f5;
  color: #333;
}

.btn-secondary:hover {
  background: #e0e0e0;
}

/* Scrollbar */
.project-popup::-webkit-scrollbar {
  width: 6px;
}

.project-popup::-webkit-scrollbar-track {
  background: #f1f1f1;
}

.project-popup::-webkit-scrollbar-thumb {
  background: #888;
  border-radius: 3px;
}

.project-popup::-webkit-scrollbar-thumb:hover {
  background: #555;
}
```

## 🔧 React Component Example

```tsx
import { Popup } from 'react-leaflet';

interface MarkerData {
  projectId: string;
  title: string;
  objective: string;
  goal: string;
  indicator: string;
  expected: string;
  budget: number;
  budgetByYear: Array<{ year: number; amount: number }>;
  status: string;
  statusCategory: string;
  strategy: { id: string; name: string; color: string } | null;
  tactic: { id: string; name: string } | null;
  plan: { id: string; name: string } | null;
  originAgency: { name: string; type: string; amphoe: string } | null;
  responsibleAgency: { name: string } | null;
  projectYear: number;
  isRevised: boolean;
  isDraft: boolean;
  createdAt: string;
}

function ProjectPopup({ marker }: { marker: MarkerData }) {
  const handleViewDetail = () => {
    // Navigate to project detail page
    window.location.href = `/projects/${marker.projectId}`;
  };

  return (
    <Popup className="project-popup" maxWidth={400}>
      <div className="popup-header">
        <h3 className="project-title">{marker.title}</h3>
        <div className="badges">
          <span className={`badge badge-${marker.statusCategory}`}>
            {marker.status}
          </span>
          {marker.isRevised && (
            <span className="badge badge-revised">แก้ไข</span>
          )}
          {marker.isDraft && (
            <span className="badge badge-draft">ฉบับร่าง</span>
          )}
        </div>
      </div>

      <div className="popup-body">
        <section className="popup-section">
          <h4>📝 วัตถุประสงค์</h4>
          <p>{marker.objective}</p>
        </section>

        <section className="popup-section">
          <h4>🎯 เป้าหมาย</h4>
          <p>{marker.goal}</p>
        </section>

        <section className="popup-section">
          <h4>💰 งบประมาณ</h4>
          <div className="budget-total">
            รวม: {marker.budget.toLocaleString()} บาท
          </div>
          <div className="budget-breakdown">
            {marker.budgetByYear.map((budget) => (
              <div key={budget.year} className="budget-year">
                ปี {budget.year}: {budget.amount.toLocaleString()} บาท
              </div>
            ))}
          </div>
        </section>

        <section className="popup-section">
          <h4>📋 แผนงาน</h4>
          <div className="info-grid">
            <div className="info-item">
              <span className="label">แผน:</span>
              <span className="value">{marker.plan?.name || '-'}</span>
            </div>
            <div className="info-item">
              <span className="label">ยุทธศาสตร์:</span>
              <span 
                className="value" 
                style={{ color: marker.strategy?.color }}
              >
                {marker.strategy?.name || '-'}
              </span>
            </div>
            <div className="info-item">
              <span className="label">ยุทธวิธี:</span>
              <span className="value">{marker.tactic?.name || '-'}</span>
            </div>
          </div>
        </section>

        <section className="popup-section">
          <h4>🏢 หน่วยงาน</h4>
          <div className="info-grid">
            <div className="info-item">
              <span className="label">หน่วยงาน:</span>
              <span className="value">{marker.originAgency?.name || '-'}</span>
            </div>
            <div className="info-item">
              <span className="label">อำเภอ:</span>
              <span className="value">{marker.originAgency?.amphoe || '-'}</span>
            </div>
            <div className="info-item">
              <span className="label">ผู้รับผิดชอบ:</span>
              <span className="value">{marker.responsibleAgency?.name || '-'}</span>
            </div>
          </div>
        </section>
      </div>

      <div className="popup-footer">
        <button className="btn-primary" onClick={handleViewDetail}>
          ดูรายละเอียดเพิ่มเติม
        </button>
      </div>
    </Popup>
  );
}
```

## 📱 Responsive Design

```css
/* Mobile */
@media (max-width: 768px) {
  .project-popup {
    max-width: 300px;
  }

  .popup-footer {
    flex-direction: column;
  }

  .btn-primary,
  .btn-secondary {
    width: 100%;
  }
}

/* Tablet */
@media (min-width: 769px) and (max-width: 1024px) {
  .project-popup {
    max-width: 350px;
  }
}
```

## ✨ Summary

### ข้อมูลครบถ้วนที่แสดงใน Popup:

1. ✅ **ข้อมูลโครงการ** - ชื่อ, วัตถุประสงค์, เป้าหมาย, ตัวชี้วัด, ผลที่คาดหวัง
2. ✅ **งบประมาณ** - รวมทั้งหมดและแยกตามปี
3. ✅ **สถานะ** - สถานะปัจจุบันพร้อม badge สี
4. ✅ **แผนงาน** - Plan, Strategy, Tactic
5. ✅ **หน่วยงาน** - หน่วยงานต้นทาง, ผู้รับผิดชอบ, อำเภอ
6. ✅ **ข้อมูลเพิ่มเติม** - ปี, สถานะแก้ไข, ฉบับร่าง
7. ✅ **Actions** - ปุ่มดูรายละเอียดเพิ่มเติม

คุณสามารถนำ CSS และ Component ข้างบนไปใช้งานได้เลยครับ! 🚀

