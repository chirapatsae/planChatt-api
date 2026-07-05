import { Injectable } from '@nestjs/common';

export interface PresenceState {
  online: boolean;
  /** Epoch ms of the last disconnect; null while online or when hidden. */
  lastSeenAt: number | null;
}

/**
 * CitizenPresenceService — in-memory online/offline registry for citizen chat
 * sockets (community presence, 2026-07). Ref-counts sockets per identity so a
 * multi-tab / multi-device citizen counts as ONE online presence, and flips
 * only on the online<->offline TRANSITION (first connect / last disconnect).
 *
 * Privacy (§17.3): `visible` mirrors each identity's `showOnlineStatus`. When
 * false the identity is reported OFFLINE to others (and no `lastSeenAt` is
 * leaked) while it still SEES everyone else — asymmetric "invisible" mode,
 * matching Facebook. The toggle is the citizen's own PDPA control.
 *
 * Presence is pure metadata (an online bool + a timestamp) keyed by the opaque
 * citizen identity id — NO PII, NO project-table reference, nothing persisted.
 *
 * Single-instance only (like CitizenChatGateway). Horizontal scale needs the
 * Socket.IO Redis adapter + a shared store — a documented later-wave follow-up.
 */
@Injectable()
export class CitizenPresenceService {
  /** identityId -> live socket ids. Presence-online = set is non-empty. */
  private readonly sockets = new Map<string, Set<string>>();
  /** identityId -> last-disconnect epoch ms. */
  private readonly lastSeen = new Map<string, number>();
  /** identityId -> showOnlineStatus (default true). */
  private readonly visible = new Map<string, boolean>();

  /** A socket connected. Returns whether the PUBLIC online state flipped on. */
  register(
    identityId: string,
    socketId: string,
    showOnlineStatus: boolean,
  ): { flippedOnline: boolean } {
    const wasPublicOnline = this.publicState(identityId).online;
    this.visible.set(identityId, showOnlineStatus);
    let set = this.sockets.get(identityId);
    if (!set) {
      set = new Set<string>();
      this.sockets.set(identityId, set);
    }
    set.add(socketId);
    return { flippedOnline: !wasPublicOnline && this.publicState(identityId).online };
  }

  /** A socket disconnected. Returns whether the PUBLIC online state flipped off. */
  deregister(identityId: string, socketId: string): { flippedOffline: boolean } {
    const wasPublicOnline = this.publicState(identityId).online;
    const set = this.sockets.get(identityId);
    if (set) {
      set.delete(socketId);
      if (set.size === 0) {
        this.sockets.delete(identityId);
        this.lastSeen.set(identityId, Date.now());
      }
    }
    return { flippedOffline: wasPublicOnline && !this.publicState(identityId).online };
  }

  private rawOnline(identityId: string): boolean {
    const set = this.sockets.get(identityId);
    return !!set && set.size > 0;
  }

  /** The privacy-respecting state reported to OTHERS. */
  publicState(identityId: string): PresenceState {
    const hidden = this.visible.get(identityId) === false;
    if (hidden) return { online: false, lastSeenAt: null };
    const online = this.rawOnline(identityId);
    return { online, lastSeenAt: online ? null : this.lastSeen.get(identityId) ?? null };
  }

  snapshot(ids: string[]): Record<string, PresenceState> {
    const out: Record<string, PresenceState> = {};
    for (const id of ids) out[id] = this.publicState(id);
    return out;
  }

  /**
   * Update an identity's visibility (from the profile toggle). Returns whether
   * the PUBLIC online state changed, so the gateway knows to re-broadcast.
   */
  setVisibility(identityId: string, showOnlineStatus: boolean): { changed: boolean } {
    const before = this.publicState(identityId).online;
    this.visible.set(identityId, showOnlineStatus);
    return { changed: before !== this.publicState(identityId).online };
  }
}
