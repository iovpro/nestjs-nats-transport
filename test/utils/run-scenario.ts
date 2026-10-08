import { execFileSync, spawn } from 'child_process';
import { join } from 'path';
import { waitUntilReachable } from '../scenarios/net';

const ENTRY = join(__dirname, '..', '.build', 'test', 'scenarios', 'main.js');
const OUTPUT_LIMIT = 1_000_000;

export interface ScenarioRun {
  id: string;
  exitCode: number | null;
  /** The process did not finish in time and was killed */
  hung: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** Merged @@RESULT objects reported by the scenario */
  result: Record<string, any>;
}

export function runScenario(id: string, timeoutMs = 30_000): Promise<ScenarioRun> {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [ENTRY, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout = (stdout + chunk).slice(-OUTPUT_LIMIT)));
    child.stderr.on('data', chunk => (stderr = (stderr + chunk).slice(-OUTPUT_LIMIT)));

    let hung = false;
    const timer = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', exitCode => {
      clearTimeout(timer);
      const result: Record<string, any> = {};
      for (const line of stdout.split('\n')) {
        if (line.startsWith('@@RESULT ')) Object.assign(result, JSON.parse(line.slice('@@RESULT '.length)));
      }
      resolve({ id, exitCode, hung, durationMs: Date.now() - startedAt, stdout, stderr, result });
    });
  });
}

/** Healthy run: the process finished on its own and did not crash */
export const HEALTHY = { exitCode: 0, hung: false, crash: null };

export function processOutcome(run: ScenarioRun) {
  return { exitCode: run.exitCode, hung: run.hung, crash: run.exitCode === 0 ? null : crashReason(run) };
}

export function crashReason(run: ScenarioRun): string | null {
  const failed = run.stdout.match(/^@@SCENARIO_FAILED (.*)$/m);
  if (failed) return `scenario failed: ${failed[1]}`;
  const uncaught = run.stderr.match(/^[A-Za-z]*Error(?: \[\w+\])?: .*$/m);
  if (uncaught) return uncaught[0];
  return run.hung ? 'process hung and was killed' : null;
}

/** Number of @@<name> markers printed after the @@<after> marker */
export function markersAfter(run: ScenarioRun, name: string, after: string): number {
  const lines = run.stdout.split('\n');
  const start = lines.indexOf(`@@${after}`);
  return start < 0 ? 0 : lines.slice(start + 1).filter(line => line.startsWith(`@@${name} `)).length;
}

export async function ensureContainerRunning(container: string, url: string) {
  try {
    execFileSync('docker', ['start', container], { stdio: 'ignore' });
  } catch {
    // the reachability check below reports the problem
  }
  if (!(await waitUntilReachable(url, 15_000))) throw new Error(`${container} is not reachable at ${url}`);
}
