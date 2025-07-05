import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { User } from "src/users/entities/user.entity";
import { WorkHistory } from "src/work-history/entities/work-history.entity";
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

    @ManyToOne(() => User, (user) => user.budgetPlan , {
        onDelete : 'CASCADE',
        onUpdate : 'CASCADE'
    })
    @JoinColumn({ name : 'create_by' })
    user : User


    @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.budgetPlanId ,{
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    projectGroup : ProjectGroup

    
}
