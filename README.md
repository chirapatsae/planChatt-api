# ระบบจัดการโครงการของรัฐบาล (Government Project Management System)

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

## 📋 คำอธิบาย

ระบบจัดการโครงการของรัฐบาลที่พัฒนาด้วย NestJS เป็นแพลตฟอร์มสำหรับการจัดการโครงการ งบประมาณ และการติดตามสถานะของโครงการต่างๆ ของหน่วยงานภาครัฐ โดยมีฟีเจอร์หลักดังนี้:

### 🚀 ฟีเจอร์หลัก
- **การจัดการผู้ใช้และสิทธิ์** - ระบบจัดการผู้ใช้ พร้อมระบบ Authentication และ Authorization
- **การจัดการโครงการ** - ระบบจัดการข้อมูลโครงการ กลยุทธ์ แผนงาน และยุทธวิธี
- **การจัดการงบประมาณ** - ระบบติดตามและจัดการงบประมาณโครงการ
- **การติดตามสถานะ** - ระบบติดตามสถานะและความคืบหน้าของโครงการ
- **การสร้างรายงาน PDF** - ระบบสร้างรายงานโครงการในรูปแบบ PDF
- **ระบบ AI** - ระบบ AI สำหรับช่วยในการจัดการและวิเคราะห์ข้อมูล
- **การจัดการพื้นที่** - ระบบจัดการข้อมูลอำเภอ และองค์กรปกครองส่วนท้องถิ่น

## 🛠️ เทคโนโลยีที่ใช้

- **Backend Framework**: NestJS (Node.js)
- **Database**: PostgreSQL
- **ORM**: TypeORM
- **Authentication**: JWT + Passport
- **PDF Generation**: PDFMake
- **AI Integration**: OpenAI API
- **Email Service**: Nodemailer
- **Testing**: Jest
- **Containerization**: Docker

## 📦 การติดตั้ง

### ความต้องการของระบบ
- Node.js 18+
- PostgreSQL 12+
- npm หรือ yarn

### ขั้นตอนการติดตั้ง

1. **Clone โปรเจกต์**
```bash
git clone <repository-url>
cd server_new
```

2. **ติดตั้ง Dependencies**
```bash
npm install
```

3. **ตั้งค่าฐานข้อมูล**
- สร้างฐานข้อมูล PostgreSQL ชื่อ `project_bank`
- ตั้งค่า connection string ใน `src/app.module.ts`

4. **ตั้งค่า Environment Variables**
สร้างไฟล์ `.env` ในโฟลเดอร์หลัก:
```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password
DB_DATABASE=project_bank

# JWT
JWT_SECRET=your_jwt_secret
LOGIN_SECRET=your_login_secret

# Email
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_email_password

# OpenAI
OPENAI_API_KEY=your_openai_api_key

# Encryption
ALGORITHM=aes-256-cbc
SECRET_KEY=your_secret_key
SALT=your_salt
```

## 🚀 การรันโปรเจกต์

### Development Mode
```bash
npm run start:dev
```

### Production Mode
```bash
npm run build
npm run start:prod
```

### Debug Mode
```bash
npm run start:debug
```

## 🧪 การทดสอบ

### Unit Tests
```bash
npm run test
```

### E2E Tests
```bash
npm run test:e2e
```

### Test Coverage
```bash
npm run test:cov
```

## 📁 โครงสร้างโปรเจกต์

```
src/
├── ai/                          # ระบบ AI
├── auth/                        # ระบบ Authentication
├── budget/                      # ระบบจัดการงบประมาณ
├── budget_plan/                 # ระบบแผนงบประมาณ
├── comments/                    # ระบบความคิดเห็น
├── government-agencies/         # ระบบหน่วยงานรัฐ
├── local-administrative-organizations/  # ระบบองค์กรปกครองส่วนท้องถิ่น
├── pdf/                        # ระบบสร้าง PDF
├── plan/                       # ระบบแผนงาน
├── positions/                  # ระบบตำแหน่งงาน
├── project-groups/             # ระบบกลุ่มโครงการ
├── roles/                      # ระบบบทบาท
├── status/                     # ระบบสถานะ
├── strategy/                   # ระบบกลยุทธ์
├── tactic/                     # ระบบยุทธวิธี
├── tracking-status/            # ระบบติดตามสถานะ
├── users/                      # ระบบผู้ใช้
├── work-history/               # ระบบประวัติงาน
├── work-status/                # ระบบสถานะงาน
└── util/                       # ระบบยูทิลิตี้
```

## 🔧 API Endpoints

### Authentication
- `POST /api/v1/auth/login` - เข้าสู่ระบบ
- `POST /api/v1/auth/register` - ลงทะเบียน

### Users
- `GET /api/v1/users` - ดึงข้อมูลผู้ใช้
- `POST /api/v1/users` - สร้างผู้ใช้ใหม่
- `PUT /api/v1/users/:id` - อัปเดตข้อมูลผู้ใช้
- `DELETE /api/v1/users/:id` - ลบผู้ใช้

### Projects
- `GET /api/v1/work-history` - ดึงข้อมูลโครงการ
- `POST /api/v1/work-history` - สร้างโครงการใหม่
- `PUT /api/v1/work-history/:id` - อัปเดตโครงการ
- `DELETE /api/v1/work-history/:id` - ลบโครงการ

### Budget
- `GET /api/v1/budget` - ดึงข้อมูลงบประมาณ
- `POST /api/v1/budget` - สร้างงบประมาณใหม่
- `PUT /api/v1/budget/:id` - อัปเดตงบประมาณ

### PDF Generation
- `POST /api/v1/pdf/generate` - สร้างรายงาน PDF

### AI Services
- `POST /api/v1/ai/generate-project` - สร้างโครงการด้วย AI

## 🐳 การ Deploy ด้วย Docker

### Build Docker Image
```bash
docker build -t government-project-api .
```

### Run Docker Container
```bash
docker run -p 3000:3000 government-project-api
```

## 🔒 ความปลอดภัย

- **JWT Authentication** - ระบบยืนยันตัวตนด้วย JWT
- **Role-based Access Control** - ระบบควบคุมสิทธิ์ตามบทบาท
- **Input Validation** - การตรวจสอบข้อมูลนำเข้า
- **SQL Injection Protection** - การป้องกัน SQL Injection ผ่าน TypeORM
- **CORS Configuration** - การตั้งค่า CORS สำหรับความปลอดภัย

## 📊 การติดตามและ Logging

- **User Activity Logs** - บันทึกกิจกรรมของผู้ใช้
- **AI Usage Logs** - บันทึกการใช้งาน AI
- **Error Handling** - การจัดการข้อผิดพลาด
- **Health Check** - ระบบตรวจสอบสถานะ API

## 🤝 การมีส่วนร่วม

1. Fork โปรเจกต์
2. สร้าง Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit การเปลี่ยนแปลง (`git commit -m 'Add some AmazingFeature'`)
4. Push ไปยัง Branch (`git push origin feature/AmazingFeature`)
5. เปิด Pull Request

## 📝 License

โปรเจกต์นี้เป็นส่วนหนึ่งของระบบจัดการโครงการของรัฐบาล

## 📞 การติดต่อ

หากมีคำถามหรือต้องการความช่วยเหลือ กรุณาติดต่อทีมพัฒนา

---

**หมายเหตุ**: โปรเจกต์นี้พัฒนาด้วย NestJS และใช้สำหรับการจัดการโครงการของหน่วยงานภาครัฐ
