import { Controller, Post, Body, Res } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { Response } from 'express';

@Controller({
  path: 'pdf',
  version: '1',
})
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('generate')
  async generatePdf(@Body() body: any, @Res() res: Response) {
    const pdfBuffer = await this.pdfService.generateProjectReport(
      body.projects,
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename=project-report.pdf',
    });

    res.end(pdfBuffer);
  }
}
