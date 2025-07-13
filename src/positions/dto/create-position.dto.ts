import { IsNotEmpty, IsString, IsUUID } from "class-validator";

export class CreatePositionDto {
    @IsNotEmpty()
    @IsString()
    name: string;

    @IsNotEmpty()
    @IsUUID()
    userId : string;
} 