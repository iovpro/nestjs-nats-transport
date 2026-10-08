import { Socket } from 'net';

export function isReachable(url: string, timeoutMs = 1000): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise(resolve => {
    const socket = new Socket();
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(port), hostname, () => done(true));
  });
}

export async function waitUntilReachable(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await isReachable(url))) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return true;
}
