# Announcement System

## Overview
This announcement system provides a comprehensive solution for managing announcements, role-based targeting, and push notification tracking in a NestJS application.

## Architecture

### Core Entities

#### 1. Announcement (`announcements`)
- **Purpose**: Stores announcement information including content, scheduling, and status
- **Key Fields**:
  - `title`: Announcement title (required)
  - `description`: Detailed content
  - `status`: Draft, Scheduled, or Published
  - `startDate`/`endDate`: Validity period
  - `location`: Optional location information
  - `publishDateTime`: When to start push notifications (only for SCHEDULED)
  - `notificationStatus`: Pending, Sent, or Failed
  - `createdByWorkHistoryId`: Reference to the work history record of the admin who created it

#### 2. Role (`roles`)
- **Purpose**: Defines user roles and permissions
- **Key Fields**:
  - `name`: Role name (admin, staff, user, etc.)
  - `announcementRoles`: Many-to-many relationship with announcements
  - `notificationLogs`: History of notifications sent to this role

#### 3. AnnouncementRole (`announcement_roles`)
- **Purpose**: Junction table for many-to-many relationship between announcements and roles
- **Key Fields**:
  - `announcementId`: Reference to announcement
  - `roleId`: Reference to role

#### 4. NotificationLog (`notification_logs`)
- **Purpose**: Tracks push notification delivery history
- **Key Fields**:
  - `announcementId`: Reference to announcement
  - `roleId`: Reference to role
  - `sentAt`: When notification was sent
  - `status`: Success or Failed
  - `errorMessage`: Error details if failed

### Database Schema

```sql
-- Announcements table
announcements (
  id UUID PK,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status ENUM('draft','scheduled','published') DEFAULT 'draft',
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  location TEXT,
  publish_date_time TIMESTAMP,
  notification_status ENUM('pending','sent','failed') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  created_by_work_history_id UUID
)

-- Announcement-Roles junction table
announcement_roles (
  id UUID PK,
  announcement_id UUID FK -> announcements.id ON DELETE CASCADE,
  role_id UUID FK -> roles.id ON DELETE CASCADE
)

-- Notification logs table
notification_logs (
  id UUID PK,
  announcement_id UUID FK -> announcements.id ON DELETE CASCADE,
  role_id UUID FK -> roles.id,
  sent_at TIMESTAMP,
  status ENUM('success','failed'),
  error_message TEXT
)
```

## Business Logic

### Status Management

#### 1. DRAFT (ร่าง)
- **แก้ไขได้**: ทุกอย่าง (title, description, dates, roles)
- **publishDateTime**: ไม่ต้องมี
- **Notifications**: ไม่ส่ง
- **ใช้เมื่อ**: ร่างประกาศ, รอการอนุมัติ

#### 2. SCHEDULED (กำหนดเวลา)
- **แก้ไขได้**: ทุกอย่าง
- **publishDateTime**: **บังคับ** ต้องมี
- **Notifications**: ไม่ส่ง (รอถึงเวลา)
- **ใช้เมื่อ**: ประกาศล่วงหน้า, ต้องการควบคุมเวลา

#### 3. PUBLISHED (เผยแพร่ทันที)
- **แก้ไขได้**: **แก้ไขไม่ได้** (เพื่อความปลอดภัย)
- **publishDateTime**: **ไม่ต้องมี** (เพราะเผยแพร่ทันที)
- **Notifications**: ส่งทันที
- **ใช้เมื่อ**: เผยแพร่ทันที, ไม่ต้องการรอเวลา

### Flow การทำงาน

#### Flow 1: DRAFT → PUBLISHED (ทันที)
```
1. สร้างประกาศเป็น DRAFT
2. เปลี่ยนเป็น PUBLISHED
3. notificationStatus = 'pending'
4. ส่ง notifications ทันที
5. เปลี่ยน notificationStatus = 'sent'
```

#### Flow 2: DRAFT → SCHEDULED → PUBLISHED (รอเวลา)
```
1. สร้างประกาศเป็น DRAFT
2. เปลี่ยนเป็น SCHEDULED + กำหนด publishDateTime
3. รอจนถึงเวลา
4. ระบบเปลี่ยนเป็น PUBLISHED อัตโนมัติ
5. notificationStatus = 'pending'
6. ส่ง notifications
7. เปลี่ยน notificationStatus = 'sent'
```

### Cron Job (ทุก 5 นาที)

```
1. ตรวจสอบ SCHEDULED ที่ถึงเวลา
2. เปลี่ยน Status: SCHEDULED → PUBLISHED
3. เปลี่ยน notificationStatus: null → 'pending'
4. ส่ง Notifications
5. อัปเดท notificationStatus: 'pending' → 'sent'/'failed'
```

## API Endpoints

### Announcements

#### Create Announcement
```http
POST /announcements
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Important Update",
  "description": "System maintenance scheduled",
  "status": "scheduled",
  "startDate": "2024-01-15T00:00:00Z",
  "endDate": "2024-01-16T00:00:00Z",
  "publishDateTime": "2024-01-15T08:00:00Z",
  "roleIds": ["uuid1", "uuid2"]
}
```

**Business Rules**:
- `status = "draft"`: ไม่ต้องมี `publishDateTime`
- `status = "scheduled"`: ต้องมี `publishDateTime`
- `status = "published"`: ไม่ต้องมี `publishDateTime`

#### Get All Announcements
```http
GET /announcements
Authorization: Bearer <token>
```

#### Get Announcements by Status
```http
GET /announcements/status/published
Authorization: Bearer <token>
```

#### Get Announcements by Role
```http
GET /announcements/role/{roleId}
Authorization: Bearer <token>
```

#### Get Announcements by Work History
```http
GET /announcements/work-history/{workHistoryId}
Authorization: Bearer <token>
```

#### Get Pending Notifications
```http
GET /announcements/pending-notifications
Authorization: Bearer <token>
```

#### Update Announcement
```http
PATCH /announcements/{id}
Authorization: Bearer <token>
Content-Type: application/json

{
  "status": "published",
  "roleIds": ["uuid1", "uuid3"]
}
```

**Note**: PUBLISHED announcements cannot be updated

#### Delete Announcement
```http
DELETE /announcements/{id}
Authorization: Bearer <token>
```

### Announcement Roles

#### Get Roles for Announcement
```http
GET /announcement-roles/announcement/{announcementId}
Authorization: Bearer <token>
```

#### Get Announcements for Role
```http
GET /announcement-roles/role/{roleId}
Authorization: Bearer <token>
```

### Notification Logs

#### Get Notification History
```http
GET /notification-logs
Authorization: Bearer <token>
```

#### Get Notifications by Announcement
```http
GET /notification-logs/announcement/{announcementId}
Authorization: Bearer <token>
```

#### Get Notifications by Role
```http
GET /notification-logs/role/{roleId}
Authorization: Bearer <token>
```

#### Get Notifications by Status
```http
GET /notification-logs/status/success
Authorization: Bearer <token>
```

### Notifications

#### Send Immediate Notifications
```http
POST /notifications/send/{announcementId}
Authorization: Bearer <token>
```

#### Check Service Status
```http
GET /notifications/status
Authorization: Bearer <token>
```

## Features

### 1. Role-Based Targeting
- Announcements can be targeted to specific user roles
- Many-to-many relationship allows flexible role assignment
- Easy to add/remove roles from announcements

### 2. Scheduling System
- Support for draft, scheduled, and published states
- Automatic status change from SCHEDULED to PUBLISHED
- Cron job runs every 5 minutes to check for scheduled announcements

### 3. Push Notification Tracking
- Comprehensive logging of all notification attempts
- Success/failure tracking with error messages
- Historical data for analytics and debugging

### 4. Work History Integration
- Announcements are linked to work history records instead of users directly
- Provides better context about when and where the announcement was created
- Maintains historical relationship between announcements and organizational structure

### 5. Status Management
- Lifecycle management from draft to published
- Notification status tracking (pending, sent, failed)
- Automatic status updates based on scheduling

### 6. Business Logic Validation
- DRAFT: No publishDateTime required
- SCHEDULED: publishDateTime required
- PUBLISHED: No publishDateTime allowed
- PUBLISHED: Cannot be updated

## Usage Examples

### Creating a Scheduled Announcement
```typescript
const announcement = await announcementsService.create({
  title: "System Maintenance",
  description: "Scheduled maintenance on Sunday",
  status: AnnouncementStatus.SCHEDULED,
  startDate: "2024-01-21T00:00:00Z",
  endDate: "2024-01-21T06:00:00Z",
  publishDateTime: "2024-01-20T18:00:00Z",
  roleIds: ["admin-role-id", "staff-role-id"]
}, userId);
```

### Creating an Immediate Published Announcement
```typescript
const announcement = await announcementsService.create({
  title: "Urgent Update",
  description: "System will be down in 1 hour",
  status: AnnouncementStatus.PUBLISHED,
  roleIds: ["admin-role-id", "staff-role-id"]
}, userId);
// No publishDateTime needed, notifications sent immediately
```

### Sending Immediate Notifications
```typescript
// Send notifications immediately for a published announcement
await notificationsService.sendImmediateNotification(announcementId);
```

### Querying Announcements by Work History
```typescript
// Get all announcements created by a specific work history record
const workHistoryAnnouncements = await announcementsService.findByWorkHistory(workHistoryId);
```

### Querying Announcements by Role
```typescript
// Get all announcements visible to a specific role
const roleAnnouncements = await announcementsService.findByRole(roleId);
```

## Security

- All endpoints are protected with `JwtAuthGuard`
- User authentication required for all operations
- Role-based access control through the existing role system
- Soft delete support for data integrity
- PUBLISHED announcements cannot be updated

## Dependencies

- `@nestjs/typeorm`: Database ORM
- `@nestjs/schedule`: Cron job scheduling
- `class-validator`: DTO validation
- `class-transformer`: Data transformation

## Future Enhancements

1. **Real Push Notification Integration**: Replace simulation with FCM/APNS
2. **Email Notifications**: Add email support alongside push notifications
3. **Notification Templates**: Predefined templates for common announcement types
4. **Analytics Dashboard**: Track notification delivery rates and user engagement
5. **Bulk Operations**: Support for sending multiple announcements simultaneously
6. **Notification Preferences**: User-level notification settings
7. **Webhook Support**: External system integration for real-time updates

## Database Migration

To create the necessary tables, run the following SQL:

```sql
-- Create enum types
CREATE TYPE announcement_status AS ENUM ('draft', 'scheduled', 'published');
CREATE TYPE notification_status AS ENUM ('pending', 'sent', 'failed');
CREATE TYPE notification_log_status AS ENUM ('success', 'failed');

-- Create tables
CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status announcement_status DEFAULT 'draft',
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  location TEXT,
  publish_date_time TIMESTAMP,
  notification_status notification_status DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  created_by_work_history_id UUID,
  deleted_at TIMESTAMP
);

CREATE TABLE announcement_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID REFERENCES announcements(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE
);

CREATE TABLE notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID REFERENCES announcements(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  sent_at TIMESTAMP NOT NULL,
  status notification_log_status NOT NULL,
  error_message TEXT
);

-- Create indexes
CREATE INDEX idx_announcements_status ON announcements(status);
CREATE INDEX idx_announcements_notification_status ON announcements(notification_status);
CREATE INDEX idx_announcements_publish_date ON announcements(publish_date_time);
CREATE INDEX idx_announcements_work_history ON announcements(created_by_work_history_id);
CREATE INDEX idx_announcement_roles_announcement ON announcement_roles(announcement_id);
CREATE INDEX idx_announcement_roles_role ON announcement_roles(role_id);
CREATE INDEX idx_notification_logs_announcement ON notification_logs(announcement_id);
CREATE INDEX idx_notification_logs_role ON notification_logs(role_id);
CREATE INDEX idx_notification_logs_status ON notification_logs(status);
``` 