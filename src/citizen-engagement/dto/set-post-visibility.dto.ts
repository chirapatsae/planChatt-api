import { IsBoolean } from 'class-validator';

/**
 * Owner toggle for the "hide from everyone but me" flag (ซ่อนให้เห็นเฉพาะฉัน) on
 * their OWN post. `hidden = true` removes the post from every public read;
 * `false` restores it. The owner is resolved from the citizen token, NEVER a
 * body field (§17.3). §17.2 advisory — no workflow / project side-effect.
 */
export class SetPostVisibilityDto {
  @IsBoolean()
  hidden: boolean;
}
