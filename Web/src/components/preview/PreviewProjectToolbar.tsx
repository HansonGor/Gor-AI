import type { PreviewTemplate } from '../../preview/core/types';
import { Button } from '../ui/button';

interface PreviewProjectToolbarProps {
  template: PreviewTemplate;
  hasSelectedFile: boolean;
  onCreateProject: (template: PreviewTemplate) => void;
  onCreateTestFile: () => void;
  onDeleteSelected: () => void;
  onReset: () => void;
}

export default function PreviewProjectToolbar({
  template,
  hasSelectedFile,
  onCreateProject,
  onCreateTestFile,
  onDeleteSelected,
  onReset,
}: PreviewProjectToolbarProps) {
  return (
    <div className="preview-project-toolbar">
      <label>
        <span>Template</span>
        <select
          value={template}
          onChange={(event) => onCreateProject(event.target.value as PreviewTemplate)}
        >
          <option value="react">React</option>
          <option value="html">HTML</option>
        </select>
      </label>
      <Button type="button" variant="outline" size="sm" onClick={onCreateTestFile}>
        New Test File
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onDeleteSelected}
        disabled={!hasSelectedFile}
      >
        Delete Selected
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onReset}>
        Reset Project
      </Button>
    </div>
  );
}
