import { IsNotEmpty, IsUUID } from "class-validator";

export class CreateLocalAdministrativeOrganizationDto {
    @IsNotEmpty()
    code: string;

    @IsNotEmpty()
    name: string;

    @IsNotEmpty()
    type: string;

    @IsNotEmpty()
    @IsUUID()
    userId: string;

    @IsNotEmpty()
    amphoeId: number;
}
