import { BaseRpcContext } from '@nestjs/microservices/ctx-host';

type NatsContextArgs = [string, any];

/**
 * @publicApi
 */
export class NatsContext extends BaseRpcContext<NatsContextArgs> {
  constructor(args: NatsContextArgs) {
    super(args);
  }

  /**
   * Returns the name of the subject.
   */
  getSubject() {
    return this.args[0];
  }

  /**
   * Returns message headers (if exist).
   */
  getHeaders() {
    return this.args[1];
  }
}
