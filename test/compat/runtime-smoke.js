// Runtime smoke test (COMPAT-03): RPC request + JetStream event through the compiled library.
// Runs inside a project with a specific NestJS version: node runtime-smoke.js <path-to-compiled-library> <nats-url>
require('reflect-metadata');
const { Controller, Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Payload } = require('@nestjs/microservices');
const { connect } = require('nats');

const lib = require(process.argv[2]);
const url = process.argv[3];
const received = [];

class SmokeController {
  echo(data) {
    return { received: data };
  }

  event(data) {
    received.push(data);
  }
}

const descriptor = name => Object.getOwnPropertyDescriptor(SmokeController.prototype, name);
lib.NatsMessagePattern('compat.rpc.echo')(SmokeController.prototype, 'echo', descriptor('echo'));
lib.NatsEventPattern('compat.js.event')(SmokeController.prototype, 'event', descriptor('event'));
Payload()(SmokeController.prototype, 'echo', 0);
Payload()(SmokeController.prototype, 'event', 0);
Controller()(SmokeController);

class SmokeModule {}
Module({ controllers: [SmokeController] })(SmokeModule);

(async () => {
  const nc = await connect({ servers: url });
  await (await nc.jetstreamManager()).streams.delete('COMPAT').catch(() => undefined);
  await nc.close();

  const app = await NestFactory.createMicroservice(SmokeModule, {
    strategy: new lib.ServerNats({ consumerName: 'compat', connection: { servers: url }, jetStream: true }, [
      { name: 'COMPAT', subjects: ['compat.js.>'] },
    ]),
    logger: false,
  });
  await app.listen();

  const client = new lib.ClientNats({ connection: { servers: url }, jetStream: true });
  const reply = await client.request('compat.rpc.echo', { a: 1 });
  await client.event('compat.js.event', { b: 2 });
  await new Promise(resolve => setTimeout(resolve, 1000));

  const ok = JSON.stringify(reply) === '{"received":{"a":1}}' && JSON.stringify(received) === '[{"b":2}]';
  console.log(ok ? 'OK' : `unexpected result: rpc=${JSON.stringify(reply)} event=${JSON.stringify(received)}`);
  await client.close();
  await app.close();
  process.exit(ok ? 0 : 1);
})().catch(error => {
  console.log(`FAILED: ${error && error.message}`);
  process.exit(1);
});
