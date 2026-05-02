import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as jwt from 'jsonwebtoken';
import { UsersService } from 'src/users/users.service';
import { CreateUserDto } from 'src/users/dto/create-user.dto';
import { hashCitizenId } from 'src/util/encryption.util';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    // W89B — `userRepository` was removed: post-W89-BE-AUTH-INTEGRATION
    // every read/write goes through UsersService so the dead repo
    // injection (and its `User` TypeORM feature import in AuthModule)
    // was not exercised on any code path.
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

      // W89 Gap 2 — Normalize ThaID claim email/phone BEFORE handing them
      // to UsersService. Claims arrive from the raw id_token payload and do
      // NOT pass through CreateUserDto's @Transform decorators, so we
      // normalize explicitly here to keep the encrypted plaintext in
      // lockstep with email_hash / phone_hash (hashEmail / hashPhone both
      // lowercase+trim or strip-non-digits internally).
      // An empty post-normalization phone (e.g. claim of just "-" → "")
      // is treated as absent: we omit the field rather than passing "".
      const normalizedEmail = decoded?.email
        ? String(decoded.email).trim().toLowerCase()
        : null;
      const rawPhoneDigits = decoded?.phone
        ? String(decoded.phone).replace(/\D/g, '')
        : '';
      const normalizedPhone = rawPhoneDigits.length > 0 ? rawPhoneDigits : null;

      // W89 — Route the OAuth lookup through UsersService so the email,
      // phone, and citizenId columns are decrypted before the response
      // payload is built. A direct userRepository.findOne would return
      // iv:ciphertext strings which would leak to the frontend Redux
      // store as garbled values.
      let user = await this.userService.findByCitizenIdHash(hashedCid);
      // ถ้า user ไม่พบ สร้างใหม่
      if (!user || !user.id) {
        const newUserDto: CreateUserDto = {
          citizenId: decoded.pid,    // เก็บ plain หรือ encrypt ไว้ก็ได้ ถ้าอยากถอดคืน
          citizenIdHash: hashedCid,  // เก็บ hash สำหรับ unique check
          prefix: decoded.title,
          firstname: decoded.given_name,
          lastname: decoded.family_name,
          ...(normalizedEmail ? { email: normalizedEmail } : {}),
          ...(normalizedPhone ? { phone: normalizedPhone } : {}),
        };
        try {
          user = await this.userService.create(newUserDto, hashedCid);
        } catch (error) {
          if (error.code === '23505') {
            user = await this.userService.findByCitizenIdHash(hashedCid);
            if (!user) {
              throw new InternalServerErrorException('Failed to create or find user after duplicate constraint violation');
            }
          } else {
            throw error;
          }
        }
      } else {
        user.prefix = decoded.title;
        user.firstname = decoded.given_name;
        user.lastname = decoded.family_name;
        user = await this.userService.update(user.id, user);
      }

      // W89 defensive guard — if the response-bound user still carries an
      // iv:ciphertext-shaped email or phone, log a structured warning. The
      // UUID is safe to log; the value itself is NEVER logged. This catches
      // any future code path that bypasses UsersService decryption.
      if (this.looksLikeCiphertext(user.email) || this.looksLikeCiphertext(user.phone)) {
        this.logger.warn(
          `auth.thaid.upsert ciphertext-leak-suspected userId=${user.id}`,
        );
      }
      const isFirstLogin = user.isFirstLogin ? true : false;
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

      // W83 PII discipline — never log the user object or the access token.
      // Only emit a structured marker carrying the user UUID + ISO timestamp.
      this.logger.log(
        `auth.thaid.upsert userId=${user.id} at=${new Date().toISOString()}`,
      );
      return {
        isFirstLogin,
        accessToken,
        user: {
          id: user.id,
          workHistoryId: latestWH.id ?? null,
          prefix: user.prefix,
          firstname: user.firstname,
          lastname: user.lastname,
          email: user.email ?? '',
          phone: user.phone ?? '',
          amphoeId: latestWH.amphoe?.id ?? '',
          amphoeName: latestWH.amphoe?.name ?? '',
          localAdministrativeOrganizationId:
            latestWH.localAdministrativeOrganization?.id ?? '',
          localAdministrativeOrganizationName:
            latestWH.localAdministrativeOrganization?.name ?? '',
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

  /**
   * W89 defensive helper — heuristically detects an encrypted PII column
   * value. The encryption util emits `iv:ciphertext` shaped strings (two
   * hex segments separated by a colon). Plaintext emails contain `@` and
   * plaintext phones are digit-only — neither matches this shape.
   *
   * Used only for warn-level alerting (UUID logged, value never logged).
   */
  private looksLikeCiphertext(value: string | null | undefined): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    // iv:ciphertext format — two hex blocks separated by a colon, each at
    // least 16 hex chars long. Plaintext email/phone never matches this.
    return /^[0-9a-f]{16,}:[0-9a-f]{16,}$/i.test(value);
  }
}
