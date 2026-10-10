# NestJS NATS Transport

A full-featured transport layer library for NestJS providing integration with NATS messaging and JetStream. Supports request-response (RPC) patterns, event-driven architecture, and reliable message delivery through JetStream.

[![npm version](https://img.shields.io/npm/v/nestjs-nats-transport.svg)](https://www.npmjs.com/package/nestjs-nats-transport)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Table of Contents

- [Key Features](#key-features);
- [Installation](#installation);
- [Quick Start](#quick-start);
- [Server Configuration](#server-configuration);
- [Client Configuration](#client-configuration);
- [Publishing Messages](#publishing-messages);
- [Receiving Messages](#receiving-messages);
- [JetStream](#jetstream);
- [Error Handling](#error-handling);
- [Working with Headers](#working-with-headers);
- [Advanced Scenarios](#advanced-scenarios);
- [API Reference](#api-reference);
- [Development](#development)

## Key Features

### What makes this library different from NestJS built-in NATS transport?

✅ **Full JetStream Support** - Automatic creation and management of consumers, streams, and durable consumers
✅ **RPC over NATS** - Request-response pattern implementation with typed responses and timeouts
✅ **Flexible Event Handling** - Support for both traditional pub/sub and JetStream event streaming
✅ **NAK Strategies** - Smart retry management with regular, incremental, and Fibonacci backoff delays
✅ **Header Support** - Pass metadata through NATS headers to handlers and set headers on RPC replies
✅ **Concurrency Control** - Limit the number of concurrent JetStream handlers (`max_handlers`)
✅ **TypeScript & DI** - Full integration with TypeScript type system and NestJS Dependency Injection

## Installation

```bash
npm install nestjs-nats-transport nats
```

Requirements:

- Node.js >= 16 with NestJS 10, >= 20 with NestJS 11, 20.19+ or 22.12+ with NestJS 12
- NestJS 10, 11 or 12
- `nats` 2.29.2 or a later 2.x: a peer dependency, installed next to the library. The `nats` package (nats.js v2) is deprecated in favor of the modular `@nats-io/*` packages (v3); the library will migrate to v3 in a future major version
- NATS Server 2.2+; JetStream handlers need 2.9.4+ (`filter_subjects` and `metadata`: 2.10+)

NestJS 12 is published as ES modules. The library is built as CommonJS and loads NestJS with `require()`, which Node.js supports for ES modules since 20.19 and 22.12.

## Quick Start

### 1. Setting up a Microservice (Server)

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ServerNats } from 'nestjs-nats-transport';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    strategy: new ServerNats(
      {
        consumerName: 'user-service',
        connection: {
          servers: ['nats://localhost:4222'],
        },
        jetStream: true, // Enable JetStream
      },
      // The stream that stores the events; RPC subjects stay out of streams
      [{ name: 'USERS', subjects: ['user.created'] }],
    ),
  });

  await app.listen();
  console.log('User microservice is listening');
}

bootstrap();
```

### 2. Creating Message Handlers

```typescript
// user.controller.ts
import { Controller } from '@nestjs/common';
import { Payload, Ctx } from '@nestjs/microservices';
import { NatsMessagePattern, NatsEventPattern, NatsContext } from 'nestjs-nats-transport';

@Controller()
export class UserController {
  // RPC handler - returns response
  @NatsMessagePattern('user.get')
  async getUser(@Payload() data: { id: string }, @Ctx() ctx: NatsContext) {
    const subject = ctx.getSubject(); // 'user.get'
    return {
      id: data.id,
      name: 'John Doe',
      email: 'john@example.com',
    };
  }

  // Event handler - no response
  @NatsEventPattern('user.created')
  async handleUserCreated(@Payload() data: { userId: string }, @Ctx() ctx: NatsContext) {
    console.log(`New user created: ${data.userId}`);
    // Process event without returning response
  }
}
```

### 3. Setting up a Client

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ClientNatsModule } from 'nestjs-nats-transport';
import { UserService } from './user.service';

@Module({
  imports: [
    ClientNatsModule.register({
      connection: {
        servers: ['nats://localhost:4222'],
      },
      jetStream: true,
    }),
  ],
  providers: [UserService],
})
export class AppModule {}
```

### 4. Sending Messages from Client

```typescript
// user.service.ts
import { Injectable, Inject } from '@nestjs/common';
import { ClientNats } from 'nestjs-nats-transport';

@Injectable()
export class UserService {
  constructor(@Inject('ClientNats') private readonly client: ClientNats) {}

  // RPC request - expects response
  async getUserById(id: string) {
    const user = await this.client.request<User>('user.get', { id });
    return user;
  }

  // Event - no reply from the handler; with jetStream: true it resolves once the stream stores it
  async notifyUserCreated(userId: string) {
    await this.client.event('user.created', { userId });
  }
}
```

## Server Configuration

### Basic Configuration

```typescript
import { ServerNats } from 'nestjs-nats-transport';
import { DeliverPolicy } from 'nats';

const server = new ServerNats({
  // Required - consumer name
  // Queue group of event subscriptions and prefix of JetStream consumer names
  consumerName: 'user-service',

  // NATS connection settings
  connection: {
    servers: ['nats://localhost:4222'],
    user: 'username',
    pass: 'password',
    // All options from official NATS client
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    // TLS: recommended for production, especially when passing credentials or tokens in headers
    tls: {
      certFile: './certs/client-cert.pem',
      keyFile: './certs/client-key.pem',
      caFile: './certs/ca.pem',
    },
  },

  // Enable JetStream support
  jetStream: true,

  // JetStream options (optional)
  jetStreamOptions: {
    timeout: 3000,
  },

  // Global settings for all event handlers
  // Can be overridden in decorators
  globalEventOptions: {
    deliver_policy: DeliverPolicy.New,
    nak_delay: 2000,
    max_handlers: 5,
  },

  // Custom serializers/deserializers (optional)
  // A custom deserializer must return the NestJS envelope shape { pattern, data }
  // (IncomingRequest for RPC, IncomingEvent for events); the handler receives the `data` field
  serializer: new CustomSerializer(),
  deserializer: new CustomDeserializer(),
});
```

### Reconnection

`ServerNats` and `ClientNats` reconnect to NATS without a limit by default: `maxReconnectAttempts` is `-1` unless you set it in `connection` (the nats.js default is 10 attempts, `reconnectTimeWait` apart).

If nats.js closes the connection for good (the attempts allowed by `maxReconnectAttempts` run out, or the server rejects the credentials twice in a row), `ServerNats` logs the error and connects anew every 5 seconds (`RECONNECT_DELAY`) until it succeeds or `close()` is called: it sets up the streams again and restores the JetStream consumers and the RPC and event subscriptions. An attempt that connects but cannot create a consumer (for example, its stream was deleted and is not in the stream configs) is retried the same way. `ClientNats` opens a new connection on the next request; while NATS is unreachable, the request fails with the connection error.

If NATS rejects the credentials when `listen()` connects (`AUTHORIZATION_VIOLATION`), `ServerNats` logs the error and tries again every 5 seconds until it connects or `close()` is called, so the service can start before NATS loads its new credentials. Meanwhile `listen()` does not complete; `close()` makes it reject.

### Shutdown

`close()` (called by `app.close()`) stops taking messages: it drains the subscriptions, so the requests and events that NATS has already routed to the service are still handled, and stops the JetStream consumers. Then it waits until the handlers in progress, including the messages that are still being deserialized, have replied or acknowledged their messages, and drains the connection. The drain of the subscriptions and the wait for the handlers take at most `GRACE_PERIOD` (10 seconds) together; the drain of the connection takes one more round trip to NATS. A JetStream message that waits in the client buffer for a free handler is not processed: NATS delivers it again after `ack_wait`.

While NATS is unreachable, `close()` does not drain, since a drain would wait for the next reconnect attempt: it unsubscribes, waits for the handlers in progress as above and closes the connection; the replies that handlers send meanwhile are lost. If nats.js closes the connection for good while `close()` waits (the reconnect attempts run out), `close()` goes on at once. A `close()` called again, also while the first one runs, waits for the same close.

If `close()` is called before `listen()` has completed (while it connects, sets up the streams and consumers, or waits to retry rejected credentials), `listen()` rejects with `ServerNats was closed before listen() completed`, and a connection it opens afterwards is closed. A `listen()` after a `close()` that came first rejects the same way without connecting: NestJS calls `listen()` after the init hooks of the application, so `app.close()` during them closes the server before it starts. The code after `await app.listen()` or `await app.startAllMicroservices()` does not run then, and the bootstrap stops.

After `close()` the same application can call `listen()` again, for example after `app.getTransportServer().close()` in NestJS 12: `ServerNats` connects anew and subscribes the handlers again. `close()` removes the listeners registered with `on()`, so register them again. A `listen()` called while `close()` runs waits for it. A `listen()` called again without `close()`, for example after a `listen()` that has rejected, first closes the connection and the consumers of the previous one.

An instance keeps the handlers of the application that registered them, so give each application its own `ServerNats`. With a reused instance, `listen()` of the next application rejects with `Several handlers for the … pattern` only when both applications register the same RPC or JetStream pattern. Otherwise the handlers of the closed application stay subscribed: the requests and JetStream messages on their patterns reach them, and each NATS event of a pattern that both applications handle reaches both.

### Connection Status and Events

`ServerNats` and `ClientNats` report the connection status and events like the built-in NATS transport of NestJS 11+. With NestJS 11 and 12 use `app.status` and `app.on()` of the microservice; the strategy and the client have the same members, also with NestJS 10:

```typescript
app.status.subscribe(status => console.log(`NATS: ${status}`)); // 'connected' | 'disconnected' | 'reconnecting'
app.on('disconnect', (server: string) => console.warn(`NATS ${server} is unreachable`));
app.on('reconnect', (server: string) => console.log(`NATS ${server} is back`));
app.on('update', ({ added, deleted }: { added: string[]; deleted: string[] }) => console.log(added, deleted));
```

`close()` removes the listeners. A listener that throws or rejects is logged, and the other listeners of the event are still called. While `ServerNats` connects anew after the connection was closed for good, the status stays `reconnecting` until an attempt connects; if the attempt then fails to set up the streams, consumers or subscriptions, the status goes back to `reconnecting`. In this pause `unwrap()` throws: there is no connection.

### Processing Hooks

NestJS 11.1.4 and later let tracing tools wrap message processing with processing hooks; `ServerNats` supports them with NestJS 10 too. It runs every handler (RPC, NATS events and JetStream events) inside the start hook and calls the end hook when the handler's result completes, before the reply or the ack is sent. The context is a `NatsContext`: `getSubject()` and `getHeaders()` give what a trace needs.

```typescript
const trace = new AsyncLocalStorage<string>();
const strategy = new ServerNats({ consumerName: 'orders', connection: { servers: ['nats://localhost:4222'] } });

// Handlers run inside trace.run(): trace.getStore() gives them the subject
strategy.setOnProcessingStartHook((transportId, context, done) =>
  trace.run((context as NatsContext).getSubject(), done),
);
strategy.setOnProcessingEndHook((transportId, context) =>
  console.log('processed', (context as NatsContext).getSubject()),
);
```

If the start hook throws or rejects before it calls `done`, the handler and the end hook are not called: `ServerNats` logs the error and handles the message as if the handler had failed. A JetStream message is NAKed and delivered again, an RPC request gets the reply `{ message: 'Internal Server Error: <error message>', statusCode: 500 }`, and a NATS event is only logged. A `done` called after such a failure does nothing. An error after `done` is called is only logged, and so is an error of the end hook: the message is processed as without it.

### Setting up JetStream Streams

Pass the streams the service needs as the second argument of `ServerNats`: with `jetStream: true`, `listen()` creates the streams that do not exist and updates the existing ones before it subscribes the handlers.

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ServerNats } from 'nestjs-nats-transport';
import { RetentionPolicy, StorageType } from 'nats';

async function bootstrap() {
  const streams = [
    {
      name: 'ORDERS',
      subjects: ['orders.*'], // orders.created, orders.updated, etc.
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
    },
    {
      name: 'USERS',
      subjects: ['users.*'],
      retention: RetentionPolicy.Interest,
      max_age: 3600_000_000_000, // 1 hour in nanoseconds
    },
  ];

  const serverNats = new ServerNats(
    {
      consumerName: 'order-service',
      connection: { servers: ['nats://localhost:4222'] },
      jetStream: true,
    },
    streams,
  );

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, { strategy: serverNats });

  await app.listen();
}

bootstrap();
```

`listen()` resolves once the consumers of all JetStream handlers are created. If a consumer cannot be created — no stream stores the subject of a handler, or the NATS server rejects the consumer configuration — `listen()` rejects with the error. The connection and the consumers created by then keep running until `close()` or the next `listen()`: if the application handles the error and goes on, call `app.close()` or `listen()` again.

Stream setup reads the first page of the stream list (up to 256 streams on a typical NATS server). If there are more streams, an existing stream may not be found: `ServerNats` then creates it with `streams.add`, which NATS accepts when the configuration is the same (the log still says `Stream … created`) and rejects when it differs, so `listen()` rejects. When updating an existing stream, the new configuration is merged with the current one (`{ ...currentConfig, ...newConfig }`): a field removed from the config keeps its previous value on the server; to remove it, delete and recreate the stream.

Keep RPC subjects out of the streams' subjects: a stream stores a request sent to its subject and replies with its acknowledgement, which `request()` returns instead of the handler's reply.

## Client Configuration

### Registration via Module (Recommended)

```typescript
// app.module.ts
import { Module } from '@nestjs/common';
import { ClientNatsModule } from 'nestjs-nats-transport';

@Module({
  imports: [
    // Register with default name 'ClientNats'
    ClientNatsModule.register({
      connection: {
        servers: ['nats://localhost:4222'],
      },
      jetStream: true,
    }),

    // Or with custom name for multiple clients
    ClientNatsModule.register(
      {
        connection: {
          servers: ['nats://orders.example.com:4222'],
        },
        jetStream: true,
      },
      'OrdersNatsClient',
    ),
  ],
})
export class AppModule {}
```

### Using in Services

```typescript
// order.service.ts
import { Injectable, Inject } from '@nestjs/common';
import { ClientNats } from 'nestjs-nats-transport';

@Injectable()
export class OrderService {
  constructor(
    @Inject('ClientNats') private readonly natsClient: ClientNats,
    @Inject('OrdersNatsClient') private readonly ordersClient: ClientNats,
  ) {}

  async createOrder(orderData: CreateOrderDto) {
    // Using main client
    const result = await this.natsClient.request('orders.create', orderData);

    // Using second client
    await this.ordersClient.event('order.notification', { orderId: result.id });

    return result;
  }
}
```

### Manual Registration via ClientsModule

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { ClientNats } from 'nestjs-nats-transport';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        customClass: ClientNats,
        options: {
          connection: {
            servers: ['nats://localhost:4222'],
          },
          jetStream: true,
        },
      },
    ]),
  ],
})
export class AppModule {}
```

## Publishing Messages

### RPC Requests (Request-Response)

RPC is used when you need a synchronous response from another microservice.

```typescript
import { Injectable, Inject } from '@nestjs/common';
import { ClientNats } from 'nestjs-nats-transport';

@Injectable()
export class PaymentService {
  constructor(@Inject('ClientNats') private readonly client: ClientNats) {}

  async processPayment(orderId: string, amount: number) {
    try {
      // Times out after requestTimeout of the client options, 30 seconds by default
      const result = await this.client.request<PaymentResult>('payment.process', {
        orderId,
        amount,
        currency: 'USD',
      });

      return result;
    } catch (error) {
      // Automatically wrapped in NatsRpcException
      console.error('Payment failed:', error.message);
      throw error;
    }
  }

  // Request with headers
  async processWithAuth(orderId: string, token: string) {
    const headers = {
      authorization: `Bearer ${token}`,
      'request-id': crypto.randomUUID(),
    };

    return this.client.request('payment.process', { orderId }, headers);
  }

  // Using array patterns (automatically joined with dots)
  async getPaymentStatus(paymentId: string) {
    // ['payment', 'status'] -> 'payment.status'
    return this.client.request(['payment', 'status'], { paymentId });
  }
}
```

### Events (Fire-and-Forget)

Events are used for asynchronous notifications without waiting for a response. With `jetStream: true`, `event()` publishes to JetStream and resolves once a stream has stored the message; it rejects when no stream stores the subject.

```typescript
@Injectable()
export class NotificationService {
  constructor(@Inject('ClientNats') private readonly client: ClientNats) {}

  // Simple event publishing
  async sendWelcomeEmail(userId: string, email: string) {
    await this.client.event('email.welcome', { userId, email });
  }

  // Event with headers
  async sendWithPriority(userId: string, message: string) {
    const headers = {
      priority: 'high',
      timestamp: new Date().toISOString(),
    };

    await this.client.event('notification.send', { userId, message }, headers);
  }

  // Bulk event publishing
  async notifyMultipleUsers(userIds: string[]) {
    const promises = userIds.map(userId => this.client.event('user.notification', { userId, message: 'Hello!' }));

    await Promise.all(promises);
  }
}
```

### Direct Access to NATS Client

For advanced scenarios, you can get direct access to the native NATS client:

```typescript
@Injectable()
export class AdvancedService {
  constructor(@Inject('ClientNats') private readonly client: ClientNats) {}

  async useNativeClient() {
    // Get NatsConnection; connect() opens it unless a request or an event already did
    const natsConnection = await this.client.connect();

    // Subscribe to events directly
    const subscription = natsConnection.subscribe('alerts.*');
    for await (const msg of subscription) {
      console.log('Alert:', msg.string());
    }
  }

  async useJetStream() {
    // Get JetStream client (with jetStream: true, once connected)
    await this.client.connect();
    const js = this.client.getJetStreamClient();

    // Publish with JetStream options
    const ack = await js.publish(
      'orders.created',
      JSON.stringify({
        orderId: '12345',
        total: 99.99,
      }),
    );

    console.log('Published to stream:', ack.stream, 'seq:', ack.seq);
  }
}
```

## Receiving Messages

### RPC Handlers (Message Pattern)

Use `@NatsMessagePattern()` to create handlers that return a response to the client.

An RPC pattern takes one handler, with or without JetStream: `listen()` rejects when another handler, RPC or event, uses the pattern of an RPC handler. NestJS keeps one handler of such a pattern and never calls the others.

```typescript
import { Controller, HttpStatus } from '@nestjs/common';
import { Payload, Ctx, NatsRecord } from '@nestjs/microservices';
import { NatsMessagePattern, NatsContext, NatsRpcException } from 'nestjs-nats-transport';

@Controller()
export class OrderController {
  // Simple RPC handler
  @NatsMessagePattern('order.get')
  async getOrder(@Payload() data: { orderId: string }, @Ctx() ctx: NatsContext) {
    const subject = ctx.getSubject(); // 'order.get'

    return {
      id: data.orderId,
      status: 'completed',
      total: 150.0,
    };
  }

  // Handler with array pattern
  @NatsMessagePattern(['order', 'create'])
  async createOrder(@Payload() data: CreateOrderDto, @Ctx() ctx: NatsContext) {
    // Data validation
    if (!data.items || data.items.length === 0) {
      throw new NatsRpcException({
        message: 'Order must contain at least one item',
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: 'EMPTY_ORDER',
      });
    }

    const order = await this.orderService.create(data);
    return order;
  }

  // Return data with headers
  @NatsMessagePattern('order.process')
  async processOrder(@Payload() data: { orderId: string }, @Ctx() ctx: NatsContext) {
    const order = await this.orderService.process(data.orderId);

    // Return NatsRecord with headers
    return new NatsRecord(order, {
      'processing-time': '250ms',
      'server-id': 'order-service-01',
    });
  }

  // Async processing with external dependencies
  @NatsMessagePattern('order.validate')
  async validateOrder(@Payload() data: ValidateOrderDto, @Ctx() ctx: NatsContext) {
    // Check inventory availability
    const available = await this.inventoryService.checkAvailability(data.items);

    if (!available) {
      throw new NatsRpcException({
        message: 'Some items are out of stock',
        statusCode: HttpStatus.CONFLICT,
        errors: { items: ['item-123', 'item-456'] },
      });
    }

    // Validate payment data
    const paymentValid = await this.paymentService.validate(data.paymentMethod);

    return {
      valid: available && paymentValid,
      estimatedDelivery: new Date(),
    };
  }
}
```

### Event Handlers (Event Pattern)

Use `@NatsEventPattern()` to handle events without returning a response.

`jetStream` in the `ServerNats` options applies to all event handlers: with `jetStream: true` each one reads from a JetStream consumer, and its subject must be stored in a stream; without it each one is a core NATS subscription (queue group `consumerName`), and the JetStream options, `NAK` and `TERM` have no effect. With `jetStream: true` a pattern takes one handler: a JetStream message has one acknowledgement, so `listen()` rejects when several `@NatsEventPattern` handlers share a pattern. Without JetStream every handler of a pattern receives each event, as in NestJS.

#### Traditional NATS Pub/Sub

```typescript
import { Controller } from '@nestjs/common';
import { Payload, Ctx } from '@nestjs/microservices';
import { NatsEventPattern, NatsContext } from 'nestjs-nats-transport';

@Controller()
export class UserController {
  constructor(private readonly emailService: EmailService) {}

  // Simple event handler
  @NatsEventPattern('user.registered')
  async handleUserRegistered(@Payload() data: { userId: string; email: string }) {
    await this.emailService.sendWelcomeEmail(data.email);
    console.log(`Welcome email sent to user ${data.userId}`);
  }

  // Event handler with wildcard topics
  @NatsEventPattern('user.profile.*')
  async handleProfileEvents(@Payload() data: any, @Ctx() ctx: NatsContext) {
    const subject = ctx.getSubject();

    // subject can be: 'user.profile.updated', 'user.profile.deleted', etc.
    console.log(`Profile event received: ${subject}`, data);
  }

  // Processing with header access
  @NatsEventPattern('user.action')
  async handleUserAction(@Payload() data: any, @Ctx() ctx: NatsContext) {
    const headers = ctx.getHeaders();
    const userId = headers?.get('user-id');
    const timestamp = headers?.get('timestamp');

    console.log(`Action from user ${userId} at ${timestamp}`);
  }
}
```

#### JetStream Event Handlers

JetStream provides persistence, redelivery until a message is acknowledged, and consumer state management.

```typescript
import { Controller, HttpStatus } from '@nestjs/common';
import { Payload } from '@nestjs/microservices';
import { NatsEventPattern, NatsContext, NAK, TERM, NakStrategy } from 'nestjs-nats-transport';
import { DeliverPolicy } from 'nats';

@Controller()
export class OrderController {
  // Basic JetStream handler
  @NatsEventPattern('orders.created', {
    deliver_policy: DeliverPolicy.New, // Only new messages
    nak_delay: 2000, // Delay before retry on error
  })
  async handleOrderCreated(@Payload() data: { orderId: string }) {
    await this.processOrder(data.orderId);
    // On success, ack() is automatically called
  }

  // Handler with acknowledgment management
  @NatsEventPattern('orders.payment', {
    deliver_policy: DeliverPolicy.New,
    nak_strategy: NakStrategy.increment, // Incremental delay on retries (type-safe enum)
    nak_delay: 1000, // Initial delay
    nak_delay_max: 60000, // Maximum delay
  })
  async handlePayment(@Payload() data: { orderId: string; amount: number }) {
    try {
      const success = await this.paymentService.charge(data.orderId, data.amount);

      if (!success) {
        // Return NAK - message will be redelivered
        return NAK;
      }

      // Success - automatic ack
      return;
    } catch (error) {
      if (error.code === 'INVALID_CARD') {
        // Terminal error - don't retry
        return TERM;
      }

      // Temporary error - retry later
      return NAK;
    }
  }

  // Durable consumer for scaling
  @NatsEventPattern('orders.processing', {
    deliver_policy: DeliverPolicy.All, // Process all messages
    max_handlers: 10, // Process up to 10 messages concurrently
    ack_wait: 30_000_000_000, // 30 seconds in nanoseconds
  })
  async processOrders(@Payload() data: OrderData) {
    // Long processing...
    await this.heavyProcessing(data);
  }

  // Processing from stream start (for data recovery)
  @NatsEventPattern('orders.history', {
    deliver_policy: DeliverPolicy.All, // All messages from start
    max_handlers: 1, // Sequential processing
  })
  async rebuildOrderHistory(@Payload() data: OrderData) {
    await this.historyService.rebuild(data);
  }

  // Processing from specific sequence
  @NatsEventPattern('orders.replay', {
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: 1000, // Start from message #1000
  })
  async replayOrders(@Payload() data: OrderData) {
    await this.replayService.process(data);
  }

  // Consumer with subject filtering
  @NatsEventPattern('orders.notifications', {
    filter_subject: 'orders.created', // Only orders.created from stream
    deliver_policy: DeliverPolicy.New,
  })
  async handleOrderNotifications(@Payload() data: OrderData) {
    await this.notificationService.send(data);
  }
}
```

### Global Event Settings

To apply common settings to all JetStream handlers, use `globalEventOptions`:

```typescript
// main.ts
import { DeliverPolicy } from 'nats';
import { ServerNats, NakStrategy } from 'nestjs-nats-transport';

const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  strategy: new ServerNats({
    consumerName: 'order-service',
    connection: { servers: ['nats://localhost:4222'] },
    jetStream: true,

    // Global settings for all @NatsEventPattern
    globalEventOptions: {
      deliver_policy: DeliverPolicy.New,
      nak_delay: 2000,
      nak_strategy: NakStrategy.increment,
      max_handlers: 5,
      ack_wait: 30_000_000_000, // 30 seconds
    },
  }),
});
```

Settings in decorators override global settings:

```typescript
@NatsEventPattern('critical.orders', {
  max_handlers: 1, // Overrides globalEventOptions
  nak_delay: 500,  // Overrides globalEventOptions
  // deliver_policy and nak_strategy inherited from globalEventOptions
})
async handleCriticalOrders(@Payload() data: OrderData) {
  // ...
}
```

A decorator setting that is `undefined` or `null`, such as a value from a configuration that does not set it, keeps the global setting.

## JetStream

### What is JetStream?

JetStream is NATS's built-in persistence and streaming system that provides:

- **Redelivery** - a stored message is delivered again until it is acknowledged, terminated or removed by the stream's limits
- **Persistence** - storage in filesystem or memory
- **Replay** - ability to reprocess message history
- **At-least-once delivery** - each message will be delivered at least once
- **Streams and Consumers** - separation of storage and consumption

### JetStream Architecture

```
┌─────────────┐
│  Publisher  │
└──────┬──────┘
       │ publish('orders.created');
       ▼
┌─────────────────────────┐
│   Stream: ORDERS        │ ◄── Persistent storage
│   subjects: orders.*    │
│   retention: limits     │
└────────┬────────────────┘
         │
    ┌────┴────┬──────────┐
    ▼         ▼          ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Consumer1│ │Consumer2│ │Consumer3│ ◄── Independent handlers
└─────────┘ └─────────┘ └─────────┘
```

### Creating a Stream

A stream must be created before publishing messages:

```typescript
// main.ts
import { RetentionPolicy, StorageType, DiscardPolicy } from 'nats';

const serverNats = new ServerNats(options, [
  {
    name: 'ORDERS',
    // Subjects to be stored in stream
    subjects: ['orders.created', 'orders.updated', 'orders.cancelled'],

    // Retention policy
    retention: RetentionPolicy.Limits, // Delete by the limits below (count, size, age); the default
    // RetentionPolicy.Interest - delete once every consumer has acknowledged (at once if there are no consumers)
    // RetentionPolicy.Workqueue - delete once acknowledged; its handlers need deliver_policy: DeliverPolicy.All
    //   (the library default is New), and the filters of its consumers must not overlap

    // Storage type
    storage: StorageType.File, // Persistent storage on disk
    // StorageType.Memory - memory storage (faster, but won't survive restart)

    // Storage limits
    max_msgs: 1_000_000, // Maximum messages
    max_bytes: 1024 * 1024 * 1024, // Maximum 1GB
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds

    // Discard policy when limit is reached
    discard: DiscardPolicy.Old, // Delete old messages
    // DiscardPolicy.New - reject new messages

    // Additional options
    max_msg_size: 1024 * 1024, // Max single message size (1MB)
    num_replicas: 3, // Number of replicas (for cluster)
    duplicate_window: 2 * 60 * 1_000_000_000, // Deduplication window (2 minutes)
  },
]);
```

### Consumer Configurations

A consumer defines HOW to read messages from a stream.

#### Deliver Policies

```typescript
import { DeliverPolicy } from 'nats';

// 1. Only new messages (after consumer creation)
@NatsEventPattern('orders.new', {
  deliver_policy: DeliverPolicy.New,
})

// 2. All messages from stream start
@NatsEventPattern('orders.rebuild', {
  deliver_policy: DeliverPolicy.All,
})

// 3. From the last message in the stream
@NatsEventPattern('orders.latest', {
  deliver_policy: DeliverPolicy.Last,
})

// 4. From specific timestamp
@NatsEventPattern('orders.since-timestamp', {
  deliver_policy: DeliverPolicy.StartTime,
  opt_start_time: new Date('2024-01-01').toISOString(),
})

// 5. From specific sequence
@NatsEventPattern('orders.since-seq', {
  deliver_policy: DeliverPolicy.StartSequence,
  opt_start_seq: 1000,
})

// 6. Last message for each filtered subject
@NatsEventPattern('orders.per-subject', {
  deliver_policy: DeliverPolicy.LastPerSubject,
})
```

#### NAK Strategies (Retry Strategies)

Set the strategy with the `NakStrategy` enum:

```typescript
import { NakStrategy } from 'nestjs-nats-transport';

// Regular - fixed delay (using enum)
@NatsEventPattern('orders.process', {
  nak_strategy: NakStrategy.regular,
  nak_delay: 5000, // Always wait 5 seconds before retry
})

// Increment - incremental delay (linear backoff)
@NatsEventPattern('orders.process', {
  nak_strategy: NakStrategy.increment,
  nak_delay: 1000,     // Base delay: 1 second
  nak_delay_max: 60000, // Maximum 60 seconds
})
// Delays based on deliveryCount: 1s → 2s → 3s → 4s → ... → 60s (max)

// Fibonacci - exponential backoff using Fibonacci sequence
@NatsEventPattern('orders.process', {
  nak_strategy: NakStrategy.fibonacci,
  nak_delay: 1000,     // Base delay: 1 second
  nak_delay_max: 60000, // Maximum 60 seconds
})
// Delays: 1s → 1s → 2s → 3s → 5s → 8s → 13s → 21s → 34s → 55s → 60s (max)
```

#### Acknowledgment Management

```typescript
@NatsEventPattern('orders.process', {
  // Wait time for ack before redelivery
  ack_wait: 30_000_000_000, // 30 seconds (in nanoseconds)

  // Maximum delivery attempts; then NATS stops delivering the message and publishes an advisory
  max_deliver: 5,

  // Maximum unacknowledged messages for this consumer
  max_ack_pending: 100,
})
async handleOrder(@Payload() data: OrderData) {
  // Explicit acknowledgment management:

  if (data.invalid) {
    return TERM; // Terminal error - don't retry
  }

  if (data.tempError) {
    return NAK; // Retry later with delay
  }

  // Success - automatic ack()
}
```

#### Concurrent Processing

```typescript
@NatsEventPattern('orders.heavy', {
  max_handlers: 10, // Process up to 10 messages concurrently
})
async heavyProcessing(@Payload() data: OrderData) {
  // Long operation...
  // SimpleMutex controls that no more than 10 handlers work simultaneously
}
```

Messages wait for a free handler in a client buffer of `max_messages` messages (default: `max_handlers`). NATS starts the `ack_wait` timer when it delivers a message to the buffer, so a message may wait about `max_messages / max_handlers` × the handler duration before its handler starts. Keep that below `ack_wait`, otherwise NATS redelivers the waiting messages and they are processed more than once. A larger `max_messages` speeds up handlers that are faster than a network round trip; a handler that may run longer than `ack_wait` needs a larger `ack_wait`.

### Durable Consumers

Durable consumers preserve their state (position in stream) even after application restart. The library creates a durable consumer for each JetStream handler and names it by the [naming convention](#naming-convention).

```typescript
@NatsEventPattern('orders.process', {
  deliver_policy: DeliverPolicy.All,
})
async processOrder(@Payload() data: OrderData) {
  // On application restart, processing continues from where it stopped
}
```

**Important**:

- On every start the library updates the existing consumer with the handler options, except `deliver_policy`, `opt_start_seq` and `opt_start_time`: they apply to a new consumer only. An option removed from the decorator keeps its value on the server. Falsy values (`0`, `false`, empty string) in numeric and boolean options such as `max_deliver`, `max_ack_pending` and `mem_storage` are not sent either: set them to a positive value or delete and recreate the consumer. The exception is `headers_only`, which accepts `false` explicitly
- To apply such a change, or one that NATS refuses for an existing consumer (for example, a switch to `filter_subjects`, which makes `listen()` reject), delete the consumer and restart the service: the library creates the consumer anew when it starts
- If a consumer disappears while the service runs (it is deleted, or it is kept in memory with `mem_storage: true` and the NATS server restarts), the handler logs `Consumer [<subject>] failed` once a second and resumes when the consumer exists again, for example after the service restarts

### Naming Convention

The library automatically generates consumer names using the format:

```
{consumerName}:{sanitized-channel}~{hash}
```

Where:

- `consumerName` - from server configuration
- `sanitized-channel` - channel name with `.`, `*`, `>` and whitespace replaced by hyphens
- `hash` - the first 8 hex digits of the SHA-256 of the channel name: channels that differ only by these characters and hyphens, such as `orders.created.v1` and `orders.created-v1`, get different consumers

Example:

```typescript
// Configuration
consumerName: 'order-service'

// Decorator
@NatsEventPattern('orders.created')

// Final consumer name: 'order-service:orders-created~18d455b7'
```

### Stream Management

#### Checking Stream Existence

```typescript
const jsm = await natsConnection.jetstreamManager();

try {
  const streamInfo = await jsm.streams.info('ORDERS');
  console.log('Stream exists:', streamInfo.config.name);
} catch (error) {
  console.log('Stream does not exist');
}
```

#### Deleting a Stream

```typescript
await jsm.streams.delete('ORDERS');
```

#### Listing All Streams

```typescript
for await (const stream of jsm.streams.list()) {
  console.log('Stream:', stream.config.name);
}
```

## Error Handling

### Request Validation

The library provides `RequestValidationPipe`, a NestJS `ValidationPipe` for request validation with class-validator. Install `class-validator` and `class-transformer`: without them NestJS stops the process when the pipe is created.

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ServerNats, RequestValidationPipe } from 'nestjs-nats-transport';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    strategy: new ServerNats({
      consumerName: 'user-service',
      connection: { servers: ['nats://localhost:4222'] },
    }),
  });

  // Apply validation pipe globally
  app.useGlobalPipes(RequestValidationPipe());

  await app.listen();
}
```

When validation fails, `NatsRpcException` is thrown with detailed error information:

```typescript
// DTO with validation rules
import { IsEmail, IsString, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(3)
  name: string;
}

// Handler
@NatsMessagePattern('user.create')
async createUser(@Payload() data: CreateUserDto) {
  // data is already validated
  return this.userService.create(data);
}
```

The error the client receives (`ClientNats.request()` throws it as a `NatsRpcException`):

```json
{
  "message": "Validation error",
  "errorCode": "VALIDATION_ERROR",
  "statusCode": 400,
  "errors": {
    "email": ["email must be an email"],
    "name": ["name must be longer than or equal to 3 characters"]
  }
}
```

The pipe supports nested object validation - errors for nested properties are returned in a hierarchical structure.

---

### NatsRpcException

Standardized error format for RPC communication:

```typescript
import { NatsRpcException } from 'nestjs-nats-transport';
import { HttpStatus } from '@nestjs/common';

// Simple error
throw new NatsRpcException('User not found');

// Detailed error
throw new NatsRpcException({
  message: 'Validation failed',
  statusCode: HttpStatus.BAD_REQUEST,
  errorCode: 'VALIDATION_ERROR',
  errors: {
    email: 'Invalid email format',
    age: 'Must be at least 18',
  },
});

// Creating from another error
try {
  await someOperation();
} catch (error) {
  throw new NatsRpcException({
    message: 'Operation failed',
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    errorCode: 'OPERATION_ERROR',
    errors: { cause: error.message },
  });
}
```

### Automatic Error Handling

The library automatically applies `NatsRpcExceptionInterceptor` to all handlers:

```typescript
@Controller()
export class UserController {
  @NatsMessagePattern('user.get')
  async getUser(@Payload() data: { id: string }) {
    // Any error is automatically wrapped in RpcException
    const user = await this.userService.findById(data.id);

    if (!user) {
      // This automatically becomes a proper RPC error response
      throw new NatsRpcException({
        message: 'User not found',
        statusCode: HttpStatus.NOT_FOUND,
        errorCode: 'USER_NOT_FOUND',
      });
    }

    return user;
  }
}
```

The interceptor sends the caller the message of any error, including an unexpected one such as a database error, and takes `statusCode` from the error's `statusCode` or `status` field. Services exchange these errors inside a trusted network; a gateway that passes them on to end users should hide the messages of 5xx errors.

If a request payload cannot be deserialized (for example, it is not valid JSON or is empty), the handler is not called: the service logs the error and replies with `{ message: 'Bad Request: Bad JSON', statusCode: 400 }`, which `ClientNats.request()` throws as a `NatsRpcException`.

If a response cannot be sent (for example, it exceeds the server's `max_payload` or cannot be serialized to JSON, such as a `BigInt` or a circular structure), the service logs the error and replies with `statusCode: 500` and the reason in `message`, for example `'Internal Server Error: MAX_PAYLOAD_EXCEEDED'` or `'Internal Server Error: Bad JSON'`.

Other failures of the request processing that the interceptor does not turn into a reply, such as a processing start hook that throws or a handler registered with `server.addHandler()` that rejects, get the same reply with `statusCode: 500`: only a payload that cannot be deserialized gets `400`.

### Client-Side Error Handling

```typescript
@Injectable()
export class UserService {
  constructor(@Inject('ClientNats') private client: ClientNats) {}

  async getUser(id: string) {
    try {
      const user = await this.client.request<User>('user.get', { id });

      return user;
    } catch (error) {
      // error is a NatsRpcException
      console.error('Error code:', error.errorCode);
      console.error('Status:', error.statusCode);
      console.error('Message:', error.message);
      console.error('Details:', error.errors);

      // Handle or re-throw
      if (error.statusCode === HttpStatus.NOT_FOUND) {
        return null; // User not found is acceptable
      }

      throw error; // Re-throw other errors
    }
  }
}
```

### Custom Exception Filter

For global error handling:

```typescript
import { Catch, RpcExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { RpcException } from '@nestjs/microservices';

@Catch(RpcException)
export class CustomRpcExceptionFilter implements RpcExceptionFilter {
  catch(exception: RpcException, host: ArgumentsHost): Observable<any> {
    const error = exception.getError();

    // Log to monitoring system
    this.logger.error('RPC Exception:', error);

    // Send to Sentry/other tracker
    this.sentryService.captureException(error);

    return throwError(() => exception);
  }
}

// Apply in main.ts
app.useGlobalFilters(new CustomRpcExceptionFilter());
```

### Error Handling in Event Handlers

For events (no response), errors don't return to the client but control NAK/ACK:

```typescript
@NatsEventPattern('orders.process', {
  nak_strategy: NakStrategy.increment,
  max_deliver: 5,
})
async processOrder(@Payload() data: OrderData) {
  try {
    await this.orderService.process(data);
    // Success - automatic ack()
  } catch (error) {
    if (error.code === 'PERMANENT_ERROR') {
      // Don't retry
      return TERM;
    }

    // Log error
    this.logger.error('Order processing failed:', error)

    // Retry with delay
    return NAK;
  }
}
```

A failure that reaches `ServerNats` as a rejected promise instead of an error result is handled the same way as a handler error: a handler registered with `server.addHandler()` that rejects, or an exception filter that throws instead of returning `throwError()`. The JetStream message is NAKed and delivered again, a NATS event is logged with `Processing failed [<subject>]`. Only a message that cannot be deserialized is terminated.

## Working with Headers

### Sending Headers from Client

```typescript
@Injectable()
export class OrderService {
  constructor(@Inject('ClientNats') private client: ClientNats) {}

  async createOrder(orderData: CreateOrderDto, userId: string) {
    const headers = {
      'user-id': userId,
      'request-id': crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      'client-version': '1.0.0',
    };

    // RPC with headers
    const result = await this.client.request('orders.create', orderData, headers);

    // Event with headers
    await this.client.event('order.created', { orderId: result.id }, headers);

    return result;
  }
}
```

### Reading Headers on Server

```typescript
import { Controller, HttpStatus } from '@nestjs/common';
import { Payload, Ctx } from '@nestjs/microservices';
import { NatsContext, NatsEventPattern, NatsMessagePattern, NatsRpcException } from 'nestjs-nats-transport';

@Controller()
export class OrderController {
  @NatsMessagePattern('orders.create')
  async createOrder(@Payload() data: CreateOrderDto, @Ctx() ctx: NatsContext) {
    // Get all headers
    const headers = ctx.getHeaders();

    // Read individual headers
    const userId = headers?.get('user-id');
    const requestId = headers?.get('request-id');

    // Check header presence
    if (!userId) {
      throw new NatsRpcException({
        message: 'User ID header is required',
        statusCode: HttpStatus.BAD_REQUEST,
      });
    }

    // Use in business logic
    const order = await this.orderService.create(data, userId);

    return order;
  }

  @NatsEventPattern('user.action')
  async handleAction(@Payload() data: any, @Ctx() ctx: NatsContext) {
    const headers = ctx.getHeaders();

    // Iterate over all headers
    if (headers) {
      for (const [key, value] of headers) {
        console.log(`${key}: ${value}`);
      }
    }
  }
}
```

### Returning Headers in Response

```typescript
import { Payload, Ctx, NatsRecord } from '@nestjs/microservices';

@Controller()
export class OrderController {
  @NatsMessagePattern('orders.get')
  async getOrder(@Payload() data: { orderId: string }, @Ctx() ctx: NatsContext) {
    const order = await this.orderService.findById(data.orderId);

    // Return data with headers
    return new NatsRecord(order, {
      'cache-control': 'max-age=3600',
      'last-modified': order.updatedAt.toISOString(),
      etag: order.version.toString(),
    });
  }

  @NatsMessagePattern('orders.process')
  async processOrder(@Payload() data: ProcessOrderDto, @Ctx() ctx: NatsContext) {
    const startTime = Date.now();

    const result = await this.orderService.process(data);

    const processingTime = Date.now() - startTime;

    // Add processing metadata
    return new NatsRecord(result, {
      'processing-time-ms': processingTime.toString(),
      'server-id': process.env.SERVER_ID || 'unknown',
      'processed-at': new Date().toISOString(),
    });
  }
}
```

`ClientNats.request()` returns the reply body only: the reply headers are available to callers that read the NATS reply directly, for example with `request()` of the nats.js connection.

### Propagating Headers Between Services

```typescript
import { Payload, Ctx } from '@nestjs/microservices';

@Controller()
export class OrderController {
  constructor(@Inject('ClientNats') private client: ClientNats) {}

  @NatsMessagePattern('orders.create')
  async createOrder(@Payload() data: CreateOrderDto, @Ctx() ctx: NatsContext) {
    // Get headers from client
    const incomingHeaders = ctx.getHeaders();

    // Propagate context to another service
    const userId = incomingHeaders?.get('user-id');
    const requestId = incomingHeaders?.get('request-id');

    // Check user existence
    const user = await this.client.request(
      'user.validate',
      { userId },
      {
        'request-id': requestId, // Propagate request-id for tracing
        'origin-service': 'order-service',
      },
    );

    if (!user.valid) {
      throw new NatsRpcException({
        message: 'Invalid user',
        statusCode: HttpStatus.FORBIDDEN,
      });
    }

    // Create order
    const order = await this.orderRepository.create(data);

    // Send event with context
    await this.client.event(
      'order.created',
      { orderId: order.id },
      {
        'user-id': userId,
        'request-id': requestId,
        'correlation-id': order.id,
      },
    );

    return order;
  }
}
```

### Header Type Safety

For convenience, you can create types for headers:

```typescript
// headers.types.ts
export interface RequestHeaders {
  'user-id': string;
  'request-id': string;
  'correlation-id'?: string;
  timestamp: string;
}

export interface ResponseHeaders {
  'processing-time-ms': string;
  'server-id': string;
  'cache-control'?: string;
}

// typed.controller.ts
@Controller()
export class TypedController {
  async makeRequest() {
    const headers: RequestHeaders = {
      'user-id': '123',
      'request-id': crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    return this.client.request('service.method', { data: 'value' }, headers);
  }

  @NatsMessagePattern('service.method')
  async handleRequest(@Payload() data: any, @Ctx() ctx: NatsContext) {
    const headers = ctx.getHeaders();
    const userId = headers?.get('user-id') as string;

    // Typed response
    const responseHeaders: ResponseHeaders = {
      'processing-time-ms': '150',
      'server-id': 'service-01',
    };

    return new NatsRecord({ result: 'success' }, responseHeaders);
  }
}
```

## Advanced Scenarios

### Hybrid Application (REST + NATS)

Combining HTTP API and NATS microservices:

```typescript
// main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions } from '@nestjs/microservices';
import { ServerNats } from 'nestjs-nats-transport';

async function bootstrap() {
  // Create main HTTP application
  const app = await NestFactory.create(AppModule);

  // Add NATS microservice
  app.connectMicroservice<MicroserviceOptions>({
    strategy: new ServerNats(
      {
        consumerName: 'api-gateway',
        connection: { servers: ['nats://localhost:4222'] },
        jetStream: true,
      },
      [{ name: 'ORDERS', subjects: ['orders.created'] }],
    ),
  });

  // Start both servers
  await app.startAllMicroservices();
  await app.listen(3000);

  console.log('HTTP API listening on :3000');
  console.log('NATS microservice connected');
}

bootstrap();
```

Controller with both protocols:

```typescript
import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { Payload } from '@nestjs/microservices';
import { NatsMessagePattern, NatsEventPattern } from 'nestjs-nats-transport';

@Controller('orders')
export class OrderController {
  // HTTP endpoint
  @Get(':id')
  async getOrderHttp(@Param('id') id: string) {
    return this.orderService.findById(id);
  }

  // NATS RPC handler (same functionality)
  @NatsMessagePattern('orders.get')
  async getOrderNats(@Payload() data: { id: string }) {
    return this.orderService.findById(data.id);
  }

  // HTTP endpoint for creation
  @Post()
  async createOrderHttp(@Body() dto: CreateOrderDto) {
    const order = await this.orderService.create(dto);

    // Publish event to NATS
    await this.natsClient.event('orders.created', { orderId: order.id });

    return order;
  }

  // NATS event handler for processing created orders
  @NatsEventPattern('orders.created')
  async handleOrderCreated(@Payload() data: { orderId: string }) {
    await this.analyticsService.trackOrder(data.orderId);
  }
}
```

### Multiple NATS Connections

Connecting to multiple NATS clusters:

```typescript
// app.module.ts
@Module({
  imports: [
    // Main cluster
    ClientNatsModule.register(
      {
        connection: { servers: ['nats://main-cluster:4222'] },
        jetStream: true,
      },
      'MainNatsClient',
    ),

    // Analytics cluster
    ClientNatsModule.register(
      {
        connection: { servers: ['nats://analytics-cluster:4222'] },
        jetStream: true,
      },
      'AnalyticsNatsClient',
    ),

    // Regional cluster
    ClientNatsModule.register(
      {
        connection: { servers: ['nats://eu-cluster:4222'] },
        jetStream: false, // Without JetStream
      },
      'EuNatsClient',
    ),
  ],
})
export class AppModule {}

// service.ts
@Injectable()
export class MultiClusterService {
  constructor(
    @Inject('MainNatsClient') private mainClient: ClientNats,
    @Inject('AnalyticsNatsClient') private analyticsClient: ClientNats,
    @Inject('EuNatsClient') private euClient: ClientNats,
  ) {}

  async processOrder(order: Order) {
    // Main processing in main cluster
    const result = await this.mainClient.request('orders.process', order);

    // Analytics in separate cluster
    await this.analyticsClient.event('analytics.order', {
      orderId: result.id,
      timestamp: Date.now(),
    });

    // Notification to regional cluster
    if (order.region === 'EU') {
      await this.euClient.event('orders.notification', { orderId: result.id });
    }

    return result;
  }
}
```

### Circuit Breaker Pattern

Protection against downstream service overload:

```typescript
import { Injectable } from '@nestjs/common';
import CircuitBreaker from 'opossum'; // with "esModuleInterop": true

@Injectable()
export class ResilientNatsService {
  private breaker: CircuitBreaker;

  constructor(@Inject('ClientNats') private client: ClientNats) {
    // Configure circuit breaker
    this.breaker = new CircuitBreaker(
      async (pattern: string, data: any) => {
        return this.client.request(pattern, data);
      },
      {
        timeout: 5000, // Request timeout
        errorThresholdPercentage: 50, // 50% errors open circuit
        resetTimeout: 30000, // Try recovery after 30 seconds
        volumeThreshold: 10, // Minimum requests for calculation
      },
    );

    // Event handlers
    this.breaker.on('open', () => {
      console.log('Circuit breaker opened - too many failures');
    });

    this.breaker.on('halfOpen', () => {
      console.log('Circuit breaker half-open - testing recovery');
    });

    this.breaker.on('close', () => {
      console.log('Circuit breaker closed - service recovered');
    });
  }

  async safeRequest<T>(pattern: string, data: any): Promise<T> {
    try {
      return await this.breaker.fire(pattern, data);
    } catch (error) {
      if (this.breaker.opened) {
        // Circuit is open - return fallback
        return this.getFallbackResponse<T>(pattern);
      }
      throw error;
    }
  }

  private getFallbackResponse<T>(pattern: string): T {
    // Fallback logic for different patterns
    console.log(`Fallback response for ${pattern}`);
    return {} as T;
  }
}
```

### Request-Reply with Timeout

Timeout management for critical requests:

```typescript
@Injectable()
export class TimeoutService {
  constructor(@Inject('ClientNats') private client: ClientNats) {}

  async quickRequest(pattern: string, data: any) {
    // Quick timeout for critical requests
    return Promise.race([
      this.client.request(pattern, data),
      this.timeout(1000), // 1 second
    ]);
  }

  async retryRequest<T>(pattern: string, data: any, retries = 3): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.client.request<T>(pattern, data);
      } catch (error) {
        if (i === retries - 1) throw error;

        // Exponential backoff
        await this.delay(Math.pow(2, i) * 1000);
      }
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Saga Pattern with JetStream

Distributed transaction through events:

```typescript
// order-saga.controller.ts
import { Payload } from '@nestjs/microservices';

@Controller()
export class OrderSagaController {
  @NatsEventPattern('saga.order.start')
  async startOrderSaga(@Payload() data: { orderId: string }) {
    try {
      // Step 1: Reserve inventory
      await this.client.request('inventory.reserve', {
        orderId: data.orderId,
      });

      await this.client.event('saga.order.inventory-reserved', {
        orderId: data.orderId,
      });

      // Step 2: Charge payment
      await this.client.request('payment.charge', {
        orderId: data.orderId,
      });

      await this.client.event('saga.order.payment-charged', {
        orderId: data.orderId,
      });

      // Step 3: Create delivery
      await this.client.request('delivery.create', {
        orderId: data.orderId,
      });

      // Success!
      await this.client.event('saga.order.completed', {
        orderId: data.orderId,
      });
    } catch (error) {
      // Rollback (compensating transactions)
      await this.client.event('saga.order.failed', {
        orderId: data.orderId,
        error: error.message,
      });
    }
  }

  @NatsEventPattern('saga.order.failed')
  async compensate(@Payload() data: { orderId: string }) {
    // Compensating transactions in reverse order
    await this.client.event('delivery.cancel', data);
    await this.client.event('payment.refund', data);
    await this.client.event('inventory.release', data);
  }
}
```

### Monitoring and Metrics

Prometheus integration:

```typescript
import { Injectable } from '@nestjs/common';
import { Counter, Histogram, register } from 'prom-client';

@Injectable()
export class MetricsService {
  private requestCounter: Counter;
  private requestDuration: Histogram;

  constructor() {
    this.requestCounter = new Counter({
      name: 'nats_requests_total',
      help: 'Total number of NATS requests',
      labelNames: ['pattern', 'status'],
    });

    this.requestDuration = new Histogram({
      name: 'nats_request_duration_seconds',
      help: 'Duration of NATS requests',
      labelNames: ['pattern'],
      buckets: [0.1, 0.5, 1, 2, 5],
    });

    register.registerMetric(this.requestCounter);
    register.registerMetric(this.requestDuration);
  }

  async trackedRequest<T>(client: ClientNats, pattern: string, data: any): Promise<T> {
    const timer = this.requestDuration.startTimer({ pattern });

    try {
      const result = await client.request<T>(pattern, data);
      this.requestCounter.inc({ pattern, status: 'success' });
      return result;
    } catch (error) {
      this.requestCounter.inc({ pattern, status: 'error' });
      throw error;
    } finally {
      timer();
    }
  }
}

// Usage
@Injectable()
export class OrderService {
  constructor(
    @Inject('ClientNats') private client: ClientNats,
    private metrics: MetricsService,
  ) {}

  async createOrder(data: CreateOrderDto) {
    return this.metrics.trackedRequest(this.client, 'orders.create', data);
  }
}
```

### Distributed Tracing

OpenTelemetry integration:

```typescript
import { trace, context, propagation, SpanStatusCode } from '@opentelemetry/api';
import { Controller } from '@nestjs/common';

@Controller()
export class TracingController {
  private tracer = trace.getTracer('nats-transport');

  async tracedRequest<T>(client: ClientNats, pattern: string, data: any): Promise<T> {
    const span = this.tracer.startSpan('nats.request', {
      attributes: {
        'messaging.system': 'nats',
        'messaging.destination': pattern,
        'messaging.protocol': 'nats',
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        // Extract trace context
        const spanContext = span.spanContext();
        const headers = {
          traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
        };

        const result = await client.request<T>(pattern, data, headers);

        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  @NatsMessagePattern('orders.process')
  async handleRequest(@Payload() data: any, @Ctx() ctx: NatsContext) {
    // Extract trace context from headers
    const headers = ctx.getHeaders();
    const parent = propagation.extract(context.active(), { traceparent: headers?.get('traceparent') });

    // Create child span
    const span = this.tracer.startSpan(
      'handle.orders.process',
      {
        attributes: {
          'messaging.operation': 'receive',
          'messaging.destination': ctx.getSubject(),
        },
      },
      parent,
    );

    try {
      return await this.orderService.process(data);
    } finally {
      span.end();
    }
  }
}
```

## API Reference

### Utilities

#### toMs

Converts time values to milliseconds. Useful for configuring timeouts, delays, and JetStream options.

```typescript
import { toMs } from 'nestjs-nats-transport';

toMs(5, 's'); // 5000 (5 seconds)
toMs(2, 'm'); // 120000 (2 minutes)
toMs(1, 'h'); // 3600000 (1 hour)
toMs(1, 'd'); // 86400000 (1 day)
toMs(1, 'w'); // 604800000 (1 week)
toMs(500, 'ms'); // 500 (milliseconds)
```

**Supported units:**

- `ns` - nanoseconds
- `ms` - milliseconds
- `s` - seconds
- `m` - minutes
- `h` - hours
- `d` - days
- `w` - weeks
- `y` - years

**Usage examples:**

```typescript
// JetStream event handler configuration
@NatsEventPattern('orders.process', {
  nak_delay: toMs(5, 's'),        // 5 seconds
  nak_delay_max: toMs(1, 'm'),    // 1 minute
})

// Timeout configuration
const TIMEOUT = toMs(30, 's'); // 30 seconds
```

#### toNs

Converts time values to nanoseconds. Useful for JetStream configuration options like `ack_wait`, `inactive_threshold`, `max_age`, etc.

```typescript
import { toNs } from 'nestjs-nats-transport';

toNs(5, 's'); // 5_000_000_000 (5 seconds)
toNs(30, 'm'); // 1_800_000_000_000 (30 minutes)
toNs(1, 'h'); // 3_600_000_000_000 (1 hour)
toNs(7, 'd'); // 604_800_000_000_000 (7 days)
toNs(100, 'ms'); // 100_000_000 (100 milliseconds)
```

**Supported units:** same as `toMs` (`ns`, `ms`, `s`, `m`, `h`, `d`, `w`, `y`)

**Usage examples:**

```typescript
// JetStream consumer configuration
@NatsEventPattern('orders.process', {
  ack_wait: toNs(30, 's'),           // 30 seconds to acknowledge
  inactive_threshold: toNs(1, 'h'),  // 1 hour inactivity threshold
})

// Stream configuration
const serverNats = new ServerNats(options, [
  {
    name: 'ORDERS',
    subjects: ['orders.*'],
    max_age: toNs(7, 'd'),              // Keep messages for 7 days
    duplicate_window: toNs(2, 'm'),     // 2 minutes deduplication window
  },
]);
```

#### bytes

Converts size values to bytes.

```typescript
import { bytes } from 'nestjs-nats-transport';

bytes(1, 'kb'); // 1024
bytes(5, 'mb'); // 5242880
bytes(1, 'gb'); // 1073741824
```

**Supported units:** `b`, `kb`, `mb`, `gb`

---

### ServerNats

Server-side transport strategy for NATS.

#### Constructor

```typescript
constructor(options: NatsServerConnectionOptions, streams?: Partial<StreamConfig>[]);
```

`streams` - JetStream streams that `listen()` creates or updates before it subscribes the handlers (with `jetStream: true`).

#### Options

```typescript
interface NatsServerConnectionOptions {
  consumerName: string; // Consumer name (required)
  connection: ConnectionOptions; // NATS connection options
  jetStream?: boolean; // Enable JetStream
  jetStreamOptions?: JetStreamOptions; // JetStream client options
  globalEventOptions?: Partial<NatsEventHandlerOptions>; // Global event settings
  serializer?: Serializer; // Custom serializer
  deserializer?: Deserializer; // Custom deserializer
}
```

#### Methods

- `listen(callback: (err?: unknown) => void): Promise<void>` - Start server; the callback gets the error if the server cannot start or `close()` comes first, except an authorization error, which is retried every 5 seconds
- `close(): Promise<void>` - Stop taking messages, wait up to `GRACE_PERIOD` (10 s) for the handlers in progress to reply or ack, then drain the connection (close it at once while NATS is unreachable)
- `unwrap<T>(): T` - Get the native NATS connection (`app.unwrap()` in NestJS 11+); throws before `listen()`, while `ServerNats` connects anew after the connection was closed for good, and after `close()`
- `status: Observable<string>` - Connection status: `connected`, `disconnected`, `reconnecting` (`app.status` in NestJS 11+)
- `on(event: string, callback: Function): void` - Listen to `disconnect`, `reconnect` and `update` (`app.on()` in NestJS 11+)
- `setOnProcessingStartHook(hook)`, `setOnProcessingEndHook(hook)` - Processing hooks for tracing tools

---

### ClientNats

Client proxy for sending messages.

#### Constructor

```typescript
constructor(options: NatsClientConnectionOptions);
```

#### Options

```typescript
interface NatsClientConnectionOptions {
  connection: ConnectionOptions; // NATS connection options
  jetStream?: boolean; // Publish events to JetStream: event() waits for the stream's ack
  serializer?: Serializer; // Custom serializer
  deserializer?: Deserializer; // Custom deserializer
  requestTimeout?: number; // How long request() waits for a reply, in milliseconds (default 30000)
}
```

#### Methods

- `request<TResult, TInput>(pattern: string | string[], data: TInput, headers?: Record<string, any>): Promise<TResult>` - RPC request; header values other than strings are sent as JSON
- `event<TInput>(pattern: string | string[], data: TInput, headers?: Record<string, any>): Promise<void>` - Send event; with `jetStream: true` it resolves once a stream stores the message, but the `PubAck` details (`seq`, `duplicate`) are not returned — use `getJetStreamClient().publish()` when you need them
- `getClient(): NatsConnection | undefined` - Get native NATS client; `undefined` until the client connects (first request or event, or `await client.connect()`)
- `getJetStreamClient(): JetStreamClient | undefined` - Get JetStream client; `undefined` until the client connects or without `jetStream: true`
- `unwrap<T>(): T` - Get the native NATS connection; throws before `connect()`
- `status: Observable<string>` - Connection status: `connected`, `disconnected`, `reconnecting`
- `on(event: string, callback: Function): void` - Listen to `disconnect`, `reconnect` and `update`
- `close(): Promise<void>` - Drain and close the connection: published messages are flushed, requests that still wait for a reply fail with `TIMEOUT`; a `close()` called again while the first one runs waits for the same close

---

### Decorators

#### @NatsMessagePattern

Decorator for RPC handlers (request-response).

```typescript
@NatsMessagePattern(pattern: string | string[], extras?: any);
```

**Parameters:**

- `pattern` - Subject or array of subject parts
- `extras` - Additional metadata (optional);

**Example:**

```typescript
@NatsMessagePattern('user.get')
async getUser(@Payload() data: { id: string }, @Ctx() ctx: NatsContext) {
  return { id: data.id, name: 'John' };
}
```

#### @NatsEventPattern

Decorator for event handlers (fire-and-forget).

```typescript
@NatsEventPattern(
  pattern: string | string[],
  options?: NatsEventHandlerOptions
);
```

**Parameters:**

- `pattern` - Subject or array of subject parts
- `options` - JetStream consumer options

**Example:**

```typescript
@NatsEventPattern('user.created', {
  deliver_policy: DeliverPolicy.New,
  max_handlers: 5,
})
async handleUserCreated(@Payload() data: { userId: string }, @Ctx() ctx: NatsContext) {
  console.log('User created:', data.userId);
}
```

---

### NatsEventHandlerOptions

JetStream consumer configuration.

```typescript
interface NatsEventHandlerOptions extends ConsumerUpdateConfig {
  deliver_policy?: DeliverPolicy; // Delivery policy (default: New)
  opt_start_seq?: number; // Sequence to start from with DeliverPolicy.StartSequence (new consumer only)
  opt_start_time?: string; // ISO date to start from with DeliverPolicy.StartTime (new consumer only)
  max_messages?: number; // Client buffer size (default: max_handlers)
  nak_delay?: number; // NAK delay in ms (default: 1000)
  nak_delay_max?: number; // Max NAK delay in ms (default: 60000)
  nak_strategy?: NakStrategy; // NakStrategy.regular (default) | NakStrategy.increment | NakStrategy.fibonacci
  max_handlers?: number; // Parallel handlers (default: 1)

  // ConsumerUpdateConfig fields:
  description?: string; // Description
  ack_wait?: number; // Ack timeout in nanoseconds
  max_deliver?: number; // Max delivery attempts
  filter_subject?: string; // Subject filter
  filter_subjects?: string[]; // Several subject filters instead of filter_subject
  sample_freq?: string; // Sampling frequency
  max_ack_pending?: number; // Max unacknowledged messages
  max_waiting?: number; // Max waiting pulls
  headers_only?: boolean; // Headers only
  max_batch?: number; // Max batch size
  max_expires?: number; // Max expires for pull
  inactive_threshold?: number; // Inactivity threshold
  num_replicas?: number; // Number of replicas
  mem_storage?: boolean; // Memory storage
  // ... other fields from NATS ConsumerUpdateConfig
}
```

---

### NatsContext

Handler execution context.

#### Methods

- `getMessage(): JsMsg | Msg` - Get native NATS message object
- `getSubject(): string` - Get message subject
- `getHeaders(): MsgHdrs | undefined` - Get message headers

**Example:**

```typescript
@NatsMessagePattern('order.get')
async getOrder(@Payload() data: any, @Ctx() ctx: NatsContext) {
  const message = ctx.getMessage();       // Native NATS message
  const subject = ctx.getSubject();        // 'order.get'
  const headers = ctx.getHeaders()        // MsgHdrs object or undefined
  const userId = headers?.get('user-id')   // 'user-123'

  return { subject, userId };
}
```

---

### NatsRpcException

Standardized error for RPC.

#### Constructor

```typescript
constructor(error: string | Error | RpcException | Partial<NatsRpcExceptionInterface>);
```

#### Interface

```typescript
interface NatsRpcExceptionInterface {
  message: string;
  errorCode?: string;
  statusCode?: HttpStatus;
  errors?: any;
}
```

**Example:**

```typescript
throw new NatsRpcException({
  message: 'User not found',
  statusCode: HttpStatus.NOT_FOUND,
  errorCode: 'USER_NOT_FOUND',
  errors: { userId: '123' },
});
```

---

### Constants and Enums

#### Symbols

- `NAK` - Symbol for returning NAK from event handler
- `TERM` - Symbol for returning TERM from event handler

#### Constants

- `DEFAULT_NAK_DELAY` - 1000 (ms);
- `DEFAULT_MAX_NAK_DELAY` - 60000 (ms);
- `GRACE_PERIOD` - 10000 (ms): the longest `ServerNats.close()` waits for the handlers in progress

#### NakStrategy Enum

Type-safe enum for specifying retry strategies:

- `NakStrategy.regular` - Fixed delay between retries
- `NakStrategy.increment` - Linear backoff (1s, 2s, 3s, 4s...)
- `NakStrategy.fibonacci` - Fibonacci sequence backoff (1s, 1s, 2s, 3s, 5s, 8s...)

**Example:**

```typescript
import { NAK, TERM, NakStrategy } from 'nestjs-nats-transport';

@NatsEventPattern('order.process', {
  nak_strategy: NakStrategy.increment, // Type-safe enum usage
  nak_delay: 1000,
  max_deliver: 5,
})
async processOrder(@Payload() data: OrderData) {
  if (data.invalid) {
    return TERM; // Don't retry
  }

  if (data.tempError) {
    return NAK; // Retry with delay
  }

  // Success - automatic ack
}
```

---

### ClientNatsModule

Module for registering NATS client.

#### Static Methods

```typescript
static register(
  options: NatsClientConnectionOptions,
  clientName?: string,
): DynamicModule
```

**Parameters:**

- `options` - Client configuration
- `clientName` - Name for DI (default: 'ClientNats');

**Example:**

```typescript
@Module({
  imports: [
    ClientNatsModule.register(
      {
        connection: { servers: ['nats://localhost:4222'] },
        jetStream: true,
      },
      'MyNatsClient',
    ),
  ],
})
export class AppModule {}
```

## Development

### Requirements

- Node.js 18.18+ (20.19+ or 22.12+ to test with NestJS 12)
- Docker: the integration tests run NATS servers in containers

### Installing Dependencies

```bash
yarn install
```

### Commands

```bash
# Build project
yarn build

# Unit tests
yarn test

# Integration tests: start the NATS servers, run the scenarios, stop the servers
yarn test:e2e:infra:up
yarn test:e2e
yarn test:e2e:infra:down

# Compatibility with NestJS 10, 11 and 12, and the contents of the package
yarn test:compat
```

The tests are described in `test/README.md`.

### Local Development with NATS

Running NATS Server with JetStream via Docker:

```bash
# Run NATS with JetStream
docker run -p 4222:4222 -p 8222:8222 \
  nats:latest \
  -js \
  -m 8222

# Or via docker-compose
version: '3'
services:
  nats:
    image: nats:latest
    ports:
      - "4222:4222"  # Client connections
      - "8222:8222"  # HTTP monitoring
      - "6222:6222"  # Cluster connections
    command: "-js -m 8222"
```

NATS Monitoring:

```bash
# Server info
curl http://localhost:8222/varz

# JetStream info
curl http://localhost:8222/jsz

# List streams
nats stream list

# Stream info
nats stream info ORDERS

# List consumers
nats consumer list ORDERS
```

### Testing

Integration test example:

```typescript
// test/integration/nats.spec.ts
import { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ClientNats, ServerNats, ClientNatsModule } from 'nestjs-nats-transport';

describe('NATS Integration', () => {
  let client: ClientNats;
  let app: INestMicroservice;

  beforeAll(async () => {
    // Create test microservice
    const module = await Test.createTestingModule({
      controllers: [TestController],
      imports: [
        ClientNatsModule.register({
          connection: { servers: ['nats://localhost:4222'] },
        }),
      ],
    }).compile();

    app = module.createNestMicroservice({
      strategy: new ServerNats({
        consumerName: 'test-service',
        connection: { servers: ['nats://localhost:4222'] },
      }),
    });

    await app.listen();
    client = module.get('ClientNats');
  });

  afterAll(async () => {
    await app.close();
    await client.close();
  });

  it('should handle RPC request', async () => {
    const result = await client.request('test.echo', { message: 'hello' });

    expect(result).toEqual({ message: 'hello' });
  });

  it('should handle event', async () => {
    await expect(client.event('test.notify', { data: 'test' })).resolves.toBeUndefined();
  });
});
```

## License

MIT

## Author

Iaroslav Vorobev

## Links

- [GitHub](https://github.com/iovpro/nestjs-nats-transport)
- [npm](https://www.npmjs.com/package/nestjs-nats-transport)
- [NATS Documentation](https://docs.nats.io/)
- [NestJS Microservices](https://docs.nestjs.com/microservices/basics)
- [JetStream Guide](https://docs.nats.io/nats-concepts/jetstream)

## Support

If you found a bug or want to suggest an improvement:

- [Create an issue](https://github.com/iovpro/nestjs-nats-transport/issues)
- [Pull requests are welcome](https://github.com/iovpro/nestjs-nats-transport/pulls)

---

**Note**: This library is not an official part of NestJS or NATS. It represents an independent implementation of the transport layer with extended capabilities.
