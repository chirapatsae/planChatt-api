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
    private readonly userService: UsersService, 
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
      console.log(decoded.pid)
      console.log(hashedCid)
      let user = await this.userRepository.findOne({
        where: { citizenIdHash: hashedCid },
        relations: [
          'workHistory',
          'workHistory.amphoe',
          'workHistory.localAdministrativeOrganization',
          'workHistory.workStatus',
          'workHistory.role', // เพิ่ม relation ของ role ด้วย เพื่อให้ดึงข้อมูลได้ครบ
        ],
      });
      console.log(user)
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
        user.prefix = decoded.title;
        user.firstname = decoded.given_name;
        user.lastname = decoded.family_name;
        user = await this.userService.update(user.id, user);
      }
      const isFirstLogin = user.isFirstLogin;

      const latestWH = user.workHistory
        ?.filter(wh => wh.workStatus.name === 'approved')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? {};

      console.log(latestWH)

      const divisionId = isFirstLogin
        ? divisionIdFromDto
        : latestWH.governmentAgencies?.id;
      const divisionName = isFirstLogin
        ? divisionNameFromDto
        : latestWH.governmentAgencies?.name;
      console.log(divisionId, divisionName)

      const payload = {
        sub: user.id,
        roleId: latestWH.role.id ?? null,
        workStatus: latestWH.workStatus?.name ?? null
      };

      console.log(payload)

      const accessToken = this.jwtService.sign(payload, {
        secret: process.env.JWT_SECRET,
        expiresIn: '30d',
      });

      return {
        isFirstLogin,
        accessToken,
        user: {
          id: user.id,
          workHistoryId: latestWH.id ?? null, // 👈 ใช้ ??
          prefix: user.prefix,
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email ?? '',
          phone: user.phone ?? '',
          amphoeId: latestWH.amphoe?.id ?? '', // 👈 ใช้ ?. และ ??
          amphoeName: latestWH.amphoe?.name ?? '', // 👈 ใช้ ?. และ ??
          localAdministrativeOrganizationId: latestWH.localAdministrativeOrganization?.id ?? '', // 👈 ใช้ ?. และ ??
          localAdministrativeOrganizationName: latestWH.localAdministrativeOrganization?.name ?? '', // 👈 ใช้ ?. และ ??
          divisionId,
          divisionName,
          roleId: latestWH.role?.id ?? '',
          workStatusId: latestWH.workStatus?.id ?? ''
        },
      };

      // ======================================================

    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof BadRequestException) {
        throw error;
      }
      console.error('❌ handleOAuthLogin Error:', error);
      throw new InternalServerErrorException('OAuth login failed');
    }
  }

}
