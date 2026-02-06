import { IsNotEmpty, IsNumber, IsString, IsUUID } from "class-validator";

export class CreateAttachmentProjectGroupDto {
    @IsString()
    filename: string;
    @IsString()
    originalName: string;
    @IsString()
    mimetype: string;
    @IsNumber()
    size: number;
    @IsString()
    path: string;
    @IsUUID()
    @IsNotEmpty()
    projectGroupId: string;
}


