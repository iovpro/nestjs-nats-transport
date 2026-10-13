# nestjs-nats-transport tests

## Running

```bash
yarn install

yarn test                    # unit tests, no infrastructure needed (~5 s)

yarn test:e2e:infra:up       # 4 NATS containers (requires Docker)
yarn test:e2e                # integration scenarios (~100 s)
yarn test:compat             # compatibility with NestJS 10/11/12, npm refusal for 9 and 13 (requires internet, ~3 min;
                             # the runtime check runs only when the infrastructure is up)
yarn test:e2e:nest 12.1.2    # the whole e2e suite with another NestJS version (requires internet and infrastructure, ~3 min)
yarn test:e2e:infra:down
```

## How it works

| Part          | Location                             | How it works                                                                                                                                                                       |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | `src/**/*.spec.ts`, `jest.config.js` | Pure functions and internal helpers of `ServerNats` and `ClientNats`, without NATS                                                                                                 |
| E2E           | `test/e2e/*.e2e-spec.ts`             | Each scenario from `test/scenarios/*.scenarios.ts` runs **in a separate Node process**: a crashed process or a blocked event loop in a scenario must not take Jest down            |
| E2E setup     | `test/setup/global-setup.ts`         | Checks that all NATS servers are reachable, starts a stopped `nats-outage`, compiles the scenarios into `test/.build`                                                              |
| Compatibility | `test/compat/check-nest-compat.sh`   | Installs NestJS 9.4.3 / 10.4.15 / 11.2.7 / 12.1.2 in temporary projects and checks the types, loading, runtime, package installation, its `.d.ts` and contents                     |
| Compatibility | `test/compat/e2e-with-nest.sh`       | The whole e2e suite with another NestJS version: a copy of the project in a temporary directory with the required `@nestjs/*` version                                              |
| CI            | `.github/workflows/ci.yml`           | On push to `master` and on pull requests: `yarn build`, `yarn test`, `yarn test:e2e` on the `test/docker-compose.yml` stand; in parallel, `yarn test:e2e:nest 11.2.7` and `12.1.2` |

A scenario prints service lines that the spec parses:

- `@@RESULT {json}` — measurement results;
- `@@TICK`, `@@OUTAGE`, `@@NATS_BACK` — time markers in the connection loss scenarios;
- `@@SCENARIO_FAILED` — an error of the scenario itself (not of the library).

Exit code of a scenario process: `0` — the scenario finished, `1` — the service crashed (uncaught exception), `3` — the scenario failed. A process killed on timeout counts as hung. The specs compare the outcome with `{ exitCode: 0, hung: false, crash: null }`, so on a failure the Jest report shows the cause, for example `crash: "NatsError: Bad JSON"`.

Debugging a single scenario (after `yarn test:e2e` or `npx tsc -p test/tsconfig.scenarios.json`):

```bash
node test/.build/test/scenarios/main.js rpc-01-malformed-payload
```

## Infrastructure (`test/docker-compose.yml`)

| Container                    | Image          | Address                                | Purpose                                                                               |
| ---------------------------- | -------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `nats-transport-test-main`   | `nats:2.15.0`  | `127.0.0.1:14222`, monitoring `:18222` | Main server; strict JetStream API (the default since NATS 2.12)                       |
| `nats-transport-test-legacy` | `nats:2.10.29` | `127.0.0.1:14225`, monitoring `:18225` | Server without the strict mode (JS-04)                                                |
| `nats-transport-test-outage` | `nats:2.15.0`  | `127.0.0.1:14223`                      | The connection loss scenarios stop and start this container (`docker stop/start`)     |
| `nats-transport-test-auth`   | `nats:2.15.0`  | `127.0.0.1:14224`                      | Username/password (`nats-auth.conf`); `restricted` may not pull, JetStream is enabled |

The addresses can be overridden with the `NATS_E2E_*` variables (see `test/scenarios/env.ts`). Scenarios `CON-01/02/08–11/13` use the Docker CLI.

The users of the server with authentication are defined in `test/nats-auth.conf`: `e2e`/`secret` (CON-03 connects with a wrong password) and `restricted`/`secret`. The `restricted` user may not subscribe to `_INBOX.*`: a JetStream pull consumer receives messages on such an inbox, so every pull is rejected while the connection stays open (CON-05, CON-07). JetStream API replies arrive at `_INBOX.<id>.<token>`, so the stream and the consumer are created.

## Summary

| ID        | What it checks                                                                    |
| --------- | --------------------------------------------------------------------------------- |
| UT-01     | `toMs` for ms/s/m/h/d/w                                                           |
| UT-02     | `toMs` for nanoseconds                                                            |
| UT-03     | `toNs` for all units                                                              |
| UT-04     | `bytes`                                                                           |
| UT-05…08  | Building `NatsRpcException` from a string, an object, an RpcException, `status`   |
| UT-09     | `status: 'error'` of the standard Nest packet does not become `statusCode`        |
| UT-10…12  | NAK strategies: regular, increment, fibonacci                                     |
| UT-13     | Different subjects → different consumer names                                     |
| UT-14     | Library options from `globalEventOptions` do not reach NATS                       |
| UT-16     | The consumer stops on a closed connection                                         |
| UT-17     | After a failure the consumer restarts in exactly 1 s                              |
| UT-18     | No restart after `close()` during the pause                                       |
| UT-19     | `CONNECTION_DRAINING` stops the consumer without an error                         |
| UT-21     | Reconnect 5 s after the connection is closed for good                             |
| UT-22     | Failed attempts are retried every 5 s, the extra connection is closed             |
| UT-23     | `close()` during the pause cancels the scheduled reconnect                        |
| UT-24     | A connection opened by an attempt after `close()` is closed                       |
| UT-25     | A consumer waiting on a closed connection stops                                   |
| UT-26     | `ServerNats`: `maxReconnectAttempts` defaults to `-1`                             |
| UT-27     | `ClientNats` opens a new connection instead of a closed one                       |
| UT-28     | `ClientNats`: `maxReconnectAttempts` defaults to `-1`                             |
| UT-29     | `consume()` buffers `max_handlers` messages when `max_messages` is not set        |
| UT-30     | `consume()` buffers `max_messages` messages when it is set                        |
| UT-32     | `ServerNats.unwrap()`: the connection, an error before `listen()` and in a pause  |
| UT-33     | `ServerNats.on()`: connection events reach the listeners until `close()`          |
| UT-34     | `ClientNats.unwrap()`: the current connection, an error before `connect()`        |
| UT-35     | `ServerNats.status`: `connected` after `listen()`, then follows NATS              |
| UT-36     | `ClientNats`: `status` and `on()` until `close()`                                 |
| UT-37     | The handler runs inside the processing hooks (3 paths)                            |
| UT-38     | The end hook is called on a handler error too (3 paths)                           |
| UT-39     | Consumer name: the subject and 8 hex characters of its SHA-256                    |
| UT-40     | A new consumer is created under the hashed name                                   |
| UT-41     | A consumer lookup error other than "not found" rejects `listen()`                 |
| UT-42     | Global NAK options apply, the decorator overrides them                            |
| UT-43     | Core NATS and JetStream events: `0`, `false`, `''` arrive as is                   |
| UT-44     | `request()` waits `requestTimeout` (30 s), `connection.timeout` has no effect     |
| UT-45     | After a failed connection the next call connects anew                             |
| UT-46     | `close()`: subscriptions drained, the in-flight request answered before `drain()` |
| UT-47     | `close()` waits for an in-flight handler for at most 10 s                         |
| UT-48     | `close()` stops the JetStream consumers without a restart                         |
| UT-49     | `close()`: ack before `drain()`, a message waiting for a handler is not taken     |
| UT-50     | Several handlers of one JetStream pattern reject `listen()`                       |
| UT-51     | A second handler on an RPC pattern rejects `start()`, with and without JetStream  |
| UT-52     | Object patterns are compared the way NestJS normalizes them                       |
| UT-53     | `listen()` passes `jetStreamOptions` to the JetStream client, as to the manager   |
| UT-54     | A decorator option set to `undefined` or `null` keeps the global value            |
| UT-55     | A start hook that fails before `done`: a handler error (3 paths)                  |
| UT-56     | A start hook that fails after `done` is only logged (3 paths)                     |
| UT-57     | RPC: `400` only for a request that cannot be deserialized, otherwise `500`        |
| UT-58     | `ServerNats.status` during the recovery, also after a failed setup                |
| UT-59     | `close()` while `listen()` connects: `listen()` fails                             |
| UT-60     | `listen()` after `close()` connects anew and binds the handlers again             |
| UT-61     | Connection closed during the setup of an attempt: one attempt, one error line     |
| UT-62     | `close()` while `listen()` waits to retry the credentials fails `listen()`        |
| UT-63     | An attempt ending after `close()` and a new `listen()` leaves the new one alone   |
| UT-64     | A consumer bound before `close()` does not restart after a new `listen()`         |
| UT-65     | `close()` during the pause does not drain the connection that nats.js closed      |
| UT-66     | A message waiting for a handler at `close()` is not handled after `listen()`      |
| UT-67     | `close()` stops the reconnects that go on after an authorization retry            |
| UT-68     | `close()` calls `close()` on the connection when `drain()` does not close it      |
| UT-69     | `ClientNats.close()` calls `close()` when `drain()` does not close the connection |
| UT-70     | Empty `filter_subjects` creates a consumer with `filter_subject`                  |
| UT-71     | `close()` drains the core subscriptions and survives a dead one                   |
| UT-72     | `ServerNats`: status updates go on past `pingTimer` without `connection`          |
| UT-74     | `ServerNats.propagatesEventHandlerErrors` is `true`                               |
| UT-75     | `ClientNats`: status updates go on past `pingTimer` without `connection`          |
| UT-77     | A listener of `on()` that throws or rejects is logged, the others are called      |
| UT-79     | `listen()` after a `close()` that came first fails without connecting             |
| UT-80     | `listen()` again after a failed `listen()` first closes what the failed one runs  |
| UT-81     | `listen()` during `close()` waits for it and keeps its own connection             |
| UT-82     | An error thrown by the `listen()` callback completes `listen()` with that error   |
| UT-83     | `close()` called again while it runs waits for the same close                     |
| UT-84     | `close()` while NATS is unreachable: unsubscribe and close, no drain              |
| UT-85     | `close()` stops waiting for the drains once nats.js closes the connection         |
| UT-86     | `close()` waits for the subscriptions to drain for at most 10 s                   |
| UT-87     | `close()` does not keep the subscriptions of a connection closed before           |
| UT-88     | `close()` waits for a message that is still being deserialized (3 paths)          |
| UT-89     | `close()` during the JetStream setup: no subscriptions, no consumer loops         |
| UT-90     | `listen()` after `close()` during the reconnect pause still reconnects            |
| UT-91     | `close()` after a new `listen()` does not wait for a handler given up before      |
| UT-92     | A start hook that fails and calls `done` afterwards does not run the handler      |
| UT-93     | A rejection reason that is not an `Error` is logged                               |
| UT-94     | A handler that rejects fails the message as a handler error (3 paths)             |
| UT-95     | An end hook that throws is logged, the message is processed                       |
| UT-96     | The consume loop hands its event options to each message                          |
| UT-97     | `ClientNats.close()` does not drain a connection that nats.js has closed          |
| UT-98     | `ClientNats.close()` stops waiting for a drain once nats.js closes the connection |
| UT-99     | `ClientNats.close()` called again while it runs waits for the same close          |
| UT-100    | A permissions violation is logged with the operation and the subject              |
| UT-101    | A failed drain is logged and the connection is closed anyway                      |
| UT-102    | `RequestContext` run/get stores and restores context across await and nesting     |
| UT-103    | A second copy of the module sees the same `AsyncLocalStorage` via `Symbol.for`    |
| UT-104    | `runOutsideRequestContext` exits context and restores it after                    |
| UT-105    | Context headers on all four client paths: `request`, `event`, `send`, `emit`      |
| UT-106    | Explicit `X-Trace-Id`/`X-Request-Id` in another case win over the context         |
| UT-107    | `NatsRecord` of the caller is not mutated; different context per send             |
| UT-108    | No `x-trace-id` without the option, a context or a traceId; `x-request-id` if set |
| UT-109    | Connection opens outside request context                                          |
| UT-110    | Handler sees context from headers (case-insensitive) on all three server paths    |
| UT-111    | traceId generated when header missing: custom and default                         |
| UT-112    | No context when `requestContext` option is off                                    |
| UT-113    | Error log for bad JSON is inside context on all three paths                       |
| UT-114    | Processing hooks see context                                                      |
| UT-115    | Concurrent JetStream messages do not mix contexts                                 |
| UT-116    | `NatsContext.getTraceId()`/`getRequestId()`: context, header, empty, missing      |
| UT-117    | `@RequestId()`: RPC with header, RPC without, HTTP with context, HTTP without     |
| UT-118    | Malformed headers fail the message as without the option on all three paths       |
| RPC-01    | A non-JSON request does not crash the service                                     |
| RPC-02    | An empty request does not crash the service                                       |
| RPC-03    | A response larger than `max_payload` does not crash the service                   |
| RPC-04    | A response with a `BigInt` does not crash the service                             |
| RPC-05    | `0`, `false`, `''` reach the handler as is                                        |
| RPC-06a   | A business error `NatsRpcException` reaches the caller                            |
| RPC-06c   | A plain `@MessagePattern` masks the error                                         |
| RPC-07    | `statusCode` of a standard Nest error is a number or absent                       |
| RPC-08    | `connection.timeout` does not limit the RPC duration                              |
| RPC-09    | On shutdown the reply to an in-flight request is delivered                        |
| RPC-10    | Headers travel both ways                                                          |
| RPC-11    | A second handler on an RPC pattern fails `listen()`, with and without JetStream   |
| CLI-01    | Concurrent first requests share one connection                                    |
| JS-01     | A JetStream event reaches the handler                                             |
| JS-02     | A non-JSON JetStream message is terminated without a crash                        |
| JS-03     | `globalEventOptions` from the README work on NATS ≥ 2.12                          |
| JS-04     | The global `max_handlers` applies                                                 |
| JS-05     | A missing stream is reported by `listen()`, not by a crash                        |
| JS-06     | `filter_subjects` works                                                           |
| JS-07     | The README example with `StartSequence` works                                     |
| JS-08     | Subjects that differ in `.` and `-` get different consumers                       |
| JS-09     | Messages from the client buffer are not redelivered                               |
| JS-11     | A NAK from the handler leads to a redelivery                                      |
| JS-12     | `consume()` buffer: `max_handlers` by default, otherwise `max_messages`           |
| JS-13     | A message in progress at `app.close()` is acknowledged                            |
| JS-14     | Several handlers of one JetStream pattern fail `listen()`                         |
| CON-01    | The event loop stays alive after the connection is lost for good                  |
| CON-02    | The service recovers after the connection is lost for good                        |
| CON-03    | Reconnect attempts stop after `app.close()`                                       |
| CON-05    | Regular consumer: pulls are rejected, restarts with a pause                       |
| CON-07    | A consumer in the pause does not restart after `app.close()`                      |
| CON-08    | No reconnect after `app.close()` during the recovery pause                        |
| CON-09    | By default the connection survives an outage longer than the nats.js budget       |
| CON-10    | `ClientNats` sends requests again after the connection is lost for good           |
| CON-11    | `status` and `on()` of the server and the client: outage and recovery             |
| CON-12    | A deleted consumer causes retries, not a pull storm                               |
| CON-13    | `close()` closes the connection at once while NATS is down                        |
| HOOK-01   | Handlers run inside the processing hooks: RPC, events, JetStream                  |
| CTX-01    | traceId/requestId reach RPC (and a downstream RPC), NATS and JetStream handlers   |
| CTX-02    | Messages without headers get generated traceId and undefined requestId            |
| LOG-01    | The standard Nest logger prints the stack of a handler error                      |
| LOG-02    | The standard Nest logger prints the stack of an internal library error            |
| DOC-01    | The README code examples compile                                                  |
| COMPAT-01 | The sources compile with NestJS 10 / 11 / 12                                      |
| COMPAT-02 | The built package loads with NestJS 10 / 11 / 12                                  |
| COMPAT-03 | RPC and JetStream work with NestJS 10 / 11 / 12                                   |
| COMPAT-04 | npm installs the package with NestJS 10–12 and refuses with 9 and 13              |
| COMPAT-05 | The `.d.ts` pass the type check of a NestJS 10 / 11 / 12 consumer                 |
| COMPAT-06 | The whole e2e suite with NestJS 11 / 12 gives the same results as with NestJS 10  |
| COMPAT-07 | npm does not install the package next to `nats` outside the peer range            |
| COMPAT-08 | The package contains only the build, README, LICENSE and package.json             |

## Test descriptions

### Unit (`src/**/*.spec.ts`)

**UT-01 — `toMs` for ms/s/m/h/d/w** (`src/utils/to-ms.spec.ts`)
Expected: `toMs(5, 's') = 5000`, `toMs(2, 'm') = 120000`, etc.

**UT-02 — `toMs` for nanoseconds**
Expected: `toMs(5_000_000, 'ns') = 5` (1 ms = 10⁶ ns).

**UT-03 — `toNs`**, **UT-04 — `bytes`**
Expected: correct conversion factors.

**UT-05…UT-08 — building `NatsRpcException`** (`src/exceptions/rpc-exception.spec.ts`)
Expected: `message` is taken from a string; `message`, `errorCode`, `statusCode`, `errors` from an object; the nested `error` of a serialized `RpcException` is unwrapped; `status: 404` (as in `HttpException`) becomes `statusCode`.

**UT-09 — `status: 'error'` does not become `statusCode`**
Expected: the standard Nest filter replies with a `{ status: 'error', message }` packet (unexpected errors, guard rejections); `statusCode` must stay `undefined` (or become `500`).

**UT-10…UT-12 — NAK strategies** (`src/server/server-nats.spec.ts`)
Expected: regular — always `nak_delay`; increment — `deliveryCount × nak_delay`, capped at `nak_delay_max`; fibonacci — 1, 1, 2, 3, 5, 8… × `nak_delay` with the same cap.

**UT-13 — unique consumer names**
Expected: `orders.created.v1` and `orders.created-v1` give different names.

**UT-14 — library options do not reach NATS**
Steps: the handler options are built from `globalEventOptions` and an empty decorator, then picked for the consumer, as `bindJetStreamEvents()` does.
Expected: of `globalEventOptions`, only the NATS fields (`max_deliver`) get into the consumer configuration; `nak_delay`, `nak_strategy`, `nak_delay_max`, `max_handlers`, `max_messages` do not.

UT-16…19 run the `runSubscription` loop with a stubbed consumer and fake timers. The loop is cut after 50 `consume()` calls, so that a regression makes the test fail rather than hang.

**UT-16 — stop on a closed connection**
Steps: `consume()` throws `CONNECTION_CLOSED` synchronously, as nats.js does on a closed connection.
Expected: one error line and one call in 10 s.

**UT-17 — restart 1 s after a failure**
Steps: `consume()` rejects with `503 no responders`.
Expected: one call after 999 ms, the second one after 1000 ms.

**UT-18 — no restart after `close()` during the pause**
Steps: after the failure `jetstreamClient` is reset, as `close()` does; 10 s pass.
Expected: one call — after the pause the loop sees that the server is closed.

**UT-19 — `CONNECTION_DRAINING` stops the loop without an error**
Expected: one call, no errors in the log.

UT-21…25 call `listen()` with a stubbed `createClient()` and fake timers. The server has one RPC handler; the fake connection is closed for good by calling `fail()`, as nats.js does when the reconnect attempts run out.

**UT-21 — reconnect 5 s after the connection is closed for good**
Expected: no new connection after 4999 ms, a new one after 5000 ms; the RPC handler is subscribed on the new connection; one error in the log.

**UT-22 — retrying failed attempts**
Steps: the second attempt is rejected with `CONNECTION_REFUSED`, the third one connects but JetStream does not respond, the fourth one succeeds.
Expected: attempts every 5 s, the connection of the third attempt is closed, no new attempts after the success (four connections in 45 s), three error lines.

**UT-23 — `close()` during the pause**
Expected: the reconnect is scheduled, `close()` cancels its timer, no new connections.

**UT-24 — an attempt that connects after `close()`**
Steps: `close()` is called while an attempt is connecting; then the attempt connects.
Expected: the new connection is closed, no handlers are subscribed on it.

**UT-25 — stopping a consumer on a closed connection**
Steps: a regular consumer waits for messages; the connection is closed for good. The nats.js `consume()` iterator does not end by itself after the connection closes.
Expected: the iterator is stopped, the loop exits and does not restart on the closed connection; the only error line is the reconnect.

**UT-26, UT-28 — default `maxReconnectAttempts`** (`ServerNats`, `ClientNats`)
Expected: nats.js `connect()` gets `maxReconnectAttempts: -1` unless `connection` sets its own value; a value that is set is passed unchanged.

**UT-27 — `ClientNats` after the connection is closed for good** (`src/client/client-nats.spec.ts`)
Expected: an open connection is reused, a closed one is replaced with a new one.

UT-29 and UT-30 run the `runSubscription` loop with a stubbed consumer whose `consume()` never completes, and check the call parameters.

**UT-29 — default `consume()` buffer**
Expected: without `max_messages` the buffer equals `max_handlers`: `consume({ max_messages: 1 })` without options, `consume({ max_messages: 5 })` with `max_handlers: 5`.

**UT-30 — explicit `max_messages`**
Expected: `max_messages: 10` with `max_handlers: 5` is passed to `consume()` as is.

UT-32…34 check the abstract methods of NestJS 11+; without them the library sources and `.d.ts` do not compile with NestJS 11 and 12 (COMPAT-01, COMPAT-05).

**UT-32 — `ServerNats.unwrap()`**
Expected: the error "Not initialized…" before `listen()`, the current connection after it, the error while `ServerNats` waits to connect anew (the closed connection is not kept), the new connection after a reconnect, the error again after `close()` — as in the built-in NestJS 11 transport.

**UT-33 — `ServerNats.on()`**
Steps: the stubbed connection emits the statuses `disconnect`, `error`, `pingTimer`, `reconnect`, `update`; then `close()` and one more `disconnect`.
Expected: the listeners get `disconnect`, `reconnect` and `update` with the nats.js data, as in the built-in NestJS 11 transport; `error` is not forwarded, because an `error` event of an `EventEmitter` without a listener throws; no listeners are left after `close()`.

**UT-34 — `ClientNats.unwrap()`** (`src/client/client-nats.spec.ts`)
Expected: the error "Not initialized…" before `connect()`, the current connection after it.

UT-35…38 check the NestJS 11+ transport contract: the connection status, events and processing hooks. The contract works with NestJS 10 too.

**UT-35 — `ServerNats.status`**
Expected: `connected` after `listen()`; the nats.js statuses `disconnect` → `disconnected`, `reconnecting` → `reconnecting`, `reconnect` → `connected`; other statuses do not change the status, repeated values are not emitted.

**UT-36 — `ClientNats`: `status` and `on()`** (`src/client/client-nats.spec.ts`)
Expected: the same for the client: `connected` after `connect()`, the events `disconnect`, `reconnect`, `update`, no listeners after `close()`.

UT-37 and UT-38 run for each of the three processing paths: a core event, a JetStream event, an RPC request. The start hook runs the processing inside `AsyncLocalStorage.run()`, as tracing tools do.

**UT-37 — handler inside the processing hooks**
Steps: as in NestJS, the handler returns a lazy stream; the controller method is async.
Expected: `start` → the handler sees the hook context → `end` after the handler completes; `transportId` is `Transport.NATS` (2).

**UT-38 — end hook on a handler error**
Expected: `start` → `end`; the error is handled as usual.

**UT-39 — consumer name format**
Expected: `orders.created` → `svc:orders-created~18d455b7`: the subject with `.`, `*`, `>` and whitespace replaced by `-`, then `~` and the first 8 hex characters of the SHA-256 of the subject.

UT-40 and UT-41 call `bindJetStreamEvents()` on a stubbed `jetstreamManager` and `jetstreamClient`: the stream has no consumers, `consumers.get` answers "consumer not found" (`err_code` 10014), `runSubscription` is stubbed — the tests check which consumer the subject reads from.

**UT-40 — new consumer**
Expected: `consumers.add` with `name` and `durable_name` `svc:orders-created-v1~9da9e633` and the filter `orders.created-v1`; the subject reads from this consumer.

**UT-41 — consumer lookup error**
Steps: the consumer lookup times out.
Expected: `bindJetStreamEvents()` rejects with this error, no consumer is created.

**UT-42 — global NAK options**
Steps: `globalEventOptions: { nak_delay: 2000, nak_strategy: increment }`; the handler returns `NAK` on the second delivery of a message — without its own options, with `nak_delay: 500` and with `nak_delay: undefined` in the decorator.
Expected: NAK delays of 4000 ms (2 × 2000), 1000 ms (2 × 500: `nak_delay` from the decorator, the global strategy) and 4000 ms (`undefined` keeps the global `nak_delay`).

**UT-43 — falsy values in event handlers**
Steps: `handleNatsEvent` (core NATS) and `handleNatsJetStreamEvent` get the messages `{ pattern: 'orders', data }` with `data` = `0`, `false`, `''`.
Expected: the handler gets `0`, `false`, `''`.

**UT-44 — request timeout** (`src/client/client-nats.spec.ts`)
Steps: `request()` of a client with `connection.timeout: 1000` and of a client with `requestTimeout: 5000`; the nats.js `request()` is stubbed.
Expected: request timeouts of 30,000 and 5,000 ms.

**UT-45 — retry after a failed connection**
Steps: the first connection attempt is rejected, then `connect()` is called again.
Expected: the second call opens a new connection. Concurrent `connect()` calls wait for one shared attempt; the test checks that a failed attempt is not handed to the next calls.

UT-46…49 check the server shutdown: `close()` stops taking messages, waits for the in-flight handlers for at most 10 s (`GRACE_PERIOD`), and only then drains the connection. In UT-46 and UT-47 an RPC request is processed on a stubbed connection, in UT-48 and UT-49 JetStream messages are processed in the `runSubscription` loop with a stubbed consumer.

**UT-46 — in-flight request at `close()`**
Steps: a request is in progress; `close()` is called; then the handler completes.
Expected: the subscription is drained at once, so the messages NATS has routed to it are still delivered; the reply is sent before the connection drains.

**UT-47 — wait limit**
Steps: the request handler never completes.
Expected: `drain()` is not called after 9,999 ms and is called after 10,000 ms.

**UT-48 — JetStream consumers at `close()`**
Steps: a message is in progress; `close()` is called.
Expected: the `consume()` iterator is stopped, the loop does not restart.

**UT-49 — JetStream messages at `close()`**
Steps: `max_handlers: 1`; two messages in the buffer — the first one in progress, the second one waiting for a free handler; `close()` is called, then the first message completes.
Expected: the first message is acknowledged before `drain()`, the second one is not processed — NATS redelivers it.

**UT-50 — several handlers of one JetStream pattern**
Steps: two event handlers are registered on the `orders.created` pattern with the real NestJS `addHandler()`, which chains the second one to the first via `next`; `bindJetStreamEvents()` is called.
Expected: it rejects with `Several handlers for the JetStream pattern [orders.created]: one handler per pattern`, no consumer is created.

UT-51 and UT-52 check the "one handler per RPC pattern" rule in both modes, `jetStream: true` and `false`. The handlers are registered with the real NestJS `addHandler()`, then `start()` is called.

**UT-51 — a second handler on an RPC pattern**
Steps: two handlers are registered on the `orders.get` pattern — an RPC handler and an event handler in both orders, or two RPC handlers.
Expected: before binding the handlers, `start()` passes the error `Several handlers for the RPC pattern [orders.get]: one handler per pattern` to the callback.

**UT-52 — object patterns**
Steps: two RPC handlers are registered with the patterns `{ cmd: 'get', v: 1 }` and `{ v: 1, cmd: 'get' }`. NestJS sorts the keys, so for NestJS both are the pattern `{"cmd":"get","v":1}`.
Expected: `start()` passes the error for the pattern `{"cmd":"get","v":1}` to the callback — the library looks up handlers by the same key as NestJS.

**UT-53 — `jetStreamOptions` of the JetStream client**
Steps: `listen()` of a server with `jetStream: true` and `jetStreamOptions: { domain: 'hub' }` on a stubbed connection.
Expected: `jetstream()` and `jetstreamManager()` get `{ domain: 'hub' }` — the options apply both to creating the consumers and to looking them up and reading from them.

**UT-54 — `undefined` and `null` in the decorator**
Steps: `globalEventOptions: { ack_wait: 120 s, max_deliver: 5, deliver_policy: All, headers_only: true }`; the decorator sets `ack_wait: undefined`, `max_deliver: null` and `deliver_policy: undefined`, as values from a configuration that does not set them, and `headers_only: false`; `bindJetStreamEvents()` runs on the stubbed JetStream API of UT-40.
Expected: the new consumer gets the global `ack_wait`, `max_deliver` and `deliver_policy`, and `headers_only: false` from the decorator.

UT-55 and UT-56 run a JetStream message, an RPC request and a core NATS event through a server whose start hook fails: it throws or returns a rejected promise.

**UT-55 — start hook fails before `done`**
Expected: the handler and the end hook are not called; the JetStream message is NAKed, not terminated, and its handler slot is released; the RPC request gets `{ message: 'Internal Server Error: no traceparent', statusCode: 500 }`; no message is left among the handlers in progress that `close()` waits for; one error line per message.

**UT-56 — start hook fails after `done`**
Expected: the processing goes on as usual: the handler and the end hook are called, the JetStream message is acknowledged and its slot is released once, the RPC request gets the handler's reply; the failure is only logged.

**UT-57 — RPC error reply codes**
Steps: a request that is not JSON, and a valid request to a handler registered with `addHandler()` that rejects with `connect ECONNREFUSED 10.0.0.5:5432`: such a handler runs without the interceptor and the filters that turn errors into replies.
Expected: `Bad Request: Bad JSON` with `400` for the first request, `Internal Server Error: connect ECONNREFUSED 10.0.0.5:5432` with `500` for the second.

**UT-58 — `ServerNats.status` during the recovery**
Steps: as in UT-22: the connection is closed for good, the next attempt connects but JetStream does not respond, the attempt after it succeeds.
Expected: `connected` → `reconnecting` once the connection is closed for good → `connected` when the attempt connects → `reconnecting` when its setup fails → `connected`.

UT-59…65 and UT-67 use the stubbed connections of UT-21…25, UT-66 the consumer of UT-48 and UT-49.

**UT-59 — `close()` while `listen()` connects**
Steps: `close()` is called while `listen()` opens its first connection; then the connection opens.
Expected: `close()` calls the `listen()` callback once with the error `ServerNats was closed before listen() completed`: `app.listen()` rejects, the bootstrap does not go on; the connection is closed, no handlers are subscribed on it; `unwrap()` throws, the closed connection is not kept.

**UT-60 — `listen()` after `close()`**
Steps: `listen()`, `close()` and `listen()` again on the same instance, as after `app.getTransportServer().close()` in NestJS 12.
Expected: `close()` does not call the callback of the first `listen()` again; the new connection stays open, the RPC handler is subscribed on it, the callback is called once without an error, `unwrap()` returns the new connection.

**UT-61 — a connection closed for good during the setup of an attempt**
Steps: the attempt after the first failure connects and waits for the JetStream API; nats.js closes its connection for good and fails the pending request, so both the `closed()` handler and the `listen()` callback report the failure.
Expected: one reconnect is scheduled, not two, and the failure is logged once; 5 s later one new connection, the RPC handler is subscribed on it.

**UT-62 — `close()` while `listen()` waits to retry the credentials**
Steps: NATS rejects the credentials (`AUTHORIZATION_VIOLATION`); `close()` is called during the 5 s pause before the next attempt.
Expected: the `listen()` callback is called once with the error `ServerNats was closed before listen() completed`: `app.listen()` rejects; no attempt after `close()`.

UT-63, UT-64 and UT-66 restart the server with `close()` and `listen()` while something of the first `listen()` is still running.

**UT-63 — an attempt that ends after `close()` and a new `listen()`**
Steps: the connection is closed for good, the reconnect attempt is still connecting when `close()` and `listen()` are called; the new `listen()` connects; then the old attempt connects or fails.
Expected: the old attempt subscribes nothing and schedules no reconnect; the new connection stays open, `unwrap()` returns it.

**UT-64 — a consumer bound before `close()`**
Steps: a pull fails and the consumer waits 1 s to restart; `close()` and `listen()` are called during the pause.
Expected: the consumer is not restarted.

**UT-65 — `close()` while `ServerNats` waits to reconnect**
Steps: the connection is closed for good; `close()` is called during the 5 s pause. As in nats.js, the closed connection cannot be drained (`CONNECTION_CLOSED`).
Expected: `drain()` is not called, no error besides the reconnect line.

**UT-66 — a message waiting for a handler at `close()`**
Steps: as in UT-49, the handler of the first message is in progress and the second message waits; the handler outlasts the 10 s of `close()`; `listen()` is called, then the handler finishes.
Expected: the first message is acknowledged, the second is not handled.

**UT-67 — reconnects after an authorization retry**
Steps: the connection is closed for good; the next attempt is rejected with `AUTHORIZATION_VIOLATION`, the one after it with `CONNECTION_REFUSED`, the next one is still connecting when `close()` is called and fails afterwards.
Expected: no reconnect is scheduled after `close()`: the authorization retry belongs to the same `listen()` as the reconnects.

**UT-68 — `close()` calls `close()` after `drain()`**
Steps: a server with a fake connection where `drain()` resolves but `isClosed()` returns `false` — as nats.js does when the final flush of a drain fails during a network outage with infinite reconnect.
Expected: `drain()` is called first, then `close()`: the connection does not stay open and reconnecting.

**UT-69 — `ClientNats.close()` calls `close()` after `drain()`**
Steps: a client with a fake connection, same conditions as UT-68.
Expected: `drain()` first, then `close()`.

**UT-70 — empty `filter_subjects`**
Steps: a handler with `filter_subjects: []` is bound.
Expected: the consumer is created with `filter_subject: 'orders.created'` — the handler's own subject, not without a filter.

**UT-71 — draining the core subscriptions**
Steps: `close()` of a listening server whose subscription cannot be drained (`SUB_CLOSED`, as after a permissions violation).
Expected: `drain()` is called for the subscription, not `unsubscribe()`; its failure does not fail `close()`.

**UT-72, UT-75 — status updates without the `connection` option** (`ServerNats`, `ClientNats`)
Steps: an instance created from JavaScript without `connection` gets the status `pingTimer`, which is logged only with `connection.debug`.
Expected: the status loop goes on and ends with the feed instead of failing on `connection.debug`.

**UT-74 — `propagatesEventHandlerErrors`**
Expected: `true`: NestJS 12 does not log again the errors of event handlers that `ServerNats` handles itself (NAK for JetStream).

**UT-77 — listeners of `on()` that fail** (`src/connection/nats-connection.spec.ts`)
Steps: three listeners of `disconnect`: the first one throws, the second one rejects (an alert sent over the network that fails in the same outage), the third one records the call; the statuses `disconnect` and `reconnect`.
Expected: both failures are logged as `Status listener for "disconnect" failed` with the stack, the third listener is called, the `reconnect` status is logged: the status loop goes on and the process does not end with an unhandled rejection.

UT-79…91 use the stubbed connections of UT-21…25 and the request and consumer of UT-46…49. They check `listen()` and `close()` called in any order and the shutdown while NATS does not answer.

**UT-79 — `listen()` after a `close()` that came first**
Steps: `close()`, then `listen()` — as when `app.close()` comes while NestJS runs the init hooks of the application, before it calls `listen()`.
Expected: the callback gets `ServerNats was closed before listen() completed`, no connection is opened.

**UT-80 — `listen()` again after a failed `listen()`**
Steps: the first `listen()` connects and fails (JetStream does not respond); a consumer bound before the failure waits for messages; `listen()` is called again without `close()`.
Expected: the consumer of the failed `listen()` is stopped and its connection drained before the new one is opened; the new connection stays open.

**UT-81 — `listen()` while `close()` waits for a handler**
Steps: a request is in progress; `close()` is called and, without waiting for it, `listen()`; then the request completes.
Expected: `listen()` does not connect before `close()` ends; `close()` drains its own connection, not the new one; `unwrap()` returns the new connection.

**UT-82 — an error thrown by the `listen()` callback**
Steps: the callback throws when it is called without an error, as NestJS does when its logger throws on "successfully started".
Expected: the callback is called again with that error: `app.listen()` rejects instead of hanging.

**UT-83 — `close()` called again while it runs**
Steps: a request is in progress; `close()` is called twice; the connection, as in nats.js, refuses a second `drain()` with `CONNECTION_DRAINING`.
Expected: both calls complete, the connection is drained once, no error is logged.

**UT-84 — `close()` while NATS is unreachable**
Steps: the connection reports `disconnect`; `close()` is called.
Expected: the subscription is unsubscribed, not drained; the connection is closed without a drain, which would wait for the next reconnect attempt.

**UT-85 — nats.js closes the connection during `close()`**
Steps: NATS stops answering: the drains of the subscription and of the connection never complete; then nats.js closes the connection for good.
Expected: `close()` completes instead of waiting forever.

**UT-86 — subscription drain limit**
Steps: the drain of the subscription never completes.
Expected: the connection is not drained after 9,999 ms and is drained after 10,000 ms.

**UT-87 — subscriptions of a connection closed before**
Steps: the connection is closed for good, `ServerNats` connects anew, then `close()`.
Expected: `close()` drains the subscription of the new connection only; no subscription is kept after `close()`.

**UT-88 — a message that is deserialized at `close()`**
Steps: for an RPC request, a core event and a JetStream message; the deserializer takes 20 ms; the message arrives, then `close()` is called at once.
Expected: the reply, the handler call or the ack comes before the connection drains.

**UT-89 — `close()` during the JetStream setup**
Steps: an RPC handler and a JetStream handler; `close()` is called while `listen()` waits for the JetStream manager or for the stream of the consumer, and a handler in progress keeps `close()` waiting.
Expected: the setup subscribes no RPC subject and starts no consumer loop.

**UT-90 — `listen()` after `close()` during the reconnect pause**
Steps: the connection is closed for good, `close()` cancels the scheduled reconnect, `listen()` connects; then its connection is closed for good too.
Expected: `ServerNats` connects anew 5 s later and subscribes the handler.

**UT-91 — a handler given up by `close()`**
Steps: the handler of a request never completes; `close()` gives up on it after 10 s; `listen()` and `close()` again.
Expected: the second `close()` completes at once.

UT-92…95 use the three processing paths of UT-37 and UT-38.

**UT-92 — a start hook that fails and calls `done` afterwards**
Steps: the start hook schedules `done` in 10 ms and returns a rejected promise.
Expected: the handler and the end hook are not called; the JetStream message is NAKed once and its handler slot released once; the RPC request gets one reply, the error.

**UT-93 — a rejection reason that is not an `Error`**
Steps: the start hook rejects with the string `tracer not ready`.
Expected: the error line `Processing start hook failed [orders]` carries `'tracer not ready'` in place of the stack.

**UT-94 — a handler that rejects**
Steps: the handler rejects with `db down`, as a handler added with `addHandler()` or a controller method whose exception filter throws.
Expected: the JetStream message is NAKed, not terminated, and its slot released; the RPC request gets `Internal Server Error: db down` with `500`; each path logs `Processing failed [orders]`; nothing is left in processing.

**UT-95 — an end hook that throws**
Steps: the end hook throws; the handler fails or succeeds.
Expected: `Processing end hook failed [orders]` is logged; the message is processed as without the end hook: NAK and `500` for the failure, ack and the reply for the success; nothing is left in processing.

**UT-96 — event options of the consume loop**
Steps: `globalEventOptions: { nak_delay: 2000 }`, the loop runs with `nak_delay: 500`; two messages, the handler returns `NAK`.
Expected: both messages are NAKed with 500 ms; the handler options are not built again for each message.

UT-97…99 run `ClientNats.close()` on a stubbed connection (`src/client/client-nats.spec.ts`).

**UT-97 — a connection that nats.js has closed**
Steps: nats.js has given up reconnecting and no request has come since; `close()`.
Expected: no `drain()`, no error in the log.

**UT-98 — nats.js closes the connection during `close()`**
Steps: the drain never completes; nats.js closes the connection for good.
Expected: `close()` completes.

**UT-99 — `close()` called again while it runs**
Steps: two `close()` calls; the connection refuses a second `drain()`, as nats.js does.
Expected: one `drain()`, no error in the log.

UT-100 and UT-101 check the connection handling shared by `ServerNats` and `ClientNats` (`src/connection/nats-connection.spec.ts`).

**UT-100 — permissions violation**
Steps: the status `error` with the data `PERMISSIONS_VIOLATION` and the `permissionContext` that nats.js adds, then the status `disconnect`.
Expected: `NatsError: type: "error", data: "PERMISSIONS_VIOLATION", permissionContext: {"operation":"subscription","subject":"orders.get"}.`; the `disconnect` line has no context.

**UT-101 — a drain that fails**
Steps: `drain()` rejects with `CONNECTION_DRAINING`.
Expected: the error `Failed to drain the NATS server due to an error, forcibly closing the connection: reason=CONNECTION_DRAINING` is logged and the connection is closed.

UT-102…UT-118 check the request context: `RequestContext` (`src/context/request-context.spec.ts`), the headers of `ClientNats` (`src/client/client-nats.spec.ts`), the context of `ServerNats` (`src/server/server-nats.spec.ts`), `NatsContext` (`src/ctx-host/nats.context.spec.ts`) and `@RequestId()` (`src/decorators/request-id.decorator.spec.ts`).

**UT-102 — run/get**
Steps: `RequestContext.run()` with values, check `get()`/`getTraceId()`/`getRequestId()` before, inside, after `await`, inside nested `run()`, after return.
Expected: values available inside `run`, `undefined` outside, inner `run` does not leak into outer.

**UT-103 — shared storage**
Steps: load a second copy of the module via `jest.isolateModules()`; `run()` from one copy, `get()` from the other.
Expected: both copies share the same `AsyncLocalStorage` via `Symbol.for`.

**UT-104 — runOutsideRequestContext**
Steps: inside `run({ traceId: 'A' })` call `runOutsideRequestContext()`; inside it check `get()` before and after `await`.
Expected: `get()` is `undefined` inside the exit; `'A'` is restored after.

**UT-105 — context headers on all four client paths**
Steps: `request()`, `event()`, `send()`, `emit()` inside `RequestContext.run()` with `requestContext: true`.
Expected: every outgoing message has `x-trace-id` and `x-request-id`.

**UT-106 — explicit header wins (case-insensitive)**
Steps: `request('orders', 1, { 'X-Trace-Id': 'mine', 'X-Request-Id': 'my-r' })` inside a context with other values.
Expected: the message has only the explicit `X-Trace-Id: mine` and `X-Request-Id: my-r`; the lowercase context headers are not added.

**UT-107 — NatsRecord not mutated; different context per send**
Steps: send the same `NatsRecord` twice in contexts `T1` and `T2`.
Expected: each message carries its own traceId; the record's original headers are unmodified.

**UT-108 — context headers that are not sent**
Steps: `requestContext: false` with a context; `requestContext: true` without a context; a context without `traceId` but with `requestId: 'R'`; a context without `requestId`.
Expected: no `x-trace-id` in the first three; the request succeeds; `x-request-id: R` is sent only in the third; no `x-request-id` in the last.

**UT-109 — connection outside context**
Steps: first `request()` inside context `A` opens the connection; a `disconnect` status event fires after.
Expected: the request has `x-trace-id: A`; the `on('disconnect')` listener sees `RequestContext.get() === undefined`.

**UT-110 — handler sees context (server, all three paths)**
Steps: `getEventHandler`, `getRequestHandler`, `runSubscription` with messages carrying `X-Trace-Id` and `X-Request-Id`.
Expected: the handler (async, with `await`) reads the correct `RequestContext.get()`.

**UT-111 — traceId generated when header missing**
Steps: message without `x-trace-id`; with and without custom `generateTraceId`.
Expected: handler sees the generated value; `requestId` is `undefined`.

**UT-112 — no context when option is off**
Steps: `requestContext` not set; message with headers.
Expected: `RequestContext.get()` is `undefined` inside the handler.

**UT-113 — error log inside context**
Steps: message with bad JSON and `x-trace-id: T`; all three paths.
Expected: `RequestContext.getTraceId()` is `'T'` when `logger.error` is called.

**UT-114 — processing hooks see context**
Steps: `setOnProcessingStartHook`; core event with `x-trace-id: HOOK-T`.
Expected: `RequestContext.getTraceId()` is `'HOOK-T'` inside the hook.

**UT-115 — concurrent messages**
Steps: two JetStream messages with `T1` and `T2`, `max_handlers: 2`, handlers with `await`.
Expected: after `await` each handler still sees its own traceId.

**UT-116 — NatsContext.getTraceId()/getRequestId()**
Steps: four cases: context + header, header only (different case), headers exist but field missing, no headers.
Expected: context wins over header; empty string → `undefined`; no headers → `undefined`.

**UT-117 — @RequestId()**
Steps: RPC with NatsContext + header; RPC without `getRequestId`; HTTP inside context; HTTP outside context.
Expected: RPC returns header value or `undefined`; HTTP returns context value or `undefined`.

**UT-118 — malformed headers (server, all three paths)**
Steps: `requestContext: true` with `generateTraceId: () => 'GEN'`; a message whose headers nats.js cannot decode (a key with a space) through `getEventHandler`, `getRequestHandler`, `runSubscription`.
Expected: the handler is not called and the message fails as without the option: `Incorrect event data` for a core event, `Failed to process request [orders]` and a 400 reply for RPC, `Failed to process event data` and `term` for JetStream. The error is logged inside the generated context `GEN`; no unhandled rejection, no consumer restart.

### RPC (`test/e2e/rpc.e2e-spec.ts`, `test/scenarios/rpc.scenarios.ts`)

**RPC-01 — non-JSON request** (`rpc-01-malformed-payload`)
Steps: a service with `@NatsMessagePattern('e2e.rpc.echo')`; a plain NATS client sends the bytes `definitely-not-json` to this subject (like `nats req e2e.rpc.echo definitely-not-json`); then a valid request through `ClientNats`.
Expected: the service stays alive, the sender immediately gets an error reply without internal details — `{"err":{"message":"Bad Request: Bad JSON","statusCode":400},"isDisposed":true}`; the valid request after it is served.

**RPC-02 — empty request** (`rpc-02-empty-payload`)
The same with an empty body.

**RPC-03 — response larger than `max_payload`** (`rpc-03-oversized-response`)
Steps: the handler returns a 2 MB string (the default server limit is 1 MB); a request through `ClientNats`, then the same raw request to check the whole reply packet.
Expected: the service stays alive, the caller immediately gets an error — `{"err":{"message":"Internal Server Error: MAX_PAYLOAD_EXCEEDED","statusCode":500},"isDisposed":true}`.

**RPC-04 — response with a `BigInt`** (`rpc-04-bigint-response`)
Steps: the handler returns `{ id: BigInt(10) }`; the requests are the same as in RPC-03.
Expected: the service stays alive, the caller immediately gets an error — `{"err":{"message":"Internal Server Error: Bad JSON","statusCode":500},"isDisposed":true}`.

**RPC-05 — falsy values** (`rpc-05-falsy-payloads`)
Steps: `client.request('e2e.rpc.echo', v)` for `0, false, '', 42, 'text', {a: 1}`; the handler returns what it gets.
Expected: `[0, false, '', 42, 'text', {a: 1}]`.

**RPC-06 — error propagation** (`rpc-06-error-propagation`, one run for 2 checks)

- RPC-06a: `NatsRpcException({ message: 'User not found', statusCode: 404, errorCode: 'USER_NOT_FOUND' })` reaches the caller unchanged.
- RPC-06c: a handler under a plain `@MessagePattern` throws `Error('connect ECONNREFUSED 10.20.30.40:5432 (db user=billing_rw)')` — the caller gets `Internal server error`.

**RPC-07 — `statusCode` type** (the same run)
Expected: for a standard Nest error `statusCode` is `500` or absent.

**RPC-08 — RPC timeout** (`rpc-08-request-timeout`)
Steps: a client with `connection.timeout: 1000` (the nats.js timeout for establishing a connection); the handler replies after 1.5 s.
Expected: the reply `done` (the default request timeout is 30 s, as documented in the README).

**RPC-09 — in-flight request at shutdown** (`rpc-09-shutdown-inflight`)
Steps: a request to a 1.5 s handler; `app.close()` after 200 ms.
Expected: the reply `done` is delivered (graceful shutdown waits for the handlers, like `gracefulShutdown`/`gracePeriod` in the built-in NestJS 11+ transport).

**RPC-10 — headers** (`rpc-10-headers`)
Steps: `client.request(..., { 'x-request-id': 'req-42' })`; the handler reads the header and returns a `NatsRecord` with the `x-served-by` header.
Expected: the handler sees `req-42`; the reply has the `x-served-by` header. The reply header is checked with a raw request: `ClientNats.request()` returns only the body, reply headers are not available through the client API.

**RPC-11 — a second handler on an RPC pattern** (`rpc-11-shared-rpc-pattern`)
Steps: with `jetStream: true` and `false`, services with two controllers on the subject `e2e.rpc.shared` are started: an RPC handler and an event handler in both orders, and two RPC handlers — six services in total.
Expected: `app.listen()` of every service rejects with `Several handlers for the RPC pattern [e2e.rpc.shared]: one handler per pattern`, the process does not crash.

### Client (`test/e2e/client.e2e-spec.ts`)

**CLI-01 — connection race** (`cli-01-connect-race`)
Steps: a new `ClientNats` without an explicit `connect()`; 20 concurrent `request()` calls; the connections are counted through the server monitoring (`/connz`).
Expected: 1 connection is open; none are left after `client.close()`.

### JetStream (`test/e2e/jetstream.e2e-spec.ts`, `test/scenarios/jetstream.scenarios.ts`)

In all scenarios the library creates the `E2E` stream with the subject `e2e.js.>` (the second argument of the `ServerNats` constructor); the consumer name is `e2e:<subject>~<hash>`.

**JS-01 — basic delivery** (`js-01-smoke`)
`ClientNats({ jetStream: true }).event(...)` → the handler gets `{ hello: 'world' }`.

**JS-02 — poison message** (`js-02-poison-message`)
A non-JSON message and a valid one are published to the stream. Expected: the service stays alive, the valid message is processed, the invalid one is terminated (no pending acks and no redeliveries).

**JS-03 — `globalEventOptions` from the README on NATS ≥ 2.12** (`js-03-global-options-strict-server`)
Steps: `globalEventOptions: { nak_delay: 2000, max_handlers: 5 }`, verbatim from the README section "Global Event Settings"; NATS 2.15 server.
Expected: the service starts and processes events.

**JS-04 — global `max_handlers`** (`js-04-global-runtime-options`, NATS 2.10)
Steps: `globalEventOptions: { max_handlers: 5 }`; two 500 ms handlers — without options and with `max_handlers: 5` in the decorator; 10 messages each.
Expected: both process up to 5 messages in parallel.

**JS-05 — no stream for the subject** (`js-05-no-stream-for-subject`)
Steps: `@NatsEventPattern('e2e.nostream.created')` with `jetStream: true`; there is no stream for the subject.
Expected: `app.listen()` rejects with a clear error, the process does not crash.

**JS-06 — `filter_subjects`** (`js-06-filter-subjects`)
Steps: `@NatsEventPattern('e2e.js.multi', { filter_subjects: ['e2e.js.multi.a', 'e2e.js.multi.b'] })`, one message to each subject.
Expected: both messages are received.

**JS-07 — README example with `StartSequence`** (`js-07-start-sequence`)
Steps: 3 messages in the stream; `{ deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 2 }`.
Expected: messages 2 and 3 are received.

**JS-08 — consumer name collision** (`js-08-consumer-name-collision`)
Steps: handlers on `e2e.js.orders.created.v1` and `e2e.js.orders.created-v1`.
Expected: each handler gets its own messages.

**JS-09 — redeliveries caused by the client buffer** (`js-09-prefetch-redelivery`)
Steps: `max_handlers: 1`, `ack_wait: 2 s`, a 400 ms handler, 20 messages. Redeliveries are counted as `info.deliveryCount - 1`: in nats.js `info.redeliveryCount` is an alias of `deliveryCount` (1 on the first delivery).
Expected: every message is processed once — the handler fits into `ack_wait`.

**JS-11 — NAK from the handler** (`js-11-nak-redelivery`)
Steps: the handler returns `NAK` on the first delivery.
Expected: deliveries `[1, 2]`.

**JS-12 — `consume()` buffer size** (`js-12-prefetch-buffer-size`)
Steps: two 1 s handlers — `max_handlers: 3` without `max_messages`, and `max_handlers: 1, max_messages: 10`; 20 messages to each subject; for 2.5 s, every 100 ms, the test reads `num_ack_pending` of the consumers: the messages delivered but not acknowledged, both in the handlers and in the client buffer.
Expected: at most 6 (3 in the handlers + 3 in the buffer) and 11 (1 + 10).

**JS-13 — message in progress at shutdown** (`js-13-ack-on-close`)
Steps: a 1 s handler; a message is published to the stream; once the handler has started, `app.close()` is called; then `num_ack_pending` and `num_redelivered` of the consumer are read.
Expected: `close()` waits for the handler, the message is acknowledged — `{ handled: 1, ackPending: 0, redelivered: 0 }`.

**JS-14 — several handlers of one JetStream pattern** (`js-14-two-handlers-one-pattern`)
Steps: handlers of two controllers subscribe to `e2e.js.nak.multi`; `app.listen()`.
Expected: `listen()` rejects with `Several handlers for the JetStream pattern [e2e.js.nak.multi]: one handler per pattern`, the process does not crash.

### Connection (`test/e2e/connection.e2e-spec.ts`, `test/scenarios/connection.scenarios.ts`)

In CON-01/02/08/10 the reconnect budget is shortened to `maxReconnectAttempts: 2, reconnectTimeWait: 250` for speed; by default the library does not limit the number of attempts (CON-09).

**CON-01 — event loop after the connection is lost for good** (`con-01-outage-event-loop`)
Steps: a regular consumer; a timer prints `@@TICK` every 250 ms; the NATS container is stopped.
Expected: the process stays responsive (≥ 20 ticks in 6 s after the stop); during the scenario there are at most 10 error lines and at most one with `CONNECTION_CLOSED` (the consumer does not restart on the closed connection).

**CON-02 — recovery after the connection is lost for good** (`con-02-outage-regular-consumer`)
Steps: a regular consumer and an RPC handler; NATS is stopped for 7 s (longer than the reconnect budget and the 5 s recovery pause) and started again; a message is published to the stream, then an RPC request is sent.
Expected: the service recovers by itself — the first attempt after 5 s fails, the next one connects; the message is processed, the RPC handler replies.

**CON-03 — authorization retry after `app.close()`** (`con-03-auth-retry-after-close`)
Steps: a connection to the server with authentication using a wrong password; `app.close()` after 6 s; 11 s of observation.
Expected: no connection attempts after `close()`.

**CON-05 — regular consumer, pulls rejected** (`con-05-pull-denied-regular-consumer`)
Steps: a regular consumer connects as the `restricted` user — the server rejects the inbox subscription of every pull request, the connection stays open.
Expected: the consumer keeps retrying with a pause — 4 to 20 error lines in 6 s (two lines per attempt: the consumer error and the `error` status; 12 with a 1 s pause).

**CON-07 — `app.close()` during the pause** (`con-07-close-during-retry-pause`)
Steps: a regular consumer as the `restricted` user; after 2.5 s, while the loop waits for a retry, `app.close()`; 2 s of observation.
Expected: no new errors after `close()` — the consumer does not restart.

**CON-08 — `app.close()` during the recovery pause** (`con-08-close-during-reconnect-pause`)
Steps: an RPC handler; NATS is stopped, the connection is closed for good, and the service waits 5 s before connecting anew; NATS is started; `app.close()` during this pause; 6 s of observation.
Expected: before `close()` the log has "connected to" and "connection closed, reconnecting"; after it there are no connections and no attempts.

**CON-09 — default `maxReconnectAttempts`** (`con-09-outage-default-reconnect-budget`)
Steps: a regular consumer with `reconnectTimeWait: 100` and without `maxReconnectAttempts` — the default nats.js budget (10 attempts) runs out in less than 2 s; NATS is stopped for 3 s.
Expected: the connection is not closed for good — nats.js reconnects by itself, the message published after NATS returns is processed, the service does not have to restore the connection.

**CON-10 — `ClientNats` after the connection is lost for good** (`con-10-outage-client`)
Steps: `ClientNats` with a budget of 2 attempts × 250 ms; the RPC service reconnects without a limit; NATS is stopped for 3 s.
Expected: after NATS returns, the client requests succeed again.

**CON-11 — status and events during an outage** (`con-11-status-and-events`)
Steps: an RPC service and `ClientNats` on `nats-outage` (`reconnectTimeWait: 250`, unlimited attempts), subscribed to `status` and `on('disconnect' | 'reconnect')`; NATS is stopped for 2 s; then an RPC request is sent.
Expected: the server and the client go through the statuses `connected`, `disconnected`, `reconnecting`, `connected` and get the events `disconnect` and `reconnect` with the server address (a string); the request succeeds.

**CON-12 — a deleted consumer causes retries, not a pull storm** (`con-12-consumer-deleted-storm`)
Steps: a JetStream handler on `nats-main`; after 1 s the consumer is deleted; 3 s of observation; `app.close()`.
Expected: 1–10 error lines in 3 s: the missing consumer is reported once a second (`abort_on_missing_resource: true`) instead of a storm of pull requests that nats.js would send with no error in the log (about 24,000 per second).

**CON-13 — `close()` while NATS is down** (`con-13-close-during-outage`)
Steps: an RPC handler on `nats-outage` with the default `maxReconnectAttempts: -1`; NATS is stopped; after 2 s `app.close()`. The scenario process ends right after the scenario, so the connection itself is checked.
Expected: the connection is closed (otherwise nats.js reconnects forever and keeps the process alive), and `close()` takes less than 1 s: it does not drain while NATS is unreachable, a drain would wait for the next reconnect attempt (2 s by default).

### Processing hooks (`test/e2e/hooks.e2e-spec.ts`, `test/scenarios/hooks.scenarios.ts`)

**HOOK-01 — handlers inside the processing hooks** (`hook-01-processing-hooks`)
Steps: two services — core NATS (an RPC handler and an event handler) and JetStream (an event handler); the start hook opens an `AsyncLocalStorage` context with the message subject, the end hook records the call; the handlers are async (20 ms) and record the context they see.
Expected: for each subject — `start 2`, `handler in <subject>`, `end 2`; the RPC reply is the subject from the hook context.

### Request context (`test/e2e/context.e2e-spec.ts`, `test/scenarios/context.scenarios.ts`)

**CTX-01 — cross-service propagation** (`ctx-01-cross-service-propagation`)
Steps: `ClientNats` with `requestContext: true` sends an RPC request, a NATS event and a JetStream event inside `RequestContext.run({ traceId: 'trace-1', requestId: 'req-1' })`. The RPC handler sends a downstream RPC.
Expected: all handlers (RPC, downstream RPC, NATS event, JetStream event) see `trace-1` and `req-1` via `RequestContext`, `ctx.getTraceId()`, `ctx.getRequestId()`, and `@RequestId()`.

**CTX-02 — message without headers** (`ctx-02-message-without-headers`)
Steps: raw nats.js connection sends RPC and JetStream event without headers. Server uses custom `generateTraceId`.
Expected: handlers see generated traceId via `RequestContext` and `ctx.getTraceId()`; `requestId` is `undefined` everywhere.

### Logging (`test/e2e/logging.e2e-spec.ts`)

**LOG-01 — error stack with the standard logger** (`log-01-default-logger-stack`)
Steps: the standard NestJS `ConsoleLogger`; the handler throws `Error('boom from handler')`.
Expected: the log contains the stack (`at FailingController.fail`).

**LOG-02 — internal error stack with the standard logger** (`log-02-internal-error-stack`)
Steps: the standard NestJS `ConsoleLogger`; a raw request with the body `not-json` makes the library log a deserialization error.
Expected: the text `Failed to process request [e2e.log.fail]` followed by the error stack: `NatsError: Bad JSON` and the `at …` lines.

### Documentation (`test/e2e/docs.e2e-spec.ts`)

**DOC-01 — README examples compile**
Steps: README fragments are collected in `test/fixtures/readme-examples.ts` and checked by the TypeScript compiler (no infrastructure needed).
Expected: 0 errors.

### Compatibility (`test/compat/check-nest-compat.sh`, `test/compat/e2e-with-nest.sh`)

NestJS 10, 11 and 12 are supported: `peerDependencies` is `^10.0.0 || ^11.0.0 || ^12.0.0`. The script installs NestJS 9.4.3, 10.4.15, 11.2.7, 12.1.2 in temporary directories (by default; versions can be passed as arguments): COMPAT-01…05 run for the supported versions, only COMPAT-04 for the others. NestJS 12 is published as ES modules, while the library is built as CommonJS and loads them with `require()`: NestJS 12 needs Node.js 20.19+ or 22.12+ (`ERR_REQUIRE_ESM` on 20.18 and 22.11).

**COMPAT-01 — types.** Expected: the sources compile.

**COMPAT-02 — loading the published build.** Expected: `require()` of the package succeeds.

**COMPAT-03 — runtime** (with the infrastructure up). An RPC request and a JetStream event through the built package.

**COMPAT-04 — installation.** The built library is packed (`npm pack`) and installed with `npm install` next to each NestJS version. Expected: the installation succeeds with NestJS 10, 11 and 12; with NestJS 9 npm refuses (`ERESOLVE`). NestJS 13 is not released yet, so the script checks that the `peerDependencies` ranges of all `@nestjs/*` packages exclude it (`semver` bundled with npm).

**COMPAT-05 — `.d.ts` in a consumer project.** `consumer.ts` imports `ServerNats`, `ClientNats`, `NatsContext` and `NatsEventPattern` from the installed package and is checked by `tsc` with `skipLibCheck: false`; only errors in the library files count (the `.d.ts` of `nats` 2.29 itself give their own errors with TypeScript 5.4). Expected: 0 errors.

**COMPAT-06 — the whole e2e suite with another NestJS version** (`yarn test:e2e:nest <version>`, with the infrastructure up). The script copies the library and the tests to a temporary directory where `@nestjs/*`, `rxjs` and `reflect-metadata` have the given version and the other packages are links to the packages of the repository, and runs the e2e suite. Expected: the same results as with NestJS 10. Unit tests cannot run this way with NestJS 12: Jest on Node < 24.9 does not load ES modules through `require()`.

**COMPAT-07 — `nats` outside the peer range** (in `yarn test:compat`). A project with NestJS from devDependencies and `nats` 2.28.2; `npm install --dry-run` of the packed library. Expected: npm refuses (`ERESOLVE`), so the application and the library share one `nats`: the library does not recognize headers created by another copy of `nats` (`instanceof MsgHdrsImpl`).

**COMPAT-08 — package contents** (in `yarn test:compat`). A copy of the working tree with a fresh build is packed with `npm pack --dry-run`. Expected: the package contains only `dist/` (with `index.js` and `index.d.ts`), `README.md`, `LICENSE` and `package.json`; `.npmignore` excludes the sources, tests and CI.
