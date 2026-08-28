'use client';

import { PencilIcon, PlayIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAgentSelection, useAgentsFeed } from '@/components/agent-context';
import { ModelPickerModal } from '@/components/model-picker-modal';
import { Button } from '@/components/ui/button';
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
import {
  createAgent,
  deleteAgent,
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
} from '@/lib/avatars';
import type { AgentInfo, AgentStatus, ModelItem } from '@/lib/types';

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

function avatarImagePath(character: string): string {
  return `/characters/${character}.png`;
}

// Tile background: vertical gradient from a lightened top to the picked color.
function avatarTileBackground(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + 56);
  const g = Math.min(255, ((n >> 8) & 0xff) + 56);
  const b = Math.min(255, (n & 0xff) + 56);
  return `linear-gradient(135deg, rgb(${r}, ${g}, ${b}) 0%, ${color} 65%)`;
}

function AgentForm({
  name,
  group,
  workspace,
  role,
  model,
  character,
  color,
  onName,
  onGroup,
  onWorkspace,
  onRole,
  onModel,
  onCharacter,
  onColor,
  models,
  loadingModels,
  submitLabel,
  onSubmit,
  submitting,
  submitDisabled,
  error,
}: {
  name: string;
  group: string;
  workspace: string;
  role: string;
  model: string;
  character: string;
  color: string;
  onName: (v: string) => void;
  onGroup: (v: string) => void;
  onWorkspace: (v: string) => void;
  onRole: (v: string) => void;
  onModel: (v: string) => void;
  onCharacter: (v: string) => void;
  onColor: (v: string) => void;
  models: ModelItem[];
  loadingModels: boolean;
  submitLabel: string;
  onSubmit: () => void;
  submitting: boolean;
  submitDisabled: boolean;
  error?: string;
}) {
  return (
    <div className="space-y-3 overflow-y-auto py-2 pr-1">
      <div>
        <label className="mb-1 block text-xs text-zinc-400">Name</label>
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="research-agent"
          className="border-zinc-800 bg-zinc-950 text-zinc-100"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-zinc-400">Group</label>
        <Input
          value={group}
          onChange={(e) => onGroup(e.target.value)}
          placeholder="research"
          className="border-zinc-800 bg-zinc-950 text-zinc-100"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-zinc-400">Workspace</label>
        <Input
          value={workspace}
          onChange={(e) => onWorkspace(e.target.value)}
          placeholder="solo"
          className="border-zinc-800 bg-zinc-950 text-zinc-100"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-zinc-400">Role</label>
        <Input
          value={role}
          onChange={(e) => onRole(e.target.value)}
          placeholder="planner"
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
      {error && <div className="text-xs text-destructive">{error}</div>}
      <Button
        onClick={onSubmit}
        disabled={submitDisabled || submitting}
        className="w-full"
      >
        {submitting ? 'Saving...' : submitLabel}
      </Button>
    </div>
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
        <div className="grid grid-cols-5 gap-2">
          {AGENT_CHARACTERS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onCharacter(c)}
              className={`rounded-xl p-1.5 transition-all ${
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
        <div className="flex gap-2">
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

export function AgentsPanel() {
  const { selectedAgentId, setSelectedAgentId } = useAgentSelection();
  const agents = useAgentsFeed();
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
  const [character, setCharacter] = useState(AGENT_CHARACTERS[0]);
  const [color, setColor] = useState(AGENT_AVATAR_DEFAULT_COLOR);
  const [creating, setCreating] = useState(false);

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

  const onCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const payload: {
        name: string;
        group?: string;
        workspace?: string;
        role?: string;
        model?: string;
        avatar: AgentAvatar;
      } = {
        name: name.trim(),
        avatar: { character, color },
      };
      if (group.trim()) payload.group = group.trim();
      if (workspace.trim()) payload.workspace = workspace.trim();
      if (role.trim()) payload.role = role.trim();
      if (model.trim()) payload.model = model.trim();
      const agent = await createAgent(payload);
      setSelectedAgentId(agent.id);
      setDialogOpen(false);
      setName('');
      setGroup('');
      setWorkspace('');
      setRole('');
      setModel('');
      setCharacter(AGENT_CHARACTERS[0]);
      setColor(AGENT_AVATAR_DEFAULT_COLOR);
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }, [
    name,
    group,
    workspace,
    role,
    model,
    character,
    color,
    setSelectedAgentId,
  ]);

  const toggleStartStop = useCallback(async (agent: AgentInfo) => {
    try {
      if (agent.status === 'online' || agent.status === 'busy') {
        await stopAgent(agent.id);
      } else {
        await startAgent(agent.id);
      }
    } catch (err) {
      console.error(err);
    }
  }, []);

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
      closeDeleteDialog();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : 'Failed to delete agent',
      );
    } finally {
      setDeleting(false);
    }
  }, [deleteDialog, deleteConfirm, closeDeleteDialog]);

  // --- Edit dialog state ---
  const [editDialog, setEditDialog] = useState<AgentInfo | null>(null);
  const [editName, setEditName] = useState('');
  const [editGroup, setEditGroup] = useState('');
  const [editWorkspace, setEditWorkspace] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editCharacter, setEditCharacter] = useState<string>(
    AGENT_CHARACTERS[0],
  );
  const [editColor, setEditColor] = useState(AGENT_AVATAR_DEFAULT_COLOR);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditDialog = useCallback((agent: AgentInfo) => {
    setEditDialog(agent);
    setEditName(agent.name);
    setEditGroup(agent.group ?? '');
    setEditWorkspace(agent.workspace);
    setEditRole(agent.role ?? '');
    setEditModel(agent.model);
    setEditCharacter(agent.avatar?.character ?? AGENT_CHARACTERS[0]);
    setEditColor(agent.avatar?.color ?? AGENT_AVATAR_DEFAULT_COLOR);
    setEditError('');
  }, []);

  const closeEditDialog = useCallback(() => {
    setEditDialog(null);
    setEditError('');
  }, []);

  const confirmEdit = useCallback(async () => {
    if (!editDialog) return;
    setSaving(true);
    setEditError('');
    try {
      await updateAgent(editDialog.id, {
        name: editName.trim() || undefined,
        group: editGroup.trim() || undefined,
        workspace: editWorkspace.trim() || undefined,
        role: editRole.trim() || undefined,
        model: editModel.trim() || undefined,
        avatar: { character: editCharacter, color: editColor },
      });
      closeEditDialog();
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : 'Failed to update agent',
      );
    } finally {
      setSaving(false);
    }
  }, [
    editDialog,
    editName,
    editGroup,
    editWorkspace,
    editRole,
    editModel,
    editCharacter,
    editColor,
    closeEditDialog,
  ]);

  return (
    <div className="flex h-full flex-col border-t border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-xs font-medium text-zinc-400">Agents</span>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              />
            }
          >
            + New
          </DialogTrigger>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
            </DialogHeader>
            <AgentForm
              name={name}
              group={group}
              workspace={workspace}
              role={role}
              model={model}
              character={character}
              color={color}
              onName={setName}
              onGroup={setGroup}
              onWorkspace={setWorkspace}
              onRole={setRole}
              onModel={setModel}
              onCharacter={setCharacter}
              onColor={setColor}
              models={models}
              loadingModels={loadingModels}
              submitLabel="Create agent"
              onSubmit={onCreate}
              submitting={creating}
              submitDisabled={!name.trim()}
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
          {agents.map((agent) => {
            const selected = agent.id === selectedAgentId;
            const isRunning =
              agent.status === 'online' || agent.status === 'busy';
            return (
              <ContextMenu key={agent.id}>
                <ContextMenuTrigger
                  render={
                    <li
                      className={`cursor-pointer px-3 py-2 transition-colors hover:bg-zinc-800 ${
                        selected ? 'bg-zinc-800' : ''
                      }`}
                      onClick={() => setSelectedAgentId(agent.id)}
                    />
                  }
                >
                  <div className="flex items-center gap-2.5">
                    {agent.avatar ? (
                      // Dot sits outside the clipped tile so it stays visible.
                      <div className="relative shrink-0 p-0.5">
                        <div
                          className="size-10 rounded-xl"
                          style={{
                            background: avatarTileBackground(
                              agent.avatar.color,
                            ),
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
                        {agent.group && (
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400">
                            {agent.group}
                          </span>
                        )}
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
                  {agent.currentTaskId && (
                    <div className="mt-1 text-xs text-zinc-500">
                      task {agent.currentTaskId.slice(0, 8)}
                    </div>
                  )}
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
        </ul>
      </div>

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
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editDialog?.name}</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Update the agent's configuration. Changes apply immediately.
            </DialogDescription>
          </DialogHeader>
          <AgentForm
            name={editName}
            group={editGroup}
            workspace={editWorkspace}
            role={editRole}
            model={editModel}
            character={editCharacter}
            color={editColor}
            onName={setEditName}
            onGroup={setEditGroup}
            onWorkspace={setEditWorkspace}
            onRole={setEditRole}
            onModel={setEditModel}
            onCharacter={setEditCharacter}
            onColor={setEditColor}
            models={models}
            loadingModels={loadingModels}
            submitLabel="Save changes"
            onSubmit={confirmEdit}
            submitting={saving}
            submitDisabled={false}
            error={editError}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
