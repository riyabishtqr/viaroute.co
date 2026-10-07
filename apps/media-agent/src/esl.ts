/**
 * Minimal FreeSWITCH Event Socket (ESL, "inbound" mode) client: connect, authenticate, run commands,
 * receive events. Protocol: header blocks ending in a blank line, optional body of Content-Length bytes.
 */
import { EventEmitter } from 'node:events';
import { Socket, connect } from 'node:net';

export type Headers = Record<string, string>;

export interface EslEvent {
  name: string;
  headers: Headers;
  body: string;
}

/** Parses "Key: value" lines (values URL-encoded in plain events). */
export function parseHeaders(block: string, decode = false): Headers {
  const out: Headers = {};
  for (const line of block.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    out[key] = decode ? safeDecode(raw) : raw;
  }
  return out;
}

function safeDecode(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Splits a byte stream into ESL messages. Feed it chunks; it calls `onMessage` for each complete one. */
export class EslParser {
  private buf = Buffer.alloc(0);
  constructor(private onMessage: (headers: Headers, body: string) => void) {}

  push(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const end = this.buf.indexOf('\n\n');
      if (end < 0) return;
      const headers = parseHeaders(this.buf.subarray(0, end).toString('utf8'));
      const len = Number(headers['Content-Length'] ?? 0);
      if (this.buf.length < end + 2 + len) return; // body not complete yet
      const body = this.buf.subarray(end + 2, end + 2 + len).toString('utf8');
      this.buf = this.buf.subarray(end + 2 + len);
      this.onMessage(headers, body);
    }
  }
}

/** A plain-text event body: its own headers (URL-encoded) and maybe a body after a blank line. */
export function parsePlainEvent(text: string): EslEvent {
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const headers = parseHeaders(head, true);
  const len = Number(headers['Content-Length'] ?? 0);
  const body = split >= 0 && len ? text.slice(split + 2, split + 2 + len) : '';
  return { name: headers['Event-Name'] ?? '', headers, body };
}

/** The bytes for one command: header lines, and with `body` a Content-Length and the body itself. */
export function commandBytes(command: string, body?: string): string {
  if (body === undefined) return `${command}\n\n`;
  return `${command}\ncontent-type: text/plain\ncontent-length: ${Buffer.byteLength(body)}\n\n${body}`;
}

interface Pending {
  resolve: (r: { headers: Headers; body: string }) => void;
  reject: (e: Error) => void;
}

/**
 * Connection to FreeSWITCH. Emits 'event' (EslEvent), 'ready' after login, 'close'.
 * Reconnects automatically. Replies come back in the order commands were sent.
 */
export class EslClient extends EventEmitter {
  private socket?: Socket;
  private pending: Pending[] = [];
  private connected = false;
  private stopped = false;

  constructor(
    private opts: { host: string; port: number; password: string; events: string[]; log?: (m: string) => void },
  ) {
    super();
  }

  get ready() {
    return this.connected;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    this.socket?.destroy();
  }

  private open() {
    const log = this.opts.log ?? (() => {});
    const socket = connect(this.opts.port, this.opts.host);
    this.socket = socket;
    const parser = new EslParser((h, b) => this.onMessage(h, b));
    socket.on('data', (c: Buffer) => parser.push(c));
    socket.on('error', (e) => log(`FreeSWITCH connection: ${e.message}`));
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      for (const p of this.pending.splice(0)) p.reject(new Error('FreeSWITCH connection closed'));
      if (wasConnected) this.emit('close');
      if (!this.stopped) setTimeout(() => this.open(), 2000).unref();
    });
  }

  private onMessage(headers: Headers, body: string) {
    const type = headers['Content-Type'];
    if (type === 'auth/request') {
      this.pending.push({
        resolve: (r) => {
          if (!r.headers['Reply-Text']?.startsWith('+OK')) {
            this.opts.log?.(`FreeSWITCH refused the event-socket password (${r.headers['Reply-Text']})`);
            return;
          }
          this.send(`event plain ${this.opts.events.join(' ')}`).then(() => {
            this.connected = true;
            this.emit('ready');
          }, () => {});
        },
        reject: () => {},
      });
      this.socket!.write(commandBytes(`auth ${this.opts.password}`));
      return;
    }
    if (type === 'command/reply' || type === 'api/response') {
      this.pending.shift()?.resolve({ headers, body });
      return;
    }
    if (type === 'text/event-plain') {
      this.emit('event', parsePlainEvent(body));
      return;
    }
    if (type === 'text/disconnect-notice') this.socket?.destroy();
  }

  /** Sends one command and resolves with its reply. */
  send(command: string, body?: string): Promise<{ headers: Headers; body: string }> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('FreeSWITCH is not connected'));
      this.pending.push({ resolve, reject });
      this.socket.write(commandBytes(command, body));
    });
  }

  /** `api <cmd>`: runs and returns the text result ("+OK …" / "-ERR …"). */
  async api(cmd: string): Promise<string> {
    return (await this.send(`api ${cmd}`)).body.trim();
  }

  /** `bgapi <cmd>`: runs in the background; the result arrives as a BACKGROUND_JOB event with this Job-UUID. */
  async bgapi(cmd: string, jobUuid: string): Promise<void> {
    const r = await this.send(`bgapi ${cmd}\nJob-UUID: ${jobUuid}`);
    if (!r.headers['Reply-Text']?.startsWith('+OK')) throw new Error(r.headers['Reply-Text'] ?? 'bgapi failed');
  }

  /** Runs a dialplan application on a channel; CHANNEL_EXECUTE_COMPLETE carries `Application-UUID: eventUuid`. */
  async execute(uuid: string, app: string, arg: string, eventUuid: string): Promise<void> {
    const head = [`sendmsg ${uuid}`, 'call-command: execute', `execute-app-name: ${app}`, `Event-UUID: ${eventUuid}`].join('\n');
    // The argument goes in the body, so spaces and punctuation in spoken text arrive intact.
    const r = await this.send(head, arg);
    if (!r.headers['Reply-Text']?.startsWith('+OK')) throw new Error(r.headers['Reply-Text'] ?? 'execute failed');
  }
}
