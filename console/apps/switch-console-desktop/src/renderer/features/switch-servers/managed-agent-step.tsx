import { CircleCheck, Cloud, GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Spinner } from '@renderer/lib/ui/spinner';

const MODELS = [
  { value: 'default', label: 'Claude default' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
];
type Repository = { value: string; label: string };

export function ManagedAgentStep({
  serverId,
  onBack,
  onFinish,
}: {
  serverId: string;
  onBack: () => void;
  onFinish: () => void;
}) {
  const [name, setName] = useState('');
  const [model, setModel] = useState('default');
  const [repository, setRepository] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [claude, github] = await Promise.all([
          rpc.switchServers.getClaudeConnection(serverId),
          rpc.switchServers.getGitHubConnection(serverId),
        ]);
        if (!alive) return;
        if (claude.status !== 'connected')
          throw new Error('Connect Claude Code before setting up your agent.');
        if (github.status !== 'connected')
          throw new Error('Connect GitHub before setting up your agent.');
        const items = github.installations.flatMap((installation) =>
          installation.repositories.map((repo) => ({
            value: `${installation.id}:${repo.id}`,
            label: repo.name,
          }))
        );
        if (!items.length) throw new Error('Choose at least one repository in GitHub to continue.');
        setRepositories(items);
        if (items.length === 1) setRepository(items[0].value);
      } catch (cause) {
        if (alive)
          setError(failureText(cause, 'Could not load your connections. Go back and try again.'));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [serverId]);
  const selectedRepository = repositories.find((item) => item.value === repository);
  const canReview = !loading && !error && !!name.trim() && !!selectedRepository;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{review ? 'Review your cloud agent' : 'Create your cloud agent'}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-5 pt-0">
        <p className="text-sm text-foreground-muted">
          {review
            ? 'Check the details before your agent is launched.'
            : 'Give your agent a name and choose where it will work.'}
        </p>
        {loading ? (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Spinner /> Loading your connections…
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : review ? (
          <>
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex items-center gap-3">
                <Cloud className="size-5 text-foreground-muted" />
                <h3 className="font-medium break-all">{name.trim()}</h3>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-foreground-muted">Provider</dt>
                <dd>Claude Code</dd>
                <dt className="text-foreground-muted">Model</dt>
                <dd>{MODELS.find((item) => item.value === model)?.label}</dd>
                <dt className="text-foreground-muted">Repository</dt>
                <dd className="break-all">{selectedRepository?.label}</dd>
              </dl>
            </div>
            <p className="flex items-center gap-2 text-sm">
              <CircleCheck className="size-4 text-foreground-success" /> Claude and GitHub are
              connected
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
              <CircleCheck className="size-4 text-foreground-success" />
              <span className="font-medium">Claude Code</span>
              <span className="ml-auto text-xs text-foreground-muted">Connected</span>
            </div>
            <Field>
              <FieldLabel htmlFor="managed-agent-name">Agent name</FieldLabel>
              <Input
                id="managed-agent-name"
                placeholder="e.g. Code helper"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldDescription>The name you’ll see in Switch and your chats.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="managed-agent-model">Model</FieldLabel>
              <Select
                items={MODELS}
                value={model}
                onValueChange={(value) => {
                  if (value) setModel(value);
                }}
              >
                <SelectTrigger id="managed-agent-model" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Claude default uses the model selected by Claude Code for your account.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="managed-agent-repository">Repository</FieldLabel>
              <Select items={repositories} value={repository} onValueChange={setRepository}>
                <SelectTrigger id="managed-agent-repository" className="w-full">
                  <GitBranch className="size-4 text-foreground-muted" />
                  <SelectValue placeholder="Choose a repository" />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Only repositories shared with Switch on GitHub appear here.
              </FieldDescription>
            </Field>
          </>
        )}
        <div className="rounded-lg bg-background-1 p-3 text-xs text-foreground-muted">
          <span className="font-medium text-foreground">Setup preview.</span> Cloud agent launch is
          not available yet. These details are not saved, and no worker will be started.
        </div>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={() => (review ? setReview(false) : onBack())}>
          {review ? 'Edit details' : 'Back'}
        </Button>
        <Button variant="ghost" onClick={onFinish}>
          Close preview
        </Button>
        {review ? (
          <Button disabled>Create cloud agent</Button>
        ) : (
          <Button disabled={!canReview} onClick={() => setReview(true)}>
            Review agent
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
