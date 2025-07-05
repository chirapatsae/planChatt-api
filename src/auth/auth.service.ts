import { WorkHistory } from 'src/work-history/entities/work-history.entity';
import { TestingModule } from '@nestjs/testing';
import { CreateAuthDto } from './dto/create-auth.dto';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { BadRequestException, Injectable, InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { hashCitizenId } from 'src/util/encryption.util';
import * as dotenv from 'dotenv';
dotenv.config();

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly userService: UsersService, // ✅ inject UserService เข้ามา
    private jwtService: JwtService,
  ) { }



  async handleOAuthLogin(
    idToken: string,
    divisionIdFromDto: string,
    divisionNameFromDto: string,
  ) {
    try {
      const decoded: any = jwt.decode(idToken);
      if (!decoded?.sub || decoded.iss !== 'https://imauth.bora.dopa.go.th') {
        throw new UnauthorizedException('Invalid id_token');
      }

      const hashedCid = hashCitizenId(decoded.pid);
      let user = await this.userRepository.findOne({
        where: { citizenIdHash: hashedCid },
        relations: [
          'workHistory',
          'workHistory.amphoe',
          'workHistory.localAdministrativeOrganization',
        ],
      });

      // ถ้า user ไม่พบ สร้างใหม่
      if (!user) {
        const newUserDto: CreateUserDto = {
          citizenId: decoded.pid,
          prefix: decoded.title,
          firstname: decoded.given_name,
          lastname: decoded.family_name,
        };
        user = await this.userService.create(newUserDto);
      } else {
        // ถ้าเจอ ให้ update ข้อมูลพื้นฐาน
        user.prefix = decoded.title;
        user.firstname = decoded.given_name;
        user.lastname = decoded.family_name;
        user = await this.userService.update(user.id, user);
      }

      const isFirstLogin = user.isFirstLogin;

      // หา workHistory ล่าสุด
      const latestWH = user.workHistory
        ?.filter(wh => wh.status === 'approved')
        .sort((a, b) => new Date(b.createAt).getTime() - new Date(a.createAt).getTime())[0] ?? {};

      // เลือก source division_id / division_name ตาม isFirstLogin
      const divisionId = !isFirstLogin
        ? divisionIdFromDto
        : latestWH.divisionId;
      const divisionName = !isFirstLogin
        ? divisionNameFromDto
        : latestWH.divisionName;

      // สร้าง JWT
      const payload = { sub: user.id, role: latestWH.role , status : latestWH.status };
      const accessToken = this.jwtService.sign(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: '7d',
      });

      return {
        isFirstLogin,
        accessToken,
        user: {
          id: user.id,
          workId : latestWH.id,
          prefix: user.prefix,
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email ?? '',
          phone: user.phone ?? '',
          amphoeId: latestWH.amphoe?.id ?? '',
          amphoeName: latestWH.amphoe?.name ?? '',
          localAdministrativeOrganizationId: latestWH.localAdministrativeOrganization?.id ?? '',
          localAdministrativeOrganizationName: latestWH.localAdministrativeOrganization?.name ?? '',
          divisionId,
          divisionName,
          role: latestWH.role,
        },
      };
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      console.error('❌ handleOAuthLogin Error:', error);
      throw new InternalServerErrorException('OAuth login failed');
    }
  }






  create(createAuthDto: CreateAuthDto) {
    return 'This action adds a new auth';
  }

  findAll() {
    return `This action returns all auth`;
  }

  findOne(id: number) {
    return `This action returns a #${id} auth`;
  }

  update(id: number, updateAuthDto: UpdateAuthDto) {
    return `This action updates a #${id} auth`;
  }

  remove(id: number) {
    return `This action removes a #${id} auth`;
  }
}
