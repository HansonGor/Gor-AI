export interface ProjectChangesProps {
  changes: ReadonlyArray<{ path: string; diff?: string }>;
  title: string;
  label: string;
  restored?: boolean;
}

/** Shared presentation only: the host supplies changes, never a filesystem API. */
export default function ProjectChanges({ changes, title, label, restored = false }: ProjectChangesProps) {
  if (!changes.length) return null;
  return (
    <div className="project-changes" aria-label={label}>
      <div className="project-changes-title">{title}</div>
      {changes.map((change, index) => (
        <details key={`${change.path}-${index}`} className="project-change">
          <summary>{restored ? change.path : `${change.path} · 查看 diff`}</summary>
          {change.diff && <pre>{change.diff}</pre>}
        </details>
      ))}
    </div>
  );
}
