import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { isTaskAssignment, type TaskAssignmentMessage } from '../../utils/teammateMailbox.js';
type Props = {
  assignment: TaskAssignmentMessage;
};

/**
 * Renders a task assignment with a full-rectangle cyan border and a
 * `─ TASK #N ASSIGNED BY X ─` breach-edge title.
 */
export function TaskAssignmentDisplay(t0) {
  const $ = _c(9);
  const {
    assignment
  } = t0;
  let t2;
  if ($[3] !== assignment.subject) {
    t2 = <Box><Text bold={true}>{assignment.subject}</Text></Box>;
    $[3] = assignment.subject;
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  let t3;
  if ($[5] !== assignment.description) {
    t3 = assignment.description && <Box marginTop={1}><Text color="gray">{assignment.description}</Text></Box>;
    $[5] = assignment.description;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  const borderTitle = ` TASK #${assignment.taskId} ASSIGNED BY ${assignment.assignedBy.toUpperCase()} `;
  let t4;
  if ($[7] !== borderTitle || $[8] !== t2 || $[0] !== t3) {
    t4 = <Box flexDirection="column" marginY={1}><Box borderStyle="single" borderColor="cyan_FOR_SUBAGENTS_ONLY" borderText={{ content: borderTitle, position: 'top', align: 'start', offset: 1 }} flexDirection="column" paddingX={1} paddingY={0}>{t2}{t3}</Box></Box>;
    $[7] = borderTitle;
    $[8] = t2;
    $[0] = t3;
    $[1] = t4;
  } else {
    t4 = $[1];
  }
  return t4;
}

/**
 * Try to parse and render a task assignment message from raw content.
 */
export function tryRenderTaskAssignmentMessage(content: string): React.ReactNode | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return <TaskAssignmentDisplay assignment={assignment} />;
  }
  return null;
}

/**
 * Get a brief summary text for a task assignment message.
 */
export function getTaskAssignmentSummary(content: string): string | null {
  const assignment = isTaskAssignment(content);
  if (assignment) {
    return `[Task Assigned] #${assignment.taskId} - ${assignment.subject}`;
  }
  return null;
}
