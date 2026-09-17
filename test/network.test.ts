import test from 'node:test';
import assert from 'node:assert/strict';
import { RadioMedium } from '../src/network.ts';
import type { Diagnostic, Vec3 } from '../src/contracts.ts';

function setup(extra = {}) {
  const positions: Record<string, Vec3> = { a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, c: { x: 2, y: 0, z: 0 } };
  const trace: Omit<Diagnostic, 'id' | 'wallMs'>[] = [];
  const network = new RadioMedium({ seed: 42, position: id => positions[id]!, record: event => trace.push(event) });
  for (const id of ['a', 'b', 'c']) network.register(id, { latencyMs: 10, jitterMs: 0, bitrateBps: 8000, ...extra });
  return { network, positions, trace };
}

test('radio separates queue admission from delayed delivery, clones inbox, acknowledges namespaced IDs', () => {
  const { network } = setup();
  assert.deepEqual(network.send('a', { id: 'one', to: 'b', data: '1234' }, 0), { accepted: true });
  network.tick(13); assert.equal(network.inbox('b').length, 0);
  network.tick(14); const inbox = network.inbox('b'); assert.equal(inbox[0]!.receivedSimMs, 14);
  assert.equal(inbox[0]!.sentSimMs, 0); inbox[0]!.data = 'tampered';
  assert.equal(network.inbox('b')[0]!.data, '1234');
  network.acknowledge('b', [inbox[0]!.id]); assert.equal(network.inbox('b').length, 0);
  assert.deepEqual(network.send('a', { id: 'one', to: 'b', data: '1234' }, 14), { accepted: true, reason: 'duplicate' });
  assert.equal(network.send('a', { id: 'one', to: 'b', data: 'other' }, 14).reason, 'packet_id_conflict');
});

test('radio serializes byte bandwidth and bounds both transmit and receive queues', () => {
  const { network, trace } = setup({ maxQueueBytes: 4, maxPacketBytes: 4, latencyMs: 0 });
  network.send('a', { id: '1', to: 'b', data: '12' }, 0);
  network.send('a', { id: '2', to: 'b', data: '34' }, 0);
  assert.equal(network.send('a', { id: '3', to: 'b', data: '5' }, 0).reason, 'tx_queue_full');
  network.tick(2); assert.equal(network.inbox('b').length, 1);
  network.tick(4); assert.equal(network.inbox('b').length, 2);
  network.send('a', { id: '3', to: 'b', data: '5' }, 4);
  network.tick(5); assert.equal(network.inbox('b').length, 2);
  assert.ok(trace.some(event => (event.data as {reason?: string}).reason === 'inbox_full'));
});

test('radio checks range and directed partitions at delivery without exposing drops in send receipts', () => {
  const { network, positions, trace } = setup({ rangeM: 3 });
  assert.deepEqual(network.send('a', { id: 'range', to: 'b', data: 'x' }, 0), { accepted: true });
  positions.b!.x = 10; network.tick(11); assert.equal(network.inbox('b').length, 0);
  positions.b!.x = 1; network.setPartitions([['a', 'b']]);
  network.send('a', { id: 'partition', to: 'b', data: 'x' }, 11);
  network.send('b', { id: 'reverse', to: 'a', data: 'x' }, 11);
  network.tick(22); assert.equal(network.inbox('b').length, 0); assert.equal(network.inbox('a').length, 1);
  assert.deepEqual(trace.filter(event => event.kind === 'dropped').map(event => (event.data as {reason: string}).reason), ['range', 'partition']);
});

test('radio expiry, broadcast channels, and cross-sender ID collisions remain isolated', () => {
  const { network } = setup();
  network.register('different', { channel: 'other' });
  network.send('a', { id: 'same', to: '*', data: 'a' }, 0);
  network.send('b', { id: 'same', to: 'c', data: 'b' }, 0);
  network.tick(11); assert.equal(network.inbox('c').length, 2); assert.equal(network.inbox('different').length, 0);
  const [first, second] = network.inbox('c'); assert.notEqual(first!.id, second!.id);
  network.acknowledge('c', [first!.id]); assert.equal(network.inbox('c')[0]!.id, second!.id);
  network.send('a', { id: 'expires', to: 'c', data: 'x', ttlMs: 2 }, 11);
  network.tick(22); assert.equal(network.inbox('c').length, 1);
  network.tick(5000); assert.equal(network.inbox('c').length, 0);
  network.reset(); assert.equal(network.stats().queuedDeliveries, 0); assert.equal(network.inbox('a').length, 0);
});

test('network randomness is reproducible and unrelated links do not change outcomes', () => {
  const run = (unrelated: boolean) => {
    const { network, trace } = setup({ latencyMs: 20, jitterMs: 15, loss: .4 });
    for (let i = 0; i < 40; i++) {
      const time = i * 10;
      network.tick(time); network.send('a', { id: `${i}`, to: 'b', data: 'hello' }, time);
      if (unrelated) network.send('c', { id: `${i}`, to: 'a', data: 'extra' }, time);
    }
    network.tick(1000);
    return trace.filter(event => event.kind === 'delivered' && event.robotId === 'b').map(event => event.data);
  };
  assert.deepEqual(run(false), run(false)); assert.deepEqual(run(false), run(true));
});

test('radio validates bounds, loss, monotonic time, and closed state', () => {
  const { network } = setup({ loss: 1 });
  network.send('a', { id: '1', to: 'b', data: 'x' }, 0); network.tick(20); assert.equal(network.inbox('b').length, 0);
  assert.throws(() => network.tick(10), /non_monotonic/);
  assert.throws(() => network.register('bad', { loss: 2 }), /invalid_radio_loss/);
  assert.equal(network.send('a', { id: '2', to: 'b', data: 'x', ttlMs: NaN }, 20).reason, 'invalid_ttl');
  network.close(); assert.equal(network.send('a', { id: '2', to: 'b', data: 'x' }, 20).accepted, false);
});
