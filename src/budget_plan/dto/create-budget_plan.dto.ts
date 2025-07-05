import { IsNotEmpty } from "class-validator";

export class CreateBudgetPlanDto {
    @IsNotEmpty()
    name: string;
    @IsNotEmpty()
    startYear: number;
    @IsNotEmpty()
    endYear: number;

}
