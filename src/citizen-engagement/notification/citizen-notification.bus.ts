import { Injectable } from '@nestjs/common';
import { filter, Observable, Subject } from 'rxjs';

/** A lightweight realtime ping. Carries ONLY a recipient routing key + a type
 * string — NEVER any PII or notification body (§17.3). The FE refetches the
 * authoritative unread count on receipt, so a missed/duplicate ping is harmless. */
export interface CitizenNotificationEvent {
  /** The citizen who should receive this event (routing key — NOT exposed downstream). */
  recipientIdentityId: string;
  /** Event discriminator the FE switches on (e.g. 'notification'). NO PII. */
  type: string;
}

/**
 * CitizenNotificationBus — in-memory realtime fan-out for W-T2 SSE (Phase 4).
 *
 * A single process-wide RxJS `Subject`. The notification WRITE helpers
 * (`CitizenNotificationService.notifyOn*`) call `publish(evt)` AFTER the row is
 * saved; the `@Sse` stream endpoint calls `streamFor(callerIdentityId)` and gets
 * an Observable filtered to ONLY that recipient's events.
 *
 * §17.2 advisory — the stream carries notifications; it gates NOTHING.
 * §17.3 isolation — per-recipient filter (a citizen only ever receives their OWN
 *   events), NO PII in the event (just `{ type }`), and NO new table / FK / entity:
 *   this is pure in-memory pub/sub.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SCALE SEAM (DOCUMENTED — NOT built in v1) — single-instance only.
 * ───────────────────────────────────────────────────────────────────────────
 * The `Subject` fans out WITHIN ONE node process only. In a multi-instance
 * deployment a notification created on instance A will NOT reach a client whose
 * SSE stream is held by instance B — the publish never crosses the process
 * boundary. v1 deliberately targets the current SINGLE-INSTANCE deployment.
 *
 * Multi-instance upgrade path (swap the transport, keep this same public API —
 * `publish` / `streamFor` are unchanged; only the wiring behind them changes):
 *
 *   (A) Postgres LISTEN/NOTIFY (no new infra — reuses the existing DB):
 *       - publish(evt)  → pg_notify('citizen_notif', JSON.stringify({ recipientIdentityId, type }))
 *       - per instance  → hold ONE dedicated LISTEN connection
 *                         (`LISTEN citizen_notif`); on each NOTIFY payload, call
 *                         `this.subject.next(parsedEvt)` to feed the LOCAL Subject,
 *                         so every instance re-broadcasts to its own SSE clients.
 *       NOTE: this is a TRANSPORT-only fan-out — it does NOT create a
 *       `citizen_*` table / FK / entity, so the §17.3 isolation invariant holds.
 *
 *   (B) Redis pub/sub — PUBLISH on `publish`, SUBSCRIBE per instance feeding the
 *       local Subject. Requires a Redis dependency this app does not yet have.
 *
 * Either option keeps `publish` / `streamFor` byte-identical to callers; the
 * `@Sse` controller and the notify-helper wiring need no change.
 */
@Injectable()
export class CitizenNotificationBus {
  private readonly subject = new Subject<CitizenNotificationEvent>();

  /**
   * Emit a realtime ping. Best-effort fire-and-forget — callers wrap this so a
   * bus failure NEVER throws into the notification write path (advisory, §17.2).
   */
  publish(event: CitizenNotificationEvent): void {
    this.subject.next(event);
  }

  /**
   * Stream of events addressed to ONE recipient (§17.3 isolation). The filter
   * guarantees a citizen only ever observes their OWN events — never another
   * citizen's. Used by the `@Sse('me/notifications/stream')` endpoint.
   */
  streamFor(recipientIdentityId: string): Observable<CitizenNotificationEvent> {
    return this.subject
      .asObservable()
      .pipe(filter((evt) => evt.recipientIdentityId === recipientIdentityId));
  }
}
