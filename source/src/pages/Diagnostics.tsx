import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ClipboardCopy,
  FolderOpen,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge, Textarea } from "@/components/ui/primitives";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/PageHeader";
import { cn } from "@/lib/utils";

/** Bytes as something a person can read. Binary units, matching Explorer. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function statusTone(s: string) {
  if (s === "ok") return "ok" as const;
  if (s === "warn") return "warn" as const;
  if (s === "error") return "bad" as const;
  return "neutral" as const;
}

export function DiagnosticsPage() {
  const qc = useQueryClient();
  const [report, setReport] = useState("");
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: ["providerStatus"],
    queryFn: api.providerStatus,
  });
  // Makes the session-only claim checkable rather than asserted: this number
  // grows while reading and the directory is gone after the app closes.
  const storage = useQuery({
    queryKey: ["storageUsage"],
    queryFn: api.storageUsage,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api.healthCheck(false),
  });
  const stats = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const dataDir = useQuery({ queryKey: ["dataDir"], queryFn: api.dataDir });
  const authEnv = useQuery({
    queryKey: ["authEnv"],
    queryFn: api.authEnvPresent,
  });
  // Asked of the backend rather than hard-coded here. A capability table kept
  // by hand in the interface is one that drifts the moment the pinned build
  // changes, and drifting the wrong way means offering a control that cannot
  // work.
  const caps = useQuery({
    queryKey: ["providerCapabilities"],
    queryFn: api.providerCapabilities,
  });

  const runCheck = useMutation({
    mutationFn: () => api.healthCheck(true),
    onSuccess: (r) => qc.setQueryData(["health"], r),
  });

  const reconnect = useMutation({
    mutationFn: () => api.reconnect(),
    onSuccess: (s) => {
      qc.setQueryData(["providerStatus"], s);
      void qc.invalidateQueries({ queryKey: ["feed"] });
    },
  });

  const buildReport = useMutation({
    mutationFn: () => api.diagnosticsReport(),
    onSuccess: (r) => setReport(r),
  });

  const clearCache = useMutation({
    mutationFn: () => api.clearCache(),
    onSuccess: () => {
      void qc.invalidateQueries();
    },
  });

  const twitter = health.data?.channels.find((c) => c.key === "twitter");

  return (
    <>
      <PageHeader
        title="Diagnostics"
        subtitle="Everything about the data path, in plain language"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => runCheck.mutate()}
            disabled={runCheck.isPending}
          >
            <RefreshCw
              className={runCheck.isPending ? "animate-spin" : undefined}
            />
            Run health check
          </Button>
        }
      />

      <div className="px-6 py-5 max-w-[920px] mx-auto w-full space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader
              title="Active data path"
              icon={<Activity className="size-4" />}
            />
            <CardBody>
              <dl className="text-[13px] space-y-2">
                <Row
                  label="Provider in use"
                  value={status.data?.activeProvider ?? "—"}
                  // `usingMock` can only be true in a dev-mock build, which is
                  // exactly when it deserves a warning colour.
                  tone={status.data?.usingMock ? "warn" : "ok"}
                />
                <Row
                  label="Session storage"
                  value={
                    storage.data
                      ? storage.data.inMemory
                        ? "in memory only"
                        : `${formatBytes(storage.data.bytes)} — deleted on exit`
                      : "—"
                  }
                />
                <Row
                  label="X backend"
                  value={status.data?.activeBackend ?? "not checked yet"}
                />
                <Row
                  label="Authenticated"
                  value={status.data?.authenticated ? "yes" : "no"}
                  tone={status.data?.authenticated ? "ok" : "warn"}
                />
                <Row
                  label="twitter-cli"
                  value={status.data?.twitterCliVersion ?? "not installed"}
                />
                <Row
                  label="Agent Reach"
                  value={status.data?.agentReachVersion ?? "not installed"}
                />
                <Row
                  label="Last health check"
                  value={health.data?.checkedAt?.slice(0, 19) ?? "—"}
                />
              </dl>
              <p className="text-[12.5px] text-ink-dim mt-3">
                {status.data?.message}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Backend capabilities"
              subtitle="What the pinned twitter-cli build can actually do. Read from the backend, not assumed."
              icon={<Activity className="size-4" />}
            />
            <CardBody>
              <dl className="text-[13px] space-y-2">
                {/* No search rows. The app has no free-text path into X at
                    all, so what the CLI could do there is not a capability of
                    this build — reporting it would describe a feature the
                    reader cannot reach. */}
                <Capability label="Feed pagination" on={caps.data?.feedCursor} />
                <Capability label="List pagination" on={caps.data?.listCursor} />
                <Capability
                  label="Followed-account pagination"
                  on={caps.data?.followingCursor}
                  why="The command gathers the whole requested count before returning."
                />
                <Capability
                  label="Promoted flag"
                  on={caps.data?.promotedFlag}
                />
                <Capability label="Follow" on={caps.data?.follow} />
                <Capability label="Unfollow" on={caps.data?.unfollow} />
                <Capability
                  label="Unbookmark"
                  on={caps.data?.unbookmark}
                  why="Available only from Bookmarks after an explicit confirmation."
                />
                {/* Read from the backend rather than hardcoded here. These are
                    false on the pinned build, and saying so beats offering a
                    control somewhere that could only ever fail. */}
                <Capability
                  label="Mute"
                  on={caps.data?.mute}
                  why="Not a command in this build. No action is offered anywhere."
                />
                <Capability
                  label="Block"
                  on={caps.data?.block}
                  why="Not a command in this build. No action is offered anywhere."
                />
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Storage"
              icon={<FolderOpen className="size-4" />}
            />
            <CardBody>
              <dl className="text-[13px] space-y-2">
                <Row
                  label="Cached posts"
                  value={String(stats.data?.totalPosts ?? 0)}
                />
                <Row
                  label="Unread"
                  value={String(stats.data?.unreadCount ?? 0)}
                />
                <Row
                  label="Hidden"
                  value={String(stats.data?.hiddenCount ?? 0)}
                />
                <Row
                  label="Last sync"
                  value={stats.data?.lastSync?.slice(0, 19) ?? "never"}
                />
              </dl>
              <p className="text-[11.5px] text-ink-mute mt-3 break-all">
                {dataDir.data}
              </p>
              <div className="flex gap-2 mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => reconnect.mutate()}
                  disabled={reconnect.isPending}
                >
                  <KeyRound />
                  Reconnect provider
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => clearCache.mutate()}
                  disabled={clearCache.isPending}
                >
                  <Trash2 />
                  Clear cache
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* Credentials — presence only, never values */}
        <Card>
          <CardHeader
            title="Credentials"
            subtitle="Presence only. Focus Feed Next never reads, stores or logs these values."
            icon={<ShieldCheck className="size-4" />}
          />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {(authEnv.data ?? []).map(([name, present]) => (
                <Badge key={name} tone={present ? "ok" : "neutral"}>
                  {name}: {present ? "set" : "not set"}
                </Badge>
              ))}
            </div>
            {!status.data?.authenticated ? (
              <p className="text-[12.5px] text-ink-dim mt-3">
                To use live data, sign in on a dedicated burner X account, then
                set
                <code className="mx-1 px-1 rounded bg-surface-3 text-ink">
                  TWITTER_AUTH_TOKEN
                </code>
                and
                <code className="mx-1 px-1 rounded bg-surface-3 text-ink">
                  TWITTER_CT0
                </code>
                as environment variables and press Reconnect provider.
              </p>
            ) : null}
          </CardBody>
        </Card>

        {/* Channel health */}
        <Card>
          <CardHeader
            title="Agent Reach channels"
            subtitle={
              health.data?.agentReachInstalled
                ? `Agent Reach ${health.data.agentReachVersion ?? ""}`
                : "Agent Reach is not installed"
            }
            icon={<Activity className="size-4" />}
            action={
              twitter ? (
                <Badge tone={statusTone(twitter.status)}>
                  X: {twitter.status}
                </Badge>
              ) : null
            }
          />
          <CardBody>
            {health.data?.error ? (
              <p className="text-[12.5px] text-bad mb-2">{health.data.error}</p>
            ) : null}
            {health.data && health.data.channels.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-ink-mute text-left">
                      <th className="py-1.5 pr-3 font-medium">Channel</th>
                      <th className="py-1.5 pr-3 font-medium">Status</th>
                      <th className="py-1.5 pr-3 font-medium">
                        Active backend
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-ink-dim">
                    {health.data.channels.map((c) => (
                      <tr key={c.key} className="border-t border-edge">
                        <td className="py-1.5 pr-3 text-ink">{c.key}</td>
                        <td className="py-1.5 pr-3">
                          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                        </td>
                        <td className="py-1.5 pr-3">
                          {c.activeBackend ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-[12.5px] text-ink-mute">
                No channel report yet. Press Run health check.
              </p>
            )}
          </CardBody>
        </Card>

        {/* Sanitized report */}
        <Card>
          <CardHeader
            title="Sanitized diagnostic report"
            subtitle="Safe to share — cookies and tokens can never appear here"
            icon={<ClipboardCopy className="size-4" />}
            action={
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => buildReport.mutate()}
                >
                  Generate
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!report}
                  onClick={() => {
                    void navigator.clipboard?.writeText(report);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            }
          />
          <CardBody>
            <Textarea
              value={report}
              readOnly
              rows={report ? 16 : 4}
              placeholder="Press Generate to build a report you can paste into a bug report…"
              className="font-mono text-[11.5px] leading-relaxed"
              aria-label="Diagnostic report"
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

/**
 * One backend capability, with the reason when it is unavailable.
 *
 * An unsupported capability says so plainly and explains why. The alternative —
 * omitting it, or showing a greyed-out control elsewhere in the interface —
 * leaves somebody hunting for a feature that was never going to work.
 */
function Capability({
  label,
  on,
  why,
}: {
  label: string;
  on: boolean | undefined;
  why?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-ink-mute">
        {label}
        {!on && why ? (
          <span className="block text-[11.5px] text-ink-mute/70">{why}</span>
        ) : null}
      </dt>
      <dd
        className={cn(
          "shrink-0",
          on === undefined ? "text-ink-mute" : on ? "text-ok" : "text-warn",
        )}
      >
        {on === undefined ? "—" : on ? "Available" : "Unavailable"}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-mute">{label}</dt>
      <dd
        className={cn(
          "text-right truncate max-w-[60%]",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
          !tone && "text-ink-dim",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
