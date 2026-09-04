import { createPiSession } from "@agent-os/core";
import { customTools } from "@agent-os/tools";
import { rebuildMcpForSession } from "./dist/mcp.js";

async function main() {
  const tools = customTools();
  const homeDir = "/Users/fernando/.agent-os/dev-homes/star";
  const contextFactory = (signal) => ({
    agentId: "star", workspace: "star", homeDir, signal, env: {},
    sendAgentMessage: async () => "ok",
  });

  const mcpExt = rebuildMcpForSession([], []);

  const handle = await createPiSession({
    model: "fireworks/accounts/fireworks/routers/glm-5p2-fast",
    homeDir, cwd: homeDir, tools, agentId: "star", agentName: "Star",
    buildSystemPrompt: () => "You are Star. Use bash to list files.",
    contextFactory,
    extensionFactories: [mcpExt],
  });

  let toolExecuted = false;
  const unsub = handle.subscribe((event) => {
    if (event.type === "tool_execution_start") { toolExecuted = true; console.log(`[EXEC] ${event.toolName}`); }
    if (event.type === "tool_execution_end") console.log(`[EXEC END]`);
    if (event.type === "agent_end") console.log(`[END] retry=${event.willRetry}`);
  });

  console.log("Prompting...");
  await handle.prompt("List files using bash.", new AbortController().signal);
  console.log(`DONE toolExecuted=${toolExecuted}`);
  unsub(); handle.dispose(); process.exit(0);
}
main().catch(err => { console.error(err); process.exit(1); });
