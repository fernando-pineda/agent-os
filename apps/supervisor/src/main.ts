import { readGlobalConfig } from './onboarding.js';
import { createRegistry, reconcileOnBoot } from './registry.js';
import { startServer } from './server.js';
import { StatusTrackerImpl } from './status.js';

async function main(): Promise<void> {
  const registry = createRegistry();
  await reconcileOnBoot(registry);
  const statusTracker = new StatusTrackerImpl();
  const config = await readGlobalConfig();
  statusTracker.setDefaultModel(config?.defaultModel ?? 'unknown-model');
  await statusTracker.init();
  startServer(registry, statusTracker);
}

void main();
