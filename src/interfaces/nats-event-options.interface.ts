import { ConsumerConfig, ConsumerUpdateConfig, DeliverPolicy } from 'nats';

export enum NakStrategy {
  increment = 'increment',
  regular = 'regular',
  fibonacci = 'fibonacci',
}

export interface NatsEventHandlerOptions
  extends ConsumerUpdateConfig, Pick<ConsumerConfig, 'opt_start_seq' | 'opt_start_time'> {
  /*** Default: New */
  deliver_policy?: DeliverPolicy;
  /*** Default: max_handlers */
  max_messages?: number;
  /*** Default: 1000 (1s) */
  nak_delay?: number;
  /*** Default: 60000 (1m) */
  nak_delay_max?: number;
  /*** Default: regular */
  nak_strategy?: NakStrategy;
  /*** Default: 1 */
  max_handlers?: number;
}
