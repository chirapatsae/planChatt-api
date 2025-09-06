import { ProjectGroup } from "src/project-groups/entities/project-group.entity";
import { User } from "src/users/entities/user.entity";
import { Entity, ManyToOne, PrimaryGeneratedColumn, JoinColumn } from "typeorm";

@Entity('favorites')
export class Favorite {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @ManyToOne(() => ProjectGroup, (projectGroup) => projectGroup.favorites, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'project_group_id' })
    projectGroupId: ProjectGroup;

    @ManyToOne(() => User, (user) => user.favorites, {
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    })
    @JoinColumn({ name: 'user_id' })
    userId: User;
}
