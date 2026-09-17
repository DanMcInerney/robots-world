import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { MavlinkAdapter } from './mavlink.ts';

/** Explicit loopback-only UDP transport. Creating a codec never opens a socket. */
export class MavlinkUdpEndpoint {
  private socket: Socket;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private options: { adapter: MavlinkAdapter; port?: number; peer: { address: '127.0.0.1'; port: number }; onError?: (error: Error) => void };
  private constructor(options: MavlinkUdpEndpoint['options']) {
    if (options.peer.address !== '127.0.0.1' || !Number.isInteger(options.peer.port) || options.peer.port < 1 || options.peer.port > 65535) throw new Error('invalid_mavlink_udp_peer');
    if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new Error('invalid_mavlink_udp_port');
    this.options = options; this.socket = createSocket('udp4');
    this.socket.on('error', error => options.onError?.(error));
    this.socket.on('message', (message, remote) => {
      if (this.closed || remote.address !== options.peer.address || remote.port !== options.peer.port) return;
      if (this.pending >= 32) { options.onError?.(new Error('mavlink_udp_queue_full')); return; }
      this.pending++;
      this.queue = this.queue.then(async () => {
        if (!this.closed) await this.send(await options.adapter.receive(message));
      }).catch(error => options.onError?.(error instanceof Error ? error : new Error(String(error)))).finally(() => this.pending--);
    });
  }
  static async open(options: MavlinkUdpEndpoint['options']): Promise<MavlinkUdpEndpoint> {
    const endpoint = new MavlinkUdpEndpoint(options);
    await new Promise<void>((resolve, reject) => {
      endpoint.socket.once('error', reject);
      endpoint.socket.bind(options.port ?? 0, '127.0.0.1', () => { endpoint.socket.off('error', reject); resolve(); });
    });
    return endpoint;
  }
  address(): AddressInfo { return this.socket.address(); }
  async telemetry() { await this.send(await this.options.adapter.telemetry()); }
  async send(frames: readonly Buffer[]) {
    if (this.closed) return;
    for (const frame of frames) await new Promise<void>((resolve, reject) => this.socket.send(frame, this.options.peer.port, this.options.peer.address, error => error ? reject(error) : resolve()));
  }
  async close() { if (this.closed) return; this.closed = true; await new Promise<void>(resolve => this.socket.close(() => resolve())); }
}
