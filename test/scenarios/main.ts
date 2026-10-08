// Runs one scenario in a dedicated process: node test/.build/test/scenarios/main.js <scenario-id>
// Exit codes: 0 - scenario finished, 1 - the service crashed (uncaught error), 3 - the scenario itself failed.
import 'reflect-metadata';
import { scenarios as client } from './client.scenarios';
import { scenarios as connection } from './connection.scenarios';
import { scenarios as jetstream } from './jetstream.scenarios';
import { scenarios as logging } from './logging.scenarios';
import { scenarios as hooks } from './hooks.scenarios';
import { scenarios as rpc } from './rpc.scenarios';

const registry: Record<string, () => Promise<void>> = {
  ...rpc,
  ...client,
  ...jetstream,
  ...connection,
  ...logging,
  ...hooks,
};

process.on('exit', code => console.log(`@@EXIT ${code}`));

const id = process.argv[2];
const scenario = registry[id];

if (!scenario) {
  console.error(`Unknown scenario "${id}". Available: ${Object.keys(registry).join(', ')}`);
  process.exit(2);
}

scenario().then(
  () => process.exit(0),
  error => {
    console.log(`@@SCENARIO_FAILED ${error instanceof Error ? error.message : String(error)}`);
    console.error(error);
    process.exit(3);
  },
);
