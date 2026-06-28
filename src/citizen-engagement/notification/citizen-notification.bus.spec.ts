import { firstValueFrom, take, toArray } from 'rxjs';

import { CitizenNotificationBus } from './citizen-notification.bus';

/**
 * Unit spec for CitizenNotificationBus (W-T2 realtime SSE fan-out).
 *
 * Covers the two integrity guarantees:
 *  - publish → streamFor(recipient) receives the event;
 *  - §17.3 isolation: streamFor(other) does NOT receive another recipient's event.
 */
describe('CitizenNotificationBus', () => {
  let bus: CitizenNotificationBus;

  beforeEach(() => {
    bus = new CitizenNotificationBus();
  });

  it('delivers a published event to the matching recipient stream', async () => {
    const received = firstValueFrom(bus.streamFor('alice').pipe(take(1)));
    bus.publish({ recipientIdentityId: 'alice', type: 'notification' });

    await expect(received).resolves.toEqual({
      recipientIdentityId: 'alice',
      type: 'notification',
    });
  });

  it('does NOT deliver another recipient’s event (§17.3 isolation)', async () => {
    // Collect everything 'bob' sees over two publishes; he must see ONLY his own.
    const collected = firstValueFrom(
      bus.streamFor('bob').pipe(take(1), toArray()),
    );

    bus.publish({ recipientIdentityId: 'alice', type: 'notification' }); // not bob
    bus.publish({ recipientIdentityId: 'bob', type: 'notification' }); // bob's own

    await expect(collected).resolves.toEqual([
      { recipientIdentityId: 'bob', type: 'notification' },
    ]);
  });

  it('publish is a no-throw fire-and-forget with no subscribers', () => {
    expect(() =>
      bus.publish({ recipientIdentityId: 'nobody', type: 'notification' }),
    ).not.toThrow();
  });
});
