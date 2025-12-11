import { BaseRpcContext } from '@nestjs/microservices/ctx-host';
import { JsMsg, Msg, MsgHdrs } from 'nats';

type NatsContextArgs = [JsMsg | Msg];

/**
 * @publicApi
 */
export class NatsContext extends BaseRpcContext<NatsContextArgs> {
  constructor(args: NatsContextArgs) {
    super(args);
  }

  /**
   * Returns the native NATS message object.
   */
  getMessage(): JsMsg | Msg {
    return this.args[0];
  }

  /**
   * Returns the name of the subject.
   */
  getSubject() {
    return this.args[0].subject;
  }

  /**
   * Returns message headers (if exist).
   */
  getHeaders(): MsgHdrs | undefined {
    return this.args[0].headers;
  }
}
