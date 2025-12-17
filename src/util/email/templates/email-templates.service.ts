import { Injectable } from '@nestjs/common';
import { ProjectListData } from '../dto/email.dto';
import { DevelopmentPlan } from 'src/development-plan/entities/development-plan.entity';


@Injectable()
export class EmailTemplatesService {
  

  /**
   * สร้าง HTML template สำหรับรายการโครงการ
   */
  generateProjectListHTML(projects: ProjectListData[], developmentPlan: DevelopmentPlan, workHistory: string, totalCount: number): string {

    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Project Bank System - การส่งโครงการ</title>
    </head>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 1000px; margin: 0 auto;">
      
      <!-- Header -->
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">🏛️ Project Bank System</h1>
        <p style="margin: 10px 0 0 0; opacity: 0.9;">ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ</p>
      </div>

      <!-- Main Content -->
      <div style="background: #ffffff; padding: 30px; border: 1px solid #e1e5e9; border-top: none;">
        
        <div style="background-color: #f8f9fa; padding: 25px; border-radius: 8px; margin: 25px 0; border-left: 4px solid #28a745;">
          <p style="margin: 0; color: #333; font-size: 16px; line-height: 1.8;">
            คุณได้นำส่งโครงการของ <strong>${workHistory}</strong> จำนวน <strong>${totalCount}</strong> รายการ เรียบร้อยแล้ว ตาม${developmentPlan.name} <strong>${developmentPlan.startYear} - ${developmentPlan.endYear}</strong>
          </p>
        </div>

        <div style="margin: 25px 0;">
          <h2 style="color: #2c3e50; margin-bottom: 20px; text-align: center;">📋 โครงการ</h2>
          
          <div style="background: #ffffff; border: 1px solid #e1e5e9; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
                  <th style="padding: 15px; text-align: left; font-weight: bold;">ลำดับ</th>
                  <th style="padding: 15px; text-align: left; font-weight: bold;">ชื่อโครงการ</th>
                  <th style="padding: 15px; text-align: left; font-weight: bold;">ผู้เขียน</th>
                </tr>
              </thead>
              <tbody>
                ${projects.map((project, index) => `
                  <tr style="border-bottom: 1px solid #e1e5e9; ${index % 2 === 0 ? 'background-color: #f8f9fa;' : 'background-color: #ffffff;'}">
                    <td style="padding: 15px; font-weight: bold; color: #667eea;">${index + 1}</td>
                    <td style="padding: 15px; color: #2c3e50; font-weight: 500;">${project.title}</td>
                    <td style="padding: 15px; color: #6c757d;">${project.createdBy}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 10px 10px; border: 1px solid #e1e5e9; border-top: none;">
        <p style="margin: 0; color: #6c757d; font-size: 14px;">
          หากคุณมีคำถามหรือต้องการความช่วยเหลือ กรุณาติดต่อทีมสนับสนุน<br>
          <strong>Project Bank System - ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ</strong>
        </p>
        <hr style="border: none; border-top: 1px solid #dee2e6; margin: 15px 0;">
        <p style="margin: 0; color: #adb5bd; font-size: 12px;">
          อีเมลนี้ถูกส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้
        </p>
      </div>
    </body>
    </html>
  `;
  }


  /**
   * สร้าง HTML template แนวราชการสำหรับการส่งกลับแก้ไข
   */
  generateProjectEditHTML(projects: ProjectListData[], developmentPlan: DevelopmentPlan, workHistory: string, reviewerName: string): string {
    return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>แจ้งการส่งโครงการเพื่อแก้ไข</title>
    </head>
    <body style="font-family: 'TH Sarabun New', 'Angsana New', 'Cordia New', sans-serif; line-height: 1.5; color: #000000; margin : 0 auto ; max-width : 800px; font-size: 22px;">
      

      <!-- Main Content -->
      <div style="padding: 30px 20px;">
        
        <div style="margin-bottom: 30px;">
          <p style="margin: 20px 0 20px 0; font-size: 18px; text-indent: 50px;">
            เรียน ผู้รับผิดชอบโครงการ
          </p>
          <p style="margin: 20px 0 20px 0; font-size: 18px; text-indent: 50px;">
            ตามที่ได้มีการตรวจสอบโครงการ <strong> ${projects[0].title} </strong> และผู้ตรวจสอบได้ส่งกลับโครงการของ <strong>${workHistory}</strong> ตาม${developmentPlan.name} <strong>${developmentPlan.startYear} - ${developmentPlan.endYear}</strong> แล้วนั้น  ขอให้ดำเนินการแก้ไขโครงการให้แล้วเสร็จ โดยรายละเอียดจะแสดงที่ระบบ ผู้ตรวจสอบคือ <strong>${reviewerName}</strong>
          </p>
          <p style="margin: 20px 0 20px 0; font-size: 18px; text-indent: 50px;">
            จึงเรียนมาเพื่อทราบและดำเนินการแก้ไขตามที่กำหนด
          </p>
        </div>

       
      </div>
    </body>
    </html>
  `;
  }

  /**
   * สร้าง Text template แนวราชการสำหรับการส่งกลับแก้ไข
   */
  generateProjectEditText(projects: ProjectListData[], developmentPlan: DevelopmentPlan, workHistory: string, reviewerName: string): string {
    return `
แจ้งการส่งโครงการเพื่อแก้ไข
ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ
═══════════════════════════════════════════════════════════

เรียน ผู้รับผิดชอบโครงการ

ตามที่ได้มีการตรวจสอบและส่งกลับโครงการ ${projects[0].title}ของ ${workHistory} ตาม${developmentPlan.name} ${developmentPlan.startYear} - ${developmentPlan.endYear} แล้วนั้น

ขอให้ดำเนินการแก้ไขโครงการตามรายการดังต่อไปนี้ โดยผู้ตรวจสอบคือ ${reviewerName}

รายการโครงการที่ต้องแก้ไข
═══════════════════════════════════════════════════════════
${projects.map((project, index) => `${index + 1}. ${project.title} (ผู้เขียน: ${project.createdBy})`).join('\n')}

จึงเรียนมาเพื่อทราบและดำเนินการแก้ไขตามที่กำหนด

ขอแสดงความนับถือ

═══════════════════════════════════════════════════════════
ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ
อีเมลนี้ถูกส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้
    `;
  }

  /**
   * สร้าง Text template สำหรับรายการโครงการ
   */
  generateProjectListText(projects: ProjectListData[], developmentPlan: DevelopmentPlan, workHistory: string, totalCount: number): string {
    return `
🏛️ Project Bank System - ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ
═══════════════════════════════════════════════════════════

คุณได้นำส่งโครงการของ ${workHistory} จำนวน ${totalCount} รายการ เรียบร้อยแล้ว ตาม${developmentPlan.name} ${developmentPlan.startYear} - ${developmentPlan.endYear}

📋 โครงการ
═══════════════════════════════════════════════════════════
${projects.map((project, index) => `${index + 1}. ${project.title} (ผู้เขียน: ${project.createdBy})`).join('\n')}

═══════════════════════════════════════════════════════════
หากคุณมีคำถามหรือต้องการความช่วยเหลือ กรุณาติดต่อทีมสนับสนุน
Project Bank System - ระบบจัดการโครงการ ธนาคารโครงการภาครัฐ

อีเมลนี้ถูกส่งโดยอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้
    `;
  }

  /**
   * จัดรูปแบบวันที่เป็นภาษาไทย
   */
  private formatThaiDate(date: Date): string {
    return date.toLocaleDateString('th-TH', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}
