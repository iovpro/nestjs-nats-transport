import { Module, DynamicModule } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { ClientNats } from '../client';
import { NatsClientConnectionOptions } from '../interfaces';

@Module({})
export class ClientNatsModule {
  public static register(config: NatsClientConnectionOptions, clientName?: string): DynamicModule {
    return {
      module: ClientNatsModule,
      imports: [
        ClientsModule.register({
          clients: [
            {
              name: clientName || 'ClientNats',
              customClass: ClientNats,
              options: config,
            },
          ],
          isGlobal: true,
        }),
      ],
    };
  }
}
