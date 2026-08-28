import type { AgentConfig, AgentInfo, AgentStatus } from '@agent-os/core';
import {
  getOrCreateEntry,
  listAgentConfigs,
  loadRegistry,
  type Registry,
  saveRegistry,
  toAgentInfo,
} from './registry.js';

const POLL_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 1000;

export interface StatusTracker {
  getAgents(): AgentInfo[];
  getAgent(id: string): AgentInfo | undefined;
  refreshAgent(config: AgentConfig): void;
  updateStatus(id: string, status: AgentStatus, currentTaskId?: string): void;
  removeAgent(id: string): void;
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
  init(): Promise<void>;
}

interface HealthResponse {
  ok?: boolean;
  status?: AgentStatus;
  currentTaskId?: string;
}

export class StatusTrackerImpl implements StatusTracker {
  private info: Map<string, AgentInfo> = new Map();
  private listeners: Set<() => void> = new Set();
  private registry: Registry = { agents: [] };
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  async init(): Promise<void> {
    this.registry = await loadRegistry();
    const configs = await listAgentConfigs();
    for (const config of configs) {
      const entry = getOrCreateEntry(this.registry, config.id);
      const status = await pollAgent(config, entry.port);
      const info = toAgentInfo(config, status.status, 'unknown');
      if (status.currentTaskId) {
        info.currentTaskId = status.currentTaskId;
      }
      this.info.set(config.id, info);
    }
    this.notify();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getAgents(): AgentInfo[] {
    return Array.from(this.info.values());
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.info.get(id);
  }

  // Rebuild one agent from its config (PATCH path), keep live status.
  refreshAgent(config: AgentConfig): void {
    const existing = this.info.get(config.id);
    const status = existing?.status ?? 'stopped';
    const info = toAgentInfo(config, status, existing?.model ?? 'unknown');
    if (existing?.currentTaskId) {
      info.currentTaskId = existing.currentTaskId;
    }
    info.lastEventAt = new Date().toISOString();
    this.info.set(config.id, info);
    this.notify();
  }

  updateStatus(id: string, status: AgentStatus, currentTaskId?: string): void {
    const existing = this.info.get(id);
    if (existing) {
      existing.status = status;
      if (currentTaskId !== undefined) {
        existing.currentTaskId = currentTaskId;
      } else {
        delete existing.currentTaskId;
      }
      existing.lastEventAt = new Date().toISOString();
    }
    this.notify();
  }

  removeAgent(id: string): void {
    this.info.delete(id);
    this.notify();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const configs = await listAgentConfigs();
    let changed = false;
    for (const config of configs) {
      const entry = getOrCreateEntry(this.registry, config.id);
      const health = await pollAgent(config, entry.port);
      const existing = this.info.get(config.id);
      const currentStatus = existing?.status ?? 'stopped';
      if (
        currentStatus !== health.status ||
        existing?.currentTaskId !== health.currentTaskId ||
        existing?.group !== config.group ||
        existing?.name !== config.name ||
        existing?.role !== config.role
      ) {
        const info = toAgentInfo(
          config,
          health.status,
          existing?.model ?? 'unknown',
        );
        if (health.currentTaskId) {
          info.currentTaskId = health.currentTaskId;
        }
        info.lastEventAt = new Date().toISOString();
        this.info.set(config.id, info);
        entry.status = health.status;
        entry.lastSeen = new Date().toISOString();
        entry.currentTaskId = health.currentTaskId;
        changed = true;
      }
    }
    if (changed) {
      await saveRegistry(this.registry);
      this.notify();
    }
  }
}

async function pollAgent(
  _config: AgentConfig,
  port: number,
): Promise<{ status: AgentStatus; currentTaskId?: string | undefined }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const response = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      return { status: 'error' };
    }
    const data = (await response.json()) as unknown as HealthResponse;
    return {
      status: data.status ?? 'online',
      currentTaskId: data.currentTaskId,
    };
  } catch {
    return { status: 'stopped' };
  }
}
