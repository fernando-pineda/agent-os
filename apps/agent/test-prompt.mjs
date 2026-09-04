import { customTools } from "@agent-os/tools";

// Copy the buildAgentSystemPrompt function from main.ts
function buildAgentSystemPrompt(inputs) {
  const now = new Date();
  const toolLines = inputs.tools.map(t => `- ${t.spec.name}: ${t.spec.description}`).join("\n");
  return `You are an autonomous agent. Model: ${inputs.model}. Tools:\n${toolLines}`;
}

const tools = customTools();
const prompt = buildAgentSystemPrompt({
  tools,
  model: "fireworks/accounts/fireworks/routers/glm-5p2-fast",
  agentId: "star",
  agentName: "Star",
  reminders: [],
});
console.log("Prompt length:", prompt.length);
console.log("First 200:", prompt.slice(0, 200));
