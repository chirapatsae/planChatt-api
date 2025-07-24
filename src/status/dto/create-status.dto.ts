import { IsNotEmpty, IsUUID } from "class-validator";

export class CreateStatusDto {
    @IsNotEmpty()
    name : string


}
