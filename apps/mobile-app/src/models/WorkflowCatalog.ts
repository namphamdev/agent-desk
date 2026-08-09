// Workflow templates — port of WorkflowCatalog.swift.

export interface WorkflowDefinition {
  id: string;
  label: string;
  description: string;
  placeholder: string;
  template: string;
  needsPrRef: boolean;
}

function fillTemplate(tpl: string, task: string, prRef: string): string {
  const taskValue = task.trim().length === 0
    ? '(No extra task notes — use the workflow goal and inspect the project.)'
    : task.trim();
  const refValue = prRef.trim().length === 0
    ? '(No PR ref given — use the current branch or ask the user.)'
    : prRef.trim();
  return tpl
    .replaceAll('{{task}}', taskValue)
    .replaceAll('{{prRef}}', refValue);
}

export const WorkflowCatalog = {
  all: [
    {
      id: 'new_feature',
      label: 'New feature',
      description: 'Plan and implement a feature with tests and surgical diffs.',
      placeholder: 'What should we build?',
      template:
        '## Workflow: New feature\n\n### Task\n{{task}}\n\nHow to work:\n1. Inspect the project conventions and architecture.\n2. State assumptions and success criteria.\n3. Implement the smallest complete change.\n4. Verify with focused tests and project checks.',
      needsPrRef: false,
    },
    {
      id: 'bug_fix',
      label: 'Bug fix',
      description: 'Reproduce, fix surgically, and verify the root cause.',
      placeholder: 'What is broken?',
      template:
        '## Workflow: Bug fix\n\n### Bug report\n{{task}}\n\nReproduce the issue, identify the root cause, apply a surgical fix, and verify the regression.',
      needsPrRef: false,
    },
    {
      id: 'review_pr',
      label: 'Review PR',
      description: 'Review a pull request for correctness, security, and quality.',
      placeholder: 'What should the review focus on?',
      template:
        '## Workflow: Review PR\n\n### Pull request\n{{prRef}}\n\n### Review focus\n{{task}}\n\nReview correctness, security, regressions, tests, and code quality. Do not implement fixes.',
      needsPrRef: true,
    },
    {
      id: 'explore_feature',
      label: 'Explore feature',
      description: 'Map how an area works without editing unless requested.',
      placeholder: 'What area should we explore?',
      template:
        '## Workflow: Explore feature\n\n### Explore\n{{task}}\n\nTrace entry points, data flow, tests, and risks. Stay read-only unless asked to edit.',
      needsPrRef: false,
    },
  ] as WorkflowDefinition[],

  promptFor(workflow: WorkflowDefinition, task: string, prRef: string): string {
    return fillTemplate(workflow.template, task, prRef);
  },
};
