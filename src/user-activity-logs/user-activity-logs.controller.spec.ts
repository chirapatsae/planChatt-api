import { Test, TestingModule } from '@nestjs/testing';
import { UserActivityLogsController } from './user-activity-logs.controller';
import { UserActivityLogsService } from './user-activity-logs.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserActivityLog } from './entities/user-activity-log.entity';
import { User } from 'src/users/entities/user.entity';

describe('UserActivityLogsController', () => {
  let controller: UserActivityLogsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserActivityLogsController],
      providers: [
        UserActivityLogsService,
        {
          provide: getRepositoryToken(UserActivityLog),
          useValue: {},
        },
        {
          provide: getRepositoryToken(User),
          useValue: {},
        },
      ],
    }).compile();

    controller = module.get<UserActivityLogsController>(UserActivityLogsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
