import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'src/users/entities/user.entity';
import { UsersService } from 'src/users/users.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { hashCitizenId } from 'src/util/encryption.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly userService: UsersService,
    private jwtService: JwtService,
  ) {}

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
      this.logger.log('>>> decoded', decoded);
      const hashedCid = hashCitizenId(decoded.pid);
      this.logger.log('>>> hashedCid', hashedCid);
      let user = await this.userRepository.findOne({
        where: { citizenIdHash: hashedCid },
        relations: [
          'workHistory',
          'workHistory.amphoe',
          'workHistory.localAdministrativeOrganization',
          'workHistory.workStatus',
          'workHistory.role',
        ],
      });
      this.logger.log('>>> user', user);
      // ถ้า user ไม่พบ สร้างใหม่
      if (!user || !user.id) {
        this.logger.log('>>> user not found, creating new user');
        const newUserDto: CreateUserDto = {
          citizenId: decoded.pid,    // เก็บ plain หรือ encrypt ไว้ก็ได้ ถ้าอยากถอดคืน
          citizenIdHash: hashedCid,  // เก็บ hash สำหรับ unique check
          prefix: decoded.title,
          firstname: decoded.given_name,
          lastname: decoded.family_name,
        };
        try {
          user = await this.userService.create(newUserDto, hashedCid);
        } catch (error) {
          if (error.code === '23505') { // PostgreSQL unique constraint violation
            user = await this.userRepository.findOne({
              where: { citizenIdHash: hashedCid },
              relations: [
                'workHistory',
                'workHistory.amphoe',
                'workHistory.localAdministrativeOrganization',
                'workHistory.workStatus',
                'workHistory.role',
              ],
            });
            
            if (!user) {
              throw new InternalServerErrorException('Failed to create or find user after duplicate constraint violation');
            }
          } else {
            throw error;
          }
        }
      } else {
        this.logger.log('>>> user found', user);
        user.prefix = decoded.title;
        user.firstname = decoded.given_name;
        user.lastname = decoded.family_name;
        user = await this.userService.update(user.id, user);
      }
      const isFirstLogin = user.isFirstLogin ?? true;

      const latestWH =
        user.workHistory
          ?.filter((wh) => wh.workStatus.name === 'approved')
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )[0] ?? {};

      const divisionId = isFirstLogin
        ? divisionIdFromDto
        : latestWH.governmentAgencies?.id;
      const divisionName = isFirstLogin
        ? divisionNameFromDto
        : latestWH.governmentAgencies?.name;

      const payload = {
        sub: user.id,
        role: latestWH.role?.name ?? null,
        workStatus: latestWH.workStatus?.name ?? null,
      };

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
          localAdministrativeOrganizationId:
            latestWH.localAdministrativeOrganization?.id ?? '', // 👈 ใช้ ?. และ ??
          localAdministrativeOrganizationName:
            latestWH.localAdministrativeOrganization?.name ?? '', // 👈 ใช้ ?. และ ??
          divisionId,
          divisionName,
          role: latestWH.role?.name ?? 'user',
          workStatus: latestWH.workStatus?.name ?? 'pending',
        },
      };
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new InternalServerErrorException('OAuth login failed');
    }
  }
}
