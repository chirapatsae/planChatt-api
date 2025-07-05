import { IsNotEmpty, IsUUID } from "class-validator";

export class CreateAmphoeDto {
    @IsNotEmpty()
    code: string;

    @IsNotEmpty()
    name: string;

}
