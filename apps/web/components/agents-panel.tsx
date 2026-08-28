'use client';

import { PencilIcon, PlayIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  useAgentSelection,
  useAgentsFeed,
  useAgentUsage,
} from '@/components/agent-context';
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

// Kimi-k2p7-code context window.
const CONTEXT_WINDOW = 262144;

function formatContextLeft(u: {
  inputTokens: number;
  outputTokens: number;
}): string {
  const used = u.inputTokens + u.outputTokens;
  const left = Math.max(0, CONTEXT_WINDOW - used);
  if (left >= 1000) return `${Math.round(left / 1000)}k ctx left`;
  return `${left} ctx left`;
}

export function AgentsPanel() {
  const { selectedAgentId, setSelectedAgentId } = useAgentSelection();
  const agents = useAgentsFeed();
  const { usage } = useAgentUsage();
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [role, setRole] = useState('');
  const [model, setModel] = useState('');
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
      } = { name: name.trim() };
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
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }, [name, group, workspace, role, model, setSelectedAgentId]);

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
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const openEditDialog = useCallback((agent: AgentInfo) => {
    setEditDialog(agent);
    setEditName(agent.name);
    setEditGroup(agent.group ?? '');
    setEditWorkspace(agent.workspace);
    setEditRole(agent.role ?? '');
    setEditModel(agent.model);
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
          <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100">
            <DialogHeader>
              <DialogTitle>New agent</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="research-agent"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  Group
                </label>
                <Input
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder="research"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">
                  Workspace
                </label>
                <Input
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value)}
                  placeholder="solo"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-400">Role</label>
                <Input
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder="planner"
                  className="border-zinc-800 bg-zinc-950 text-zinc-100"
                />
              </div>
              <ModelPickerModal
                models={models}
                value={model}
                onChange={setModel}
                loading={loadingModels}
                allowManual={models.length === 0}
                placeholder="Default"
              />
              <Button
                onClick={onCreate}
                disabled={!name.trim() || creating}
                className="w-full"
              >
                {creating ? 'Creating...' : 'Create agent'}
              </Button>
            </div>
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
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${statusColor(
                          agent.status,
                        )} ${isPulsing(agent.status) ? 'status-pulse' : ''}`}
                      />
                      <span className="truncate text-sm font-medium text-zinc-200">
                        {agent.name}
                      </span>
                    </div>

                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
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
                    {usage[agent.id] && (
                      <span className="font-mono text-zinc-600">
                        {formatContextLeft(usage[agent.id]!)}
                      </span>
                    )}
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
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editDialog?.name}</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Update the agent's configuration. Changes apply immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Name</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="research-agent"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Group</label>
              <Input
                value={editGroup}
                onChange={(e) => setEditGroup(e.target.value)}
                placeholder="research"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">
                Workspace
              </label>
              <Input
                value={editWorkspace}
                onChange={(e) => setEditWorkspace(e.target.value)}
                placeholder="solo"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-zinc-400">Role</label>
              <Input
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                placeholder="planner"
                className="border-zinc-800 bg-zinc-950 text-zinc-100"
              />
            </div>
            <ModelPickerModal
              models={models}
              value={editModel}
              onChange={setEditModel}
              loading={loadingModels}
              allowManual={models.length === 0}
              placeholder="Default"
            />
            {editError && (
              <div className="text-xs text-destructive">{editError}</div>
            )}
            <Button onClick={confirmEdit} disabled={saving} className="w-full">
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
