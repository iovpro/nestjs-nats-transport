import { ConsumerUpdateConfig, DeliverPolicy } from 'nats';

export enum NakStrategy {
  increment = 'increment',
  regular = 'regular',
}

export interface NatsEventHandlerOptions extends ConsumerUpdateConfig {
  /*** Default: New */
  deliver_policy?: DeliverPolicy;
  /*** Default: 100 */
  max_messages?: number;
  /*** Default: 1000 (1s) */
  nak_delay?: number;
  /*** Default: 60000 (1m) */
  nak_delay_max?: number;
  /*** Default: regular */
  nak_strategy?: NakStrategy;
  /*** Default: 1 */
  max_handlers?: number;
  /**  Use batch consumer (only for JetStream)
   ** Default: false */
  batch?: boolean;
  /** Actual only for batch = true.
   **  Default: 1000 (1s) */
  batch_expires?: number;
}
