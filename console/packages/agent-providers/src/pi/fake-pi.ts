import { PI_READY } from './extension';
import type {
  PiLaunch,
  PiRecord,
  PiResponse,
  PiTransport,
  PiTransportFactory,
  PiTransportHandlers,
} from './rpc-client';

type Command = { type: string } & Record<string, unknown>;

/** The answers real Pi gave the commands the adapter sends, measured against Pi 1.4.0. */
function defaultResponse(command: Command): PiResponse {
  switch (command.type) {
    case 'get_state':
      return {
        success: true,
        data: {
          sessionId: 'pi-session-1',
          messageCount: 0,
          model: { id: 'scripted', provider: 'faux', input: ['text'] },
        },
      };
    case 'get_available_models':
      return {
        success: true,
        data: {
          models: [
            {
              id: 'gemini-2.5-flash',
              name: 'Gemini 2.5 Flash',
              provider: 'google',
              reasoning: true,
              input: ['text', 'image'],
            },
            {
              id: 'scripted',
              name: 'Scripted',
              provider: 'faux',
              reasoning: false,
              input: ['text'],
            },
          ],
        },
      };
    case 'set_model':
      return {
        success: true,
        data: { id: command.modelId, provider: command.provider, input: ['text', 'image'] },
      };
    case 'prompt':
      return { success: true, data: { disposition: 'started' } };
    case 'clear_queue':
      return { success: true, data: { steering: [], followUp: [] } };
    default:
      return { success: true };
  }
}

/**
 * A Pi that answers commands as the real one does and lets a test say what
 * it writes next. It says the Switch extension is ready as it starts, unless
 * told not to.
 */
export class FakePi implements PiTransport {
  /** Every record written to Pi, commands and extension answers alike, in order. */
  readonly written: Command[] = [];
  respond: (command: Command) => PiResponse | Promise<PiResponse> = defaultResponse;
  stderr = '';
  isAlive = true;
  disposed = false;

  constructor(
    readonly launch: PiLaunch,
    private readonly handlers: PiTransportHandlers,
    options: { ready: boolean }
  ) {
    if (options.ready)
      queueMicrotask(() =>
        this.emit({
          type: 'extension_ui_request',
          id: 'ready',
          method: 'notify',
          message: PI_READY,
        })
      );
  }

  /** The commands of one type that were sent. */
  sent(type: string): Command[] {
    return this.written.filter((command) => command.type === type);
  }

  async command(command: Command): Promise<PiResponse> {
    if (!this.isAlive) throw new Error(`Pi is gone; ${command.type} was not sent.`);
    this.written.push(command);
    return await this.respond(command);
  }

  send(record: Command): void {
    if (!this.isAlive) throw new Error(`Pi is gone; ${record.type} was not sent.`);
    this.written.push(record);
  }

  emit(record: PiRecord): void {
    this.handlers.onRecord(record);
  }

  exit(reason: string): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    this.handlers.onExit(reason);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.exit('Pi exited (code 0, signal null)');
  }
}

/** A transport factory that keeps every Pi it started, the newest last. */
export function fakePiTransport(options: { ready?: boolean } = {}): {
  factory: PiTransportFactory;
  started: FakePi[];
  last: () => FakePi;
} {
  const started: FakePi[] = [];
  return {
    factory: (launch, handlers) => {
      const pi = new FakePi(launch, handlers, { ready: options.ready ?? true });
      started.push(pi);
      return pi;
    },
    started,
    last: () => {
      const pi = started.at(-1);
      if (!pi) throw new Error('no Pi was started');
      return pi;
    },
  };
}
