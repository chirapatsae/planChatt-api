import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";


@Entity({ name: "budget_plan" })
export class BudgetPlan {
    @PrimaryGeneratedColumn('uuid')
    id : string;

    @Column()
    name : string

    @Column({ name : 'start_year' })
    startYear : number

    @Column({name : 'end_year'})
    endYear : number

    @Column({name : 'is_active'})
    isActive : boolean
    
    @CreateDateColumn({name : 'create_at'})
    createAt : Date

    @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.budgetPlanId ,{
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    projectGroup : ProjectGroup

    
}
