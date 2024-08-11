import { ConsumerUpdateConfig } from 'nats';

export enum NakStrategy {
  increment = 'increment',
  regular = 'regular',
}

export interface NatsEventOptions extends ConsumerUpdateConfig {
  max_messages?: number;
  nak_delay?: number;
  nak_delay_max?: number;
  nak_strategy?: NakStrategy;
}
