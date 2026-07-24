import { Injectable } from '@nestjs/common';

import { sessionRegistryEnabled } from '../../common/session-registry/session-registry.flag';
import { CitizenIdentity } from '../entities/citizen-identity.entity';
import { CitizenSessionRegistryService } from './citizen-session-registry.service';
import { CitizenLoginAlertService } from './citizen-login-alert.service';

/** Citizen session lifetime — matches the 30d JWT (`expiresIn:'30d'`). */
const CITIZEN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * CitizenSessionMintService — the single seam every citizen mint point calls to
 * (optionally) materialize a `citizen_session` row + emit the new-device alert
 * (login-alerts / device-session-management, Batch 2).
 *
 * MASTER-FLAG contract: when `SESSION_REGISTRY_ENABLED !== 'true'` this returns
 * `undefined` and the caller signs its JWT EXACTLY as before (no `sid`, no row,
 * no alert) — byte-for-byte legacy behavior. When ON it records the session,
 * returns the new `sid` for the caller to embed, and fires the new-device alert
 * FIRE-AND-FORGET (never blocking the auth response) when the device is new AND
 * this is not the account's first-ever session.
 */
@Injectable()
export class CitizenSessionMintService {
  constructor(
    private readonly registry: CitizenSessionRegistryService,
    private readonly alert: CitizenLoginAlertService,
  ) {}

  /**
   * Record a session for a freshly-authenticated citizen and return its `sid`
   * (or `undefined` when the registry flag is OFF). `loginMethod` is the login
   * path label stored on the row (`password` | `google` | `register`).
   */
  async establish(args: {
    identity: CitizenIdentity;
    loginMethod: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<string | undefined> {
    if (!sessionRegistryEnabled()) return undefined;

    const expiresAt = new Date(Date.now() + CITIZEN_SESSION_TTL_MS);
    const { row, isNewDevice, isFirstSession } = await this.registry.record({
      identityId: args.identity.id,
      sessionVersion: args.identity.sessionVersion ?? 0,
      loginMethod: args.loginMethod,
      ip: args.ip,
      userAgent: args.userAgent,
      expiresAt,
    });

    // New device on an EXISTING account → alert. First-ever session (signup /
    // first login) → never alert. Fire-and-forget: a mail failure must never
    // surface to (or slow) the login response.
    if (isNewDevice && !isFirstSession) {
      void this.alert
        .sendNewDeviceAlert(args.identity, row)
        .catch(() => undefined);
    }

    return row.id;
  }
}
