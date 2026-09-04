import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

async function main() {
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable("fireworks");
  const target = available.find(m => m.id.includes("glm-5p2-fast"));
  const homeDir = "/Users/fernando/.agent-os/dev-homes/star";

  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: homeDir,
    agentDir: join(homeDir, '.pi', 'agent'),
    settingsManager,
    systemPromptOverride: () => "You are Star. Use bash to list files.",
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model: target,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(homeDir),
    settingsManager,
  });

  // Check what tools are available
  const allTools = session.getAllTools();
  console.log("Tools available:", allTools.map(t => t.name).join(", "));

  let toolExecuted = false;
  const unsub = session.subscribe((event) => {
    if (event.type === "tool_execution_start") { toolExecuted = true; console.log(`[EXEC] ${event.toolName}`); }
    if (event.type === "agent_end") console.log(`[END] retry=${event.willRetry}`);
  });

  await session.prompt("List files using bash.");
  console.log(`DONE toolExecuted=${toolExecuted}`);
  unsub(); session.dispose(); process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
