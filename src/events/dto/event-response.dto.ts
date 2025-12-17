import { Amphoe } from 'src/amphoes/entities/amphoe.entity';
import { LocalAdministrativeOrganization } from 'src/local-administrative-organizations/entities/local-administrative-organization.entity';

export class EventResponseDto {
  id: string;
  title: string;
  description?: string;
  location: {
    name: string;
    address: string;
    coordinates?: {
      lat: number;
      lng: number;
    };
  };
  startDate: Date;
  endDate: Date;
  attachments?: Array<{
    filename: string;
    originalName: string;
    mimetype: string;
    size: number;
    path: string;
  }>;
  publishDateTime?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: {
    id: string;
    amphoe?: Amphoe;
    localAdministrativeOrganization?: LocalAdministrativeOrganization;
    user?: {
      firstname?: string;
      lastname?: string;
      email?: string;
      phone?: string;
    };
  };
} 