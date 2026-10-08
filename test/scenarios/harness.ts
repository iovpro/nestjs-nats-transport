import 'reflect-metadata';
import { INestMicroservice, LoggerService, Module, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { JSONCodec, JetStreamManager, StreamConfig, connect } from 'nats';
import { NatsServerConnectionOptions, ServerNats } from '../../src';
import { NATS_MAIN_MONITOR_URL, NATS_MAIN_URL } from './env';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const startedAt = Date.now();

export const log = (...args: unknown[]) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(2).padStart(6)}s]`, ...args);

/** Machine-readable lines parsed by test/utils/run-scenario.ts */
export const report = (result: Record<string, unknown>) => console.log(`@@RESULT ${JSON.stringify(result)}`);
export const marker = (name: string) => console.log(`@@${name}`);

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

export class CountingLogger implements LoggerService {
  readonly counts: Record<string, number> = {};
  /** Messages of any level that match `filter`; counted even when `quiet` */
  matched = 0;

  constructor(private readonly options: { quiet?: boolean; filter?: RegExp } = {}) {}

  log(message: unknown, ...rest: unknown[]) {
    this.write('log', message, rest);
  }

  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]) {
    this.write('verbose', message, rest);
  }

  private write(level: string, message: unknown, rest: unknown[]) {
    this.counts[level] = (this.counts[level] ?? 0) + 1;
    if (this.options.quiet && !this.options.filter) return;

    const text = [message, ...rest]
      .filter(part => part !== undefined)
      .map(part =>
        part instanceof Error ? `${part.name}: ${part.message}` : typeof part === 'object' ? JSON.stringify(part) : String(part),
      )
      .join(' | ');
    if (this.options.filter && !this.options.filter.test(text)) return;
    this.matched++;
    if (!this.options.quiet) log(`${level.toUpperCase()}:`, text.slice(0, 300));
  }
}

export const STREAM = 'E2E';
export const streams = (): Partial<StreamConfig>[] => [{ name: STREAM, subjects: ['e2e.js.>'] }];

/** Info of the consumer the library created for a subject, found by its filter */
export async function consumerInfoFor(jsm: JetStreamManager, subject: string) {
  const consumers = await jsm.consumers.list(STREAM).next();
  return consumers.find(info => info.config.filter_subject === subject);
}

export function createService(
  controllers: Type[],
  options: Partial<NatsServerConnectionOptions> = {},
  streamConfigs?: Partial<StreamConfig>[],
  logger: LoggerService | false = new CountingLogger(),
): Promise<INestMicroservice> {
  @Module({ controllers })
  class ScenarioModule {}

  const strategy = new ServerNats(
    { consumerName: 'e2e', connection: { servers: NATS_MAIN_URL }, ...options } as NatsServerConnectionOptions,
    streamConfigs,
  );

  return NestFactory.createMicroservice<MicroserviceOptions>(ScenarioModule, {
    strategy,
    ...(logger ? { logger } : {}),
  });
}

export async function startService(...args: Parameters<typeof createService>): Promise<INestMicroservice> {
  const app = await createService(...args);
  await app.listen();
  log('service is listening');
  return app;
}

/** Starts a service with a given strategy, for scenarios that use the strategy itself */
export async function startStrategy(
  strategy: ServerNats,
  controllers: Type[],
  logger: LoggerService = new CountingLogger({ quiet: true }),
) {
  @Module({ controllers })
  class StrategyModule {}

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(StrategyModule, { strategy, logger });
  await app.listen();
  log('service is listening');
  return app;
}

export async function resetStream(url: string) {
  const nc = await connect({ servers: url });
  const jsm = await nc.jetstreamManager();
  await jsm.streams.delete(STREAM).catch(() => undefined);
  await nc.close();
}

export async function createStream(url: string) {
  const nc = await connect({ servers: url });
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add(streams()[0]);
  await nc.close();
}

/** Publishes payloads in the wire format of ClientNats ({ pattern, data }) */
export async function publishJs(url: string, subject: string, payloads: unknown[]) {
  const nc = await connect({ servers: url });
  const js = nc.jetstream();
  for (const data of payloads) {
    await js.publish(subject, JSONCodec().encode({ pattern: subject, data }));
  }
  await nc.close();
}

export async function connectionsCount(): Promise<number> {
  const response = await fetch(`${NATS_MAIN_MONITOR_URL}/connz`);
  return ((await response.json()) as { num_connections: number }).num_connections;
}

/** Tracks how many handler invocations run at the same time */
export class ParallelismMeter {
  active = 0;
  max = 0;
  calls = 0;

  async run(durationMs: number) {
    this.calls++;
    this.active++;
    this.max = Math.max(this.max, this.active);
    await sleep(durationMs);
    this.active--;
  }
}
