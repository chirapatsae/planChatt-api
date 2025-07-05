import { IsNotEmpty, IsUUID } from "class-validator";


export class CreateProjectTypeDto {
    @IsNotEmpty()
    name: string;
}
