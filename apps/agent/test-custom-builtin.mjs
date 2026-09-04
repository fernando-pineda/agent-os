import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { customTools } from "@agent-os/tools";
import { createPiSession } from "@agent-os/core";
import { join } from "node:path";

async function main() {
  const tools = customTools();
  const homeDir = "/Users/fernando/.agent-os/dev-homes/star";
  const contextFactory = (signal) => ({
    agentId: "star", workspace: "star", homeDir, signal, env: {},
    sendAgentMessage: async () => "ok",
  });

  const handle = await createPiSession({
    model: "fireworks/accounts/fireworks/routers/glm-5p2-fast",
    homeDir, cwd: homeDir, tools, agentId: "star", agentName: "Star",
    buildSystemPrompt: () => "You are Star. Use bash to list files when asked.",
    contextFactory, extensionFactories: [],
  });

  // Check what tools are available
  const allTools = handle.session.getAllTools();
  console.log("Tools available:", allTools.map(t => t.name).join(", "));
  console.log("Tool count:", allTools.length);

  let toolExecuted = false;
  const unsub = handle.subscribe((event) => {
    if (event.type === "tool_execution_start") { toolExecuted = true; console.log(`[EXEC] ${event.toolName}`); }
    if (event.type === "agent_end") console.log(`[END] retry=${event.willRetry}`);
  });

  await handle.prompt("List files using bash.", new AbortController().signal);
  console.log(`DONE toolExecuted=${toolExecuted}`);
  unsub(); handle.dispose(); process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
