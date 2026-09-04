'use client';

import {
  CheckIcon,
  Loader2Icon,
  PencilIcon,
  PlayIcon,
  SettingsIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAgentSelection,
  useAgentsFeed,
  useGroupsFeed,
} from '@/components/agent-context';
import { AutomationsPanel } from '@/components/automations-panel';
import { ModelPickerModal } from '@/components/model-picker-modal';
import { RemindersEditor } from '@/components/reminders-editor';
import { SettingsDialog } from '@/components/settings-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsPanel,
  TabsTab,
} from '@/components/ui/tabs';
import {
  createAgent,
  createGroup,
  deleteAgent,
  deleteGroup,
  getMcpServers,
  getModels,
  startAgent,
  stopAgent,
  updateAgent,
} from '@/lib/api';
import {
  AGENT_AVATAR_COLORS,
  AGENT_AVATAR_DEFAULT_COLOR,
  AGENT_CHARACTERS,
  type AgentAvatar,
  avatarImagePath,
  avatarTileBackground,
} from '@/lib/avatars';
import type {
  AgentInfo,
  AgentStatus,
  McpServerConfig,
  ModelItem,
} from '@/lib/types';

// MCP plugins preselected on the create form. Names must exist in the
// supervisor's MCP catalog or creation is rejected, so only preselect ones
// that are actually configured (intersected at open time below).
const DEFAULT_PLUGINS: string[] = [];

function statusColor(status: AgentStatus): string {
  switch (status) {
    case 'starting':
      return 'bg-amber-400';
    case 'online':
      return 'bg-emerald-400';
    case 'busy':
      return 'bg-blue-400';
    case 'compressing':
      return 'bg-violet-400';
    case 'error':
      return 'bg-red-400';
    case 'stopped':
      return 'bg-zinc-500';
    default:
      return 'bg-zinc-500';
  }
}

function isPulsing(status: AgentStatus): boolean {
  return status === 'starting' || status === 'busy' || status === 'compressing';
}

function truncateModel(model: string): string {
  if (model.length <= 32) return model;
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function mcpDescriptor(server: McpServerConfig): string {
  if (server.transport === 'http') return server.url ?? '';
  const parts = [server.command ?? '', ...(server.args ?? [])];
  return parts.join(' ');
}

function AgentForm({
  name,
  role,
  model,
  character,
  color,
  instructions,
  agentId,
  onName,
  onRole,
  onModel,
  onCharacter,
  onColor,
  onInstructions,
  models,
  loadingModels,
  mcpServers,
  mcpLoading,
  selectedPlugins,
  onTogglePlugin,
  reminders,
  onReminders,
  footer,
}: {
  name: string;
  role: string;
  model: string;
  character: string;
  color: string;
  instructions: string;
  agentId?: string;
  onName: (v: string) => void;
  onRole: (v: string) => void;
  onModel: (v: string) => void;
  onCharacter: (v: string) => void;
  onColor: (v: string) => void;
  onInstructions: (v: string) => void;
  models: ModelItem[];
  loadingModels: boolean;
  mcpServers: McpServerConfig[];
  mcpLoading: boolean;
  selectedPlugins: string[];
  onTogglePlugin: (name: string, checked: boolean) => void;
  reminders: string[];
  onReminders: (next: string[]) => void;
  footer?: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
      <TabsList>
        <TabsTab value="general">General</TabsTab>
        <TabsTab value="instructions">Instructions & roles</TabsTab>
        <TabsTab value="automations">Automations</TabsTab>
        <TabsTab value="plugins">Active plugins</TabsTab>
        <TabsTab value="reminders">Reminders</TabsTab>
        <TabsIndicator />
      </TabsList>
      <TabsPanel value="general">
        <div className="space-y-3 overflow-y-auto p-0.5">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Name</label>
            <Input
              value={name}
              onChange={(e) => onName(e.target.value)}
              placeholder="research-agent"
              className="border-zinc-800 bg-zinc-950 text-zinc-100"
            />
          </div>
          <ModelPickerModal
            models={models}
            value={model}
            onChange={onModel}
            loading={loadingModels}
            allowManual={models.length === 0}
            placeholder="Default"
          />
          <AvatarPicker
            character={character}
            color={color}
            onCharacter={onCharacter}
            onColor={onColor}
          />
        </div>
      </TabsPanel>
      <TabsPanel value="instructions">
        <div className="space-y-3 overflow-y-auto p-0.5">
          <div>
            <label className="mb-1 block text-xs text-zinc-400">Role</label>
            <Input
              value={role}
              onChange={(e) => onRole(e.target.value)}
              placeholder="planner"
              className="border-zinc-800 bg-zinc-950 text-zinc-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-400">
              Instructions
            </label>
            <textarea
              value={instructions}
              onChange={(e) => onInstructions(e.target.value)}
              placeholder="Extra instructions for this agent, injected into its system prompt."
              rows={6}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-700"
            />
          </div>
        </div>
      </TabsPanel>
      <TabsPanel value="automations">
        {agentId ? (
          <AutomationsPanel agentId={agentId} />
        ) : (
          <div className="py-6 text-center text-xs text-zinc-500">
            Save the agent first to configure automations.
          </div>
        )}
      </TabsPanel>
      <TabsPanel value="plugins">
        {mcpLoading ? (
          <div className="py-6 text-center text-xs text-zinc-500">
            Loading...
          </div>
        ) : mcpServers.length === 0 ? (
          <div className="py-6 text-center text-sm text-zinc-500">
            No plugins configured. Add them in Settings.
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-1 overflow-y-auto py-2 pr-1">
            {mcpServers.map((server) => (
              <label
                key={server.name}
                className="flex items-start justify-between gap-3 rounded-md px-2 py-2 hover:bg-zinc-800/40"
              >
                <div className="flex items-start gap-2.5">
                  <Checkbox
                    checked={selectedPlugins.includes(server.name)}
                    onCheckedChange={(checked) =>
                      onTogglePlugin(server.name, checked)
                    }
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-zinc-300">
                      {server.name}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {mcpDescriptor(server)}
                    </div>
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </TabsPanel>
      <TabsPanel value="reminders">
        <div className="space-y-3 py-2">
          <p className="text-xs text-zinc-500">
            Short texts injected into every agent turn. Agents consider them
            silently.
          </p>
          <RemindersEditor
            value={reminders}
            onChange={onReminders}
            idPrefix="agent-reminders"
          />
        </div>
      </TabsPanel>
      {footer && <div className="mt-auto pt-2">{footer}</div>}
    </Tabs>
  );
}

function AvatarPicker({
  character,
  color,
  onCharacter,
  onColor,
}: {
  character: string;
  color: string;
  onCharacter: (c: string) => void;
  onColor: (c: string) => void;
}) {
  return (
    <>
      <div>
        <label className="mb-1.5 block text-xs text-zinc-400">Character</label>
        <div className="flex flex-wrap gap-2 p-0.5">
          {AGENT_CHARACTERS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onCharacter(c)}
              className={`size-14 rounded-xl p-1.5 transition-all ${
                character === c ? 'ring-2 ring-zinc-400' : 'hover:bg-white/5'
              }`}
              style={{ background: avatarTileBackground(color) }}
              aria-label={`Select character ${c}`}
            >
              <img
                src={avatarImagePath(c)}
                alt=""
                className="size-full object-contain"
              />
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="mb-1.5 block text-xs text-zinc-400">Color</label>
        <div className="flex gap-1.5 p-0.5">
          {AGENT_AVATAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onColor(c)}
              className={`size-6 rounded-md ${
                color === c ? 'ring-2 ring-white' : ''
              }`}
              style={{ background: avatarTileBackground(c) }}
              aria-label={`Select color ${c}`}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function GroupSection({
  name,
  agents,
  selectedAgentId,
  onSelect,
  onDropAgent,
  onDeleteGroup,
  openEditDialog,
  toggleStartStop,
  openDeleteDialog,
}: {
  name: string;
  agents: AgentInfo[];
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
  onDropAgent: (agentId: string, group: string) => void;
  onDeleteGroup: (name: string) => void;
  openEditDialog: (agent: AgentInfo) => void;
  toggleStartStop: (agent: AgentInfo) => void;
  openDeleteDialog: (agent: AgentInfo) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(true);
  };
  const handleDragLeave = (): void => setDragOver(false);
  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const agentId = e.dataTransfer.getData('text/agent-id');
    if (agentId) onDropAgent(agentId, name);
  };
  const header = (
    <li
      className={`sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-400 ${
        dragOver ? 'bg-zinc-800' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <span>{name || 'Ungrouped'}</span>
      <span className="text-zinc-600">{agents.length}</span>
    </li>
  );
  return (
    <>
      {name ? (
        <ContextMenu>
          <ContextMenuTrigger render={header} />
          <ContextMenuContent>
            <ContextMenuItem
              onClick={() => onDeleteGroup(name)}
              className="text-red-400 focus:bg-red-950/50 focus:text-red-300"
            >
              <Trash2Icon className="size-4" />
              Delete group
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}
      {agents.length === 0 ? (
        <li
          className={`px-3 py-3 text-center text-xs text-zinc-600 ${
            dragOver ? 'bg-zinc-800' : ''
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          Drop agents here
        </li>
      ) : null}
      {agents.map((agent) => {
        const selected = agent.id === selectedAgentId;
        const rowDragOver = dragOver;
        const isRunning = agent.status === 'online' || agent.status === 'busy';
        return (
          <ContextMenu key={agent.id}>
            <ContextMenuTrigger
              render={
                <li
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/agent-id', agent.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  className={`cursor-pointer px-3 py-2 transition-colors hover:bg-zinc-800 ${
                    selected || rowDragOver ? 'bg-zinc-800' : ''
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => onSelect(agent.id)}
                />
              }
            >
              <div className="flex items-center gap-2.5">
                {agent.avatar ? (
                  <div className="relative shrink-0 p-0.5">
                    <div
                      className="size-10 rounded-xl"
                      style={{
                        background: avatarTileBackground(agent.avatar.color),
                      }}
                    >
                      <img
                        src={avatarImagePath(agent.avatar.character)}
                        alt=""
                        className="size-full object-contain p-1"
                      />
                    </div>
                    <span
                      className={`absolute bottom-0 right-0 size-2.5 rounded-full ring-2 ring-zinc-900 ${statusColor(
                        agent.status,
                      )} ${isPulsing(agent.status) ? 'status-pulse' : ''}`}
                    />
                  </div>
                ) : null}
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-zinc-200">
                    {agent.name}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                    {agent.workspace !== agent.id && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-400">
                        {agent.workspace}
                      </span>
                    )}
                    <span className="font-mono">
                      {truncateModel(agent.model)}
                    </span>
                  </div>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => openEditDialog(agent)}>
                <PencilIcon className="size-4 text-zinc-400" />
                Edit
              </ContextMenuItem>
              <ContextMenuItem onClick={() => void toggleStartStop(agent)}>
                {isRunning ? (
                  <>
                    <SquareIcon className="size-4 text-zinc-400" />
                    Stop
                  </>
                ) : (
                  <>
                    <PlayIcon className="size-4 text-zinc-400" />
                    Start
                  </>
                )}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => openDeleteDialog(agent)}
                className="text-red-400 focus:bg-red-950/50 focus:text-red-300"
              >
                <Trash2Icon className="size-4" />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </>
  );
}

export function AgentsPanel() {
  const { selectedAgentId, setSelectedAgentId } = useAgentSelection();
  const { patchAgentStatus } = useAgentSelection();
  const agents = useAgentsFeed();
  const { groups, refreshGroups } = useGroupsFeed();
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [reminders, setReminders] = useState<string[]>([]);
  const [character, setCharacter] = useState(AGENT_CHARACTERS[0]);
  const [color, setColor] = useState(AGENT_AVATAR_DEFAULT_COLOR);
  const [creating, setCreating] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupError, setGroupError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    setLoadingModels(true);
    getModels()
      .then((list) => {
        setModels(list);
        if (list.length > 0 && !model) setModel(list[0].id);
      })
      .catch(console.error)
      .finally(() => setLoadingModels(false));
  }, [model]);

  const refreshMcpServers = useCallback(async (): Promise<
    McpServerConfig[]
  > => {
    setMcpLoading(true);
    try {
      const list = await getMcpServers();
      setMcpServers(list);
      return list;
    } catch (err) {
      console.error(err);
      return [];
    } finally {
      setMcpLoading(false);
    }
  }, []);

  const onTogglePlugin = useCallback((pluginName: string, checked: boolean) => {
    setSelectedPlugins((prev) =>
      checked
        ? prev.includes(pluginName)
          ? prev
          : [...prev, pluginName]
        : prev.filter((p) => p !== pluginName),
    );
  }, []);

  useEffect(() => {
    if (dialogOpen) {
      setReminders([]);
      void (async () => {
        const list = await refreshMcpServers();
        const available = new Set(list.map((s) => s.name));
        setSelectedPlugins(DEFAULT_PLUGINS.filter((p) => available.has(p)));
      })();
    }
  }, [dialogOpen, refreshMcpServers]);

  const onCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const payload: {
        name: string;
        role?: string;
        model?: string;
        instructions?: string;
        reminders?: string[];
        avatar: AgentAvatar;
        plugins: string[];
      } = {
        name: name.trim(),
        avatar: { character, color },
        plugins: selectedPlugins,
      };
      if (role.trim()) payload.role = role.trim();
      if (model.trim()) payload.model = model.trim();
      if (instructions.trim()) payload.instructions = instructions.trim();
      if (reminders.length > 0) payload.reminders = reminders;
      const agent = await createAgent(payload);
      setSelectedAgentId(agent.id);
      setDialogOpen(false);
      setName('');
      setRole('');
      setModel('');
      setInstructions('');
      setReminders([]);
      setCharacter(AGENT_CHARACTERS[0]);
      setColor(AGENT_AVATAR_DEFAULT_COLOR);
      setSelectedPlugins([]);
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }, [
    name,
    role,
    model,
    instructions,
    character,
    color,
    selectedPlugins,
    reminders,
    setSelectedAgentId,
  ]);

  const onCreateGroup = useCallback(async () => {
    const trimmed = groupName.trim();
    if (!trimmed) return;
    setCreatingGroup(true);
    setGroupError('');
    try {
      await createGroup(trimmed);
      refreshGroups();
      setGroupDialogOpen(false);
      setGroupName('');
    } catch (err) {
      setGroupError(
        err instanceof Error ? err.message : 'Failed to create group',
      );
    } finally {
      setCreatingGroup(false);
    }
  }, [groupName, refreshGroups]);

  const onDropAgent = useCallback((agentId: string, targetGroup: string) => {
    void updateAgent(agentId, { group: targetGroup || undefined });
  }, []);

  const onDeleteGroup = useCallback(
    (name: string) => {
      void deleteGroup(name).then(() => refreshGroups());
    },
    [refreshGroups],
  );

  const toggleStartStop = useCallback(
    async (agent: AgentInfo) => {
      try {
        if (agent.status === 'online' || agent.status === 'busy') {
          patchAgentStatus(agent.id, 'stopped');
          await stopAgent(agent.id);
        } else {
          patchAgentStatus(agent.id, 'starting');
          await startAgent(agent.id);
        }
      } catch (err) {
        console.error(err);
      }
    },
    [patchAgentStatus],
  );

  // --- Delete dialog state ---
  const [deleteDialog, setDeleteDialog] = useState<AgentInfo | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const openDeleteDialog = useCallback((agent: AgentInfo) => {
    setDeleteDialog(agent);
    setDeleteConfirm('');
    setDeleteError('');
  }, []);

  const closeDeleteDialog = useCallback(() => {
    setDeleteDialog(null);
    setDeleteConfirm('');
    setDeleteError('');
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteDialog) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteAgent(deleteDialog.id, deleteConfirm);
      if (selectedAgentId === deleteDialog.id) {
        setSelectedAgentId(null);
      }
      closeDeleteDialog();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'Failed to delete agent',
      );
    } finally {
      setDeleting(false);
    }
  }, [
    deleteDialog,
    deleteConfirm,
    closeDeleteDialog,
    selectedAgentId,
    setSelectedAgentId,
  ]);

  // --- Edit dialog state (autosave with debounce) ---
  const [editDialog, setEditDialog] = useState<AgentInfo | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editInstructions, setEditInstructions] = useState('');
  const [editReminders, setEditReminders] = useState<string[]>([]);
  const [editModel, setEditModel] = useState('');
  const [editCharacter, setEditCharacter] = useState<string>(
    AGENT_CHARACTERS[0],
  );
  const [editColor, setEditColor] = useState(AGENT_AVATAR_DEFAULT_COLOR);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'pending' | 'saving' | 'saved' | 'error'
  >('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutosaveRef = useRef(true);

  const persistEdit = useCallback(async () => {
    if (!editDialog) return;
    setSaveStatus('saving');
    try {
      await updateAgent(editDialog.id, {
        name: editName.trim() || undefined,
        role: editRole.trim() || undefined,
        model: editModel.trim() || undefined,
        instructions: editInstructions.trim() || undefined,
        avatar: { character: editCharacter, color: editColor },
        plugins: selectedPlugins,
        reminders: editReminders,
      });
      setSaveStatus('saved');
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 1500);
    } catch (err) {
      console.error(err);
      setSaveStatus('error');
    }
  }, [
    editDialog,
    editName,
    editRole,
    editModel,
    editInstructions,
    editCharacter,
    editColor,
    selectedPlugins,
    editReminders,
  ]);

  // Autosave: any field change re-arms the debounce. The field deps are the
  // trigger, persistEdit reads their latest values when it fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: field values are the debounce trigger
  useEffect(() => {
    if (skipAutosaveRef.current) {
      skipAutosaveRef.current = false;
      return;
    }
    if (!editDialog) return;
    setSaveStatus('pending');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void persistEdit(), 700);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [
    editName,
    editRole,
    editInstructions,
    editModel,
    editCharacter,
    editColor,
    selectedPlugins,
    editReminders,
    editDialog,
    persistEdit,
  ]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  const openEditDialog = useCallback(
    (agent: AgentInfo) => {
      skipAutosaveRef.current = true;
      setEditDialog(agent);
      setEditName(agent.name);
      setEditRole(agent.role ?? '');
      setEditInstructions(agent.instructions ?? '');
      setEditReminders(agent.reminders ?? []);
      setEditModel(agent.model);
      setEditCharacter(agent.avatar?.character ?? AGENT_CHARACTERS[0]);
      setEditColor(agent.avatar?.color ?? AGENT_AVATAR_DEFAULT_COLOR);
      setSelectedPlugins(agent.plugins ?? []);
      setSaveStatus('idle');
      void refreshMcpServers();
    },
    [refreshMcpServers],
  );

  const closeEditDialog = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    setEditDialog(null);
    setSaveStatus('idle');
  }, []);

  return (
    <div className="flex h-full flex-col border-t border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium text-zinc-400">Agents</span>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              />
            }
          >
            + New
          </MenuTrigger>
          <MenuContent>
            <MenuItem onClick={() => setDialogOpen(true)}>New agent</MenuItem>
            <MenuItem onClick={() => setGroupDialogOpen(true)}>
              New group
            </MenuItem>
          </MenuContent>
        </Menu>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:h-[620px] sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
            </DialogHeader>
            <AgentForm
              name={name}
              role={role}
              model={model}
              character={character}
              color={color}
              instructions={instructions}
              onName={setName}
              onRole={setRole}
              onModel={setModel}
              onCharacter={setCharacter}
              onColor={setColor}
              onInstructions={setInstructions}
              models={models}
              loadingModels={loadingModels}
              mcpServers={mcpServers}
              mcpLoading={mcpLoading}
              selectedPlugins={selectedPlugins}
              onTogglePlugin={onTogglePlugin}
              reminders={reminders}
              onReminders={setReminders}
              footer={
                <Button
                  onClick={onCreate}
                  disabled={!name.trim() || creating}
                  className="w-full"
                >
                  {creating ? 'Saving...' : 'Create agent'}
                </Button>
              }
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex-1 overflow-y-auto">
        {agents.length === 0 && (
          <div className="px-3 py-4 text-xs text-zinc-500">
            No agents yet. Create one to start.
          </div>
        )}
        <ul className="divide-y divide-zinc-800">
          {(() => {
            const byGroup = new Map<string, AgentInfo[]>();
            const allGroups = new Set([
              ...groups,
              ...(agents.map((a) => a.group).filter(Boolean) as string[]),
            ]);
            for (const g of allGroups) byGroup.set(g, []);
            const ungrouped: AgentInfo[] = [];
            for (const a of agents) {
              if (a.group && byGroup.has(a.group)) {
                byGroup.get(a.group)!.push(a);
              } else {
                ungrouped.push(a);
              }
            }
            const sections: { name: string; agents: AgentInfo[] }[] = [];
            for (const [name, list] of byGroup) {
              sections.push({ name, agents: list });
            }
            if (ungrouped.length > 0 || sections.length === 0) {
              sections.push({ name: '', agents: ungrouped });
            }
            return sections;
          })().map((section) => (
            <GroupSection
              key={section.name || 'ungrouped'}
              name={section.name}
              agents={section.agents}
              selectedAgentId={selectedAgentId}
              onSelect={setSelectedAgentId}
              onDropAgent={onDropAgent}
              onDeleteGroup={onDeleteGroup}
              openEditDialog={openEditDialog}
              toggleStartStop={toggleStartStop}
              openDeleteDialog={openDeleteDialog}
            />
          ))}
        </ul>
      </div>

      <div className="border-t border-zinc-800 p-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-sm text-zinc-400"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
          Settings
        </Button>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* New group dialog */}
      <Dialog open={groupDialogOpen} onOpenChange={setGroupDialogOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="research"
              className="border-zinc-800 bg-zinc-950 text-zinc-100"
            />
            {groupError && (
              <div className="text-xs text-destructive">{groupError}</div>
            )}
            <Button
              onClick={onCreateGroup}
              disabled={!groupName.trim() || creatingGroup}
              className="w-full"
            >
              {creatingGroup ? 'Creating...' : 'Create group'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={deleteDialog !== null} onOpenChange={closeDeleteDialog}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
          <DialogHeader>
            <DialogTitle>Delete {deleteDialog?.name}</DialogTitle>
            <DialogDescription className="text-zinc-400">
              This will permanently delete the agent and its configuration. Type
              the agent's exact name below to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={deleteDialog?.name}
              className="border-zinc-800 bg-zinc-950 text-zinc-100"
            />
            {deleteError && (
              <div className="text-xs text-destructive">{deleteError}</div>
            )}
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteConfirm !== deleteDialog?.name || deleting}
              className="w-full"
            >
              {deleting ? 'Deleting...' : 'Delete agent'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editDialog !== null} onOpenChange={closeEditDialog}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:h-[620px] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Edit {editDialog?.name}
              {saveStatus === 'pending' && (
                <Loader2Icon className="size-3.5 animate-spin text-zinc-500" />
              )}
              {saveStatus === 'saving' && (
                <Loader2Icon className="size-3.5 animate-spin text-zinc-300" />
              )}
              {saveStatus === 'saved' && (
                <CheckIcon className="size-3.5 text-emerald-400" />
              )}
              {saveStatus === 'error' && (
                <span className="text-xs font-normal text-destructive">
                  Failed to save
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Changes save automatically.
            </DialogDescription>
          </DialogHeader>
          <AgentForm
            name={editName}
            role={editRole}
            model={editModel}
            character={editCharacter}
            color={editColor}
            instructions={editInstructions}
            agentId={editDialog?.id}
            onName={setEditName}
            onRole={setEditRole}
            onModel={setEditModel}
            onCharacter={setEditCharacter}
            onColor={setEditColor}
            onInstructions={setEditInstructions}
            models={models}
            loadingModels={loadingModels}
            mcpServers={mcpServers}
            mcpLoading={mcpLoading}
            selectedPlugins={selectedPlugins}
            onTogglePlugin={onTogglePlugin}
            reminders={editReminders}
            onReminders={setEditReminders}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
