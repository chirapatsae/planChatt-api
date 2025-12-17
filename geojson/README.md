# GeoJSON Data Files

โฟลเดอร์นี้สำหรับเก็บไฟล์ GeoJSON ของข้อมูลภูมิศาสตร์

## ไฟล์ที่ต้องการ

### nakhon-ratchasima-districts.json
ข้อมูลขอบเขตอำเภอในจังหวัดนครราชสีมา

**โครงสร้างข้อมูล:**
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "DISTRICT_ID": "3001",
        "DISTRICT_NAME": "เมืองนครราชสีมา",
        "PROVINCE": "นครราชสีมา",
        "AMPHOE_CODE": "3001"
      },
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [102.0977, 14.9799],
            [102.1000, 14.9800],
            ...
          ]
        ]
      }
    }
  ]
}
```

## แหล่งข้อมูล GeoJSON

### 1. GISTDA (แนะนำ)
- **เว็บไซต์:** https://www.gistda.or.th/
- **ข้อมูล:** ขอบเขตการปกครองของประเทศไทย
- **คุณภาพ:** สูง, อัพเดตเป็นปัจจุบัน

### 2. data.go.th
- **เว็บไซต์:** https://data.go.th/
- **คำค้นหา:** "ขอบเขตอำเภอ" หรือ "administrative boundaries"
- **รูปแบบ:** GeoJSON, Shapefile

### 3. OpenStreetMap
- **เครื่องมือ:** Overpass Turbo (https://overpass-turbo.eu/)
- **Query ตัวอย่าง:**
```
[out:json];
area["name"="นครราชสีมา"]["admin_level"="6"]->.a;
(
  relation["boundary"="administrative"]["admin_level"="7"](area.a);
);
out geom;
```

### 4. GADM
- **เว็บไซต์:** https://gadm.org/
- **ประเทศ:** Thailand
- **ระดับ:** Level 2 (Amphoe/District)
- **รูปแบบ:** GeoJSON, Shapefile

### 5. HDX (Humanitarian Data Exchange)
- **เว็บไซต์:** https://data.humdata.org/
- **คำค้นหา:** "Thailand administrative boundaries"

## การแปลง Shapefile เป็น GeoJSON

ถ้าได้ไฟล์ Shapefile (.shp) มา สามารถแปลงเป็น GeoJSON ได้:

### ใช้ QGIS (ฟรี)
1. เปิด Shapefile ใน QGIS
2. คลิกขวาที่ layer → Export → Save Features As
3. เลือก Format: GeoJSON
4. ตั้งค่า CRS: EPSG:4326 (WGS84)
5. บันทึก

### ใช้ ogr2ogr (Command Line)
```bash
ogr2ogr -f GeoJSON -t_srs EPSG:4326 output.geojson input.shp
```

### ใช้ Online Tools
- **mapshaper:** https://mapshaper.org/
- **MyGeodata Converter:** https://mygeodata.cloud/converter/

## การทดสอบ GeoJSON

### 1. ตรวจสอบ Syntax
- **geojson.io:** https://geojson.io/
- วาง GeoJSON และดูบนแผนที่ทันที

### 2. Validate
- **GeoJSON Validator:** https://geojsonlint.com/
- ตรวจสอบว่า GeoJSON ถูกต้องตาม specification

### 3. Simplify (ถ้าไฟล์ใหญ่เกินไป)
- **mapshaper:** https://mapshaper.org/
- ลดรายละเอียดของ polygon เพื่อเพิ่มประสิทธิภาพ

## ตัวอย่างการใช้งาน

```typescript
// ใน DistrictMap.tsx
const loadGeoJSONData = async () => {
  try {
    const response = await fetch('/geojson/nakhon-ratchasima-districts.json');
    const data = await response.json();
    
    // ตรวจสอบข้อมูล
    console.log('GeoJSON features:', data.features.length);
    
    setGeoJsonData(data);
  } catch (error) {
    console.error('Error loading GeoJSON:', error);
  }
};
```

## หมายเหตุ

- ไฟล์ GeoJSON ควรมีขนาดไม่เกิน 5MB เพื่อประสิทธิภาพ
- ใช้ EPSG:4326 (WGS84) เป็น Coordinate Reference System
- ตรวจสอบให้แน่ใจว่า `DISTRICT_ID` ตรงกับ ID ใน database
- ใช้ encoding UTF-8 เพื่อรองรับภาษาไทย

