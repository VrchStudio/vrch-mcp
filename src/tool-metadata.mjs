// These hints describe effects; they do not grant device permissions.
const readOnly = new Set([
  'apps_list', 'apps_state', 'apps_operation_status', 'apps_input_targets',
  'apps_export_begin', 'apps_file_export', 'ai_capabilities', 'terminal_events',
  'take_screenshot'
]);
const destructive = new Set([
  'apps_publish', 'apps_save', 'apps_import_commit', 'apps_file_commit',
  'apps_exit', 'apps_preview_input', 'apps_control', 'apps_interface_input', 'apps_host_input',
  'terminal_input', 'terminal_run_private'
]);
const idempotent = new Set([
  'apps_list', 'apps_state', 'apps_operation_status', 'apps_input_targets',
  'ai_capabilities', 'terminal_disconnect', 'file_pause', 'file_cancel'
]);

export function toolAnnotations(name) {
  return {
    readOnlyHint: readOnly.has(name),
    destructiveHint: destructive.has(name),
    idempotentHint: idempotent.has(name),
    openWorldHint: true
  };
}
