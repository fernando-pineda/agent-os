import { join } from 'node:path';
import type {
  Api,
  ImageContent,
  Message,
  Model,
  ToolCall as PiToolCall,
  TextContent,
} from '@earendil-works/pi-ai';
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { toolToPiDefinition } from './tool-adapter.js';
import type {
  ChatMessage,
  SubagentConfig,
  Tool,
  ToolContext,
} from './types.js';

export interface PiSessionConfig {
  model: string;
  homeDir: string;
  cwd: string;
  tools: Tool[];
  agentId: string;
  agentName?: string;
  role?: string;
  instructions?: string;
  memoryIndex?: string;
  reminders?: string[];
  buildSystemPrompt: () => string;
  initialMessages?: ChatMessage[];
  contextFactory: (signal?: AbortSignal) => ToolContext;
  extensionFactories?: Array<(pi: ExtensionAPI) => void>;
}

export interface PiSessionHandle {
  session: AgentSession;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(
    text: string,
    signal?: AbortSignal,
    images?: Array<{ data: string; mimeType: string }>,
  ): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  dispose(): void;
  getMessages(): ChatMessage[];
}

export interface SubagentSessionHandle {
  prompt(task: string, signal?: AbortSignal): Promise<string>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  dispose(): void;
}

function toPiContent(
  message: ChatMessage,
): string | (TextContent | ImageContent)[] {
  if (!message.images || message.images.length === 0) {
    return message.content;
  }

  return [
    { type: 'text', text: message.content },
    ...message.images.map(
      (image): ImageContent => ({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType,
      }),
    ),
  ];
}

function toPiMessage(
  message: ChatMessage,
  model: Model<Api>,
  toolNames: ReadonlyMap<string, string>,
): Message | undefined {
  const timestamp = Date.now();

  if (message.role === 'system') {
    return undefined;
  }

  if (message.role === 'user') {
    return {
      role: 'user',
      content: toPiContent(message),
      timestamp,
    };
  }

  if (message.role === 'assistant') {
    const textContent: TextContent[] = message.content
      ? [{ type: 'text', text: message.content }]
      : [];
    const toolCallContent: PiToolCall[] = (message.toolCalls ?? []).map(
      (toolCall) => ({
        type: 'toolCall',
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.args,
      }),
    );

    return {
      role: 'assistant',
      content: [...textContent, ...toolCallContent],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason:
        message.toolCalls && message.toolCalls.length > 0 ? 'toolUse' : 'stop',
      timestamp,
    };
  }

  return {
    role: 'toolResult',
    toolCallId: message.toolCallId ?? '',
    toolName: message.toolCallId
      ? (toolNames.get(message.toolCallId) ?? 'tool')
      : 'tool',
    content: [
      { type: 'text', text: message.content },
      ...(message.images ?? []).map(
        (image): ImageContent => ({
          type: 'image',
          data: image.data,
          mimeType: image.mimeType,
        }),
      ),
    ],
    isError: false,
    timestamp,
  };
}

function appendInitialMessages(
  sessionManager: SessionManager,
  model: Model<Api>,
  messages: readonly ChatMessage[] | undefined,
): void {
  if (!messages) {
    return;
  }

  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls ?? []) {
        toolNames.set(toolCall.id, toolCall.name);
      }
    }

    const piMessage = toPiMessage(message, model, toolNames);
    if (piMessage) {
      sessionManager.appendMessage(piMessage);
    }
  }
}

function fromPiMessage(
  message: AgentSession['messages'][number],
): ChatMessage | undefined {
  if (message.role === 'user') {
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part): part is TextContent => part.type === 'text')
            .map((part) => part.text)
            .join('');
    const images =
      typeof message.content === 'string'
        ? undefined
        : message.content
            .filter((part): part is ImageContent => part.type === 'image')
            .map((part) => ({ data: part.data, mimeType: part.mimeType }));

    return {
      role: 'user',
      content,
      ...(images && images.length > 0 ? { images } : {}),
    };
  }

  if (message.role === 'assistant') {
    const textParts = message.content.filter(
      (part): part is TextContent => part.type === 'text',
    );
    const toolCalls = message.content
      .filter(
        (part): part is Extract<typeof part, { type: 'toolCall' }> =>
          part.type === 'toolCall',
      )
      .map((part) => ({
        id: part.id,
        name: part.name,
        args: part.arguments,
      }));

    return {
      role: 'assistant',
      content: textParts.map((part) => part.text).join(''),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  if (message.role === 'toolResult') {
    const textParts = message.content.filter(
      (part): part is TextContent => part.type === 'text',
    );
    const images = message.content
      .filter((part): part is ImageContent => part.type === 'image')
      .map((part) => ({ data: part.data, mimeType: part.mimeType }));

    return {
      role: 'tool',
      content: textParts.map((part) => part.text).join(''),
      ...(images.length > 0 ? { images } : {}),
      toolCallId: message.toolCallId,
    };
  }

  return undefined;
}

function createSystemPromptExtension(
  config: PiSessionConfig,
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on('before_agent_start', () => ({
      systemPrompt: config.buildSystemPrompt(),
    }));
  };
}

async function resolveModel(
  modelRuntime: ModelRuntime,
  modelId: string,
): Promise<Model<Api>> {
  // Try to find the model across all configured providers.
  // modelId may be "provider/model" or just "model-id".
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) {
    const providerId = modelId.slice(0, slashIdx);
    const rawModelId = modelId.slice(slashIdx + 1);
    const model = modelRuntime.getModel(providerId, rawModelId);
    if (model) return model;
    const modelLower = modelRuntime.getModel(
      providerId,
      rawModelId.toLowerCase(),
    );
    if (modelLower) return modelLower;
  }

  // Search all providers for a matching model id.
  for (const provider of modelRuntime.getProviders()) {
    const model = modelRuntime.getModel(provider.id, modelId);
    if (model) return model;
    const modelLower = modelRuntime.getModel(
      provider.id,
      modelId.toLowerCase(),
    );
    if (modelLower) return modelLower;
  }

  // Fallback: first available model from any provider.
  const available = await modelRuntime.getAvailable();
  if (available.length > 0) {
    const fallback = available[0]!;
    console.warn(
      `Model ${modelId} not found in any provider; using ${fallback.provider}/${fallback.id}`,
    );
    return fallback;
  }

  throw new Error(
    `No models available. Configure a provider in Pi (env vars, ~/.pi/agent/auth.json, or /login).`,
  );
}

function resolveSubagentModel(
  modelRuntime: ModelRuntime,
  modelId: string,
): Model<Api> | undefined {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx > 0) {
    const providerId = modelId.slice(0, slashIdx);
    const rawModelId = modelId.slice(slashIdx + 1);
    const model = modelRuntime.getModel(providerId, rawModelId);
    if (model) {
      return model;
    }
    const modelLower = modelRuntime.getModel(
      providerId,
      rawModelId.toLowerCase(),
    );
    if (modelLower) {
      return modelLower;
    }
  }

  for (const provider of modelRuntime.getProviders()) {
    const model = modelRuntime.getModel(provider.id, modelId);
    if (model) {
      return model;
    }
    const modelLower = modelRuntime.getModel(
      provider.id,
      modelId.toLowerCase(),
    );
    if (modelLower) {
      return modelLower;
    }
  }

  return undefined;
}

export async function createPiSession(
  config: PiSessionConfig,
): Promise<PiSessionHandle> {
  const modelRuntime = await ModelRuntime.create();
  const model = await resolveModel(modelRuntime, config.model);
  const customTools = config.tools.map((tool) =>
    toolToPiDefinition(tool, config.contextFactory),
  );
  const settingsManager = SettingsManager.inMemory();
  const allExtensions = [...(config.extensionFactories ?? [])];
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.cwd,
    agentDir: join(config.homeDir, '.pi', 'agent'),
    settingsManager,
    systemPromptOverride: () => config.buildSystemPrompt(),
    extensionFactories: allExtensions,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(config.cwd);
  appendInitialMessages(sessionManager, model, config.initialMessages);
  const { session } = await createAgentSession({
    model,
    modelRuntime,
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  return {
    session,
    subscribe: (listener): (() => void) => session.subscribe(listener),
    prompt: async (text, signal, images): Promise<void> => {
      const piImages = images?.map((img) => ({
        type: 'image' as const,
        data: img.data,
        mimeType: img.mimeType,
      }));
      const promptOpts = piImages ? { images: piImages } : undefined;

      if (!signal) {
        await session.prompt(text, promptOpts);
        return;
      }
      if (signal.aborted) {
        await session.abort();
        return;
      }

      let abortFailure: Error | undefined;
      const abortHandler = (): void => {
        void session.abort().catch((error) => {
          abortFailure =
            error instanceof Error ? error : new Error(String(error));
        });
      };
      signal.addEventListener('abort', abortHandler, { once: true });
      try {
        await session.prompt(text, promptOpts);
      } finally {
        signal.removeEventListener('abort', abortHandler);
      }
      if (abortFailure) {
        throw abortFailure;
      }
    },
    abort: (): Promise<void> => session.abort(),
    compact: async (): Promise<void> => {
      await session.compact();
    },
    dispose: (): void => session.dispose(),
    getMessages: (): ChatMessage[] =>
      session.messages
        .map((message) => fromPiMessage(message))
        .filter((message): message is ChatMessage => message !== undefined),
  };
}

export async function createSubagentSession(
  config: SubagentConfig,
  parentModelRuntime: ModelRuntime,
  parentModel: Model<Api>,
  allCustomTools: Tool[],
  contextFactory: (signal?: AbortSignal) => ToolContext,
): Promise<SubagentSessionHandle> {
  const model = config.model
    ? (resolveSubagentModel(parentModelRuntime, config.model) ?? parentModel)
    : parentModel;
  const customTools = allCustomTools.map((tool) =>
    toolToPiDefinition(tool, contextFactory),
  );
  const settingsManager = SettingsManager.inMemory();
  const cwd = process.cwd();
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: join(process.env.HOME ?? cwd, '.pi', 'agent'),
    settingsManager,
    systemPromptOverride: () => config.systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    model,
    modelRuntime: parentModelRuntime,
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    excludeTools: ['subagent_run', 'subagent_create'],
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  return {
    prompt: async (task, signal): Promise<string> => {
      if (signal?.aborted) {
        await session.abort();
        return session.getLastAssistantText() ?? '(no response)';
      }

      let abortFailure: Error | undefined;
      const abortHandler = (): void => {
        void session.abort().catch((error) => {
          abortFailure =
            error instanceof Error ? error : new Error(String(error));
        });
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      try {
        await session.prompt(task);
      } finally {
        signal?.removeEventListener('abort', abortHandler);
      }
      if (abortFailure) {
        throw abortFailure;
      }
      return session.getLastAssistantText() ?? '(no response)';
    },
    abort: (): Promise<void> => session.abort(),
    subscribe: (listener: (event: AgentSessionEvent) => void): (() => void) =>
      session.subscribe(listener),
    dispose: (): void => session.dispose(),
  };
}
