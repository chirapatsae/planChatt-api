// import { Test, TestingModule } from '@nestjs/testing';
// import { UsersService } from './users.service';

// describe('UsersService', () => {
//   let service: UsersService;

//   beforeEach(async () => {
//     const module: TestingModule = await Test.createTestingModule({
//       providers: [UsersService],
//     }).compile();

//     service = module.get<UsersService>(UsersService);
//   });

//   it('should be defined', () => {
//     expect(service).toBeDefined();
//   });
// });
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';

// 1. สร้าง object จำลองสำหรับ Repository
// เราสามารถกำหนดได้ว่าเมื่อฟังก์ชันถูกเรียก จะให้ return ค่าอะไร
const mockUserRepository = {
  create: jest.fn(),
  save: jest.fn(),
  findOneBy: jest.fn(),
  preload: jest.fn(),
  delete: jest.fn(),
  softDelete: jest.fn(),
  restore: jest.fn(),
};

describe('UsersService', () => {
  let service: UsersService;
  let repository: Repository<User>; // (Optional) for use in tests

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        // 2. บอก NestJS ว่าเมื่อมีการขอ UserRepository ให้ใช้ object จำลองของเราแทน
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    repository = module.get<Repository<User>>(getRepositoryToken(User)); // (Optional)
  });

  // 3. หลังจากนี้ เทสของคุณควรจะผ่าน
  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});