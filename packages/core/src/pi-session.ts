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
import type { ChatMessage, Tool, ToolContext } from './types.js';

export interface PiSessionConfig {
  provider: 'fireworks' | 'zai';
  apiKey: string;
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
  prompt(text: string, signal?: AbortSignal): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  dispose(): void;
  getMessages(): ChatMessage[];
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
  provider: PiSessionConfig['provider'],
  modelId: string,
): Promise<Model<Api>> {
  const normalizedModelId = modelId.toLowerCase();
  const normalizedModel = modelRuntime.getModel(provider, normalizedModelId);
  const model =
    normalizedModel ?? modelRuntime.getModel(provider, modelId.toUpperCase());
  if (model) {
    return model;
  }

  const availableModels = await modelRuntime.getAvailable(provider);
  const fallbackModel = availableModels[0];
  if (!fallbackModel) {
    throw new Error(`No models available for provider ${provider}`);
  }

  console.warn(
    `Model ${modelId} was not found for provider ${provider}; using ${fallbackModel.id}`,
  );
  return fallbackModel;
}

export async function createPiSession(
  config: PiSessionConfig,
): Promise<PiSessionHandle> {
  const modelRuntime = await ModelRuntime.create();
  await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
  const model = await resolveModel(modelRuntime, config.provider, config.model);
  const customTools = config.tools.map((tool) =>
    toolToPiDefinition(tool, config.contextFactory),
  );
  const settingsManager = SettingsManager.inMemory();
  const allExtensions = [
    createSystemPromptExtension(config),
    ...(config.extensionFactories ?? []),
  ];
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
    noTools: 'builtin',
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  return {
    session,
    subscribe: (listener): (() => void) => session.subscribe(listener),
    prompt: async (text, signal): Promise<void> => {
      if (!signal) {
        await session.prompt(text);
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
        await session.prompt(text);
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
