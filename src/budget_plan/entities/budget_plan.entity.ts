import { Budget } from "src/budget/entities/budget.entity";
import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { WorkHistory } from "src/work-history/entities/work-history.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";


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

    @Column({name : 'is_latest'})
    isLatest : boolean
    
    @CreateDateColumn({name : 'create_at'})
    createAt : Date

    @DeleteDateColumn({name : 'deleted_at' , nullable : true})
    deletedAt ? : Date

    @ManyToOne(()=> WorkHistory , (workHistory) => workHistory.budgetPlan ,{
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    @JoinColumn({name : 'created_by'})
    createdBy : WorkHistory

    @OneToMany(() => ProjectGroup , (projectGroup) => projectGroup.budgetPlan ,{
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    projectGroup : ProjectGroup[]

    @OneToMany(() => Budget , (budget) => budget.budgetPlanId , {
        onUpdate : 'CASCADE',
        onDelete : 'CASCADE'
    })
    budget : Budget[]

    
}
