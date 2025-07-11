import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { Amphoe } from "src/amphoes/entities/amphoe.entity";
import { Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

@Entity('local_administrative_organizations')
export class LocalAdministrativeOrganization {
    @PrimaryColumn()
    id: string;

    @Column({ unique: true })
    name: string;

    @Column()
    type: string;

    @CreateDateColumn({ name: 'create_at', type: 'timestamp' })
    createdAt: Date;

    @DeleteDateColumn({ name: 'delete_at', type: 'timestamp', nullable: true })
    deleteAt: Date | null;


    @ManyToOne(() => Amphoe, (amphoe) => amphoe.localAdministrativeOrganization, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        eager: true, // 👈 เพิ่มบรรทัดนี้
    })
    @JoinColumn({ name: 'amphoe_id'  })
    amphoe: Amphoe;

    @OneToMany(() => WorkHistory , (workHistory) => workHistory.localAdministrativeOrganization , {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    workHistory : WorkHistory[]

}
