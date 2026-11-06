// Browser-local observation is distinct from a native page or device screenshot.
export const browserObservationTool = {
  name: 'apps_observe',
  description: 'Observe the exact active web Preview or browser Simulator instance without screen sharing. Returns derived DOM/layout, readable Canvas pixel layers and App-reported logs. Canvas images are separate layers, not a full screenshot; CSS/SVG rendering and missing/tainted layers are not inferred. Requires this connection’s current AI approval, control and exact Preview binding. Does not capture the device desktop or another tab.',
  annotations: {readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:true},
  inputSchema: {type:'object', properties:{workspaceId:{type:'string'},instanceId:{type:'string'},generation:{type:'integer',minimum:1},expectedRevision:{type:'string'},maxSide:{type:'integer',minimum:1,maximum:1024}}, required:['workspaceId','instanceId','generation','expectedRevision'], additionalProperties:false}
};
export function browserCapabilities(value) {
  const apps=value?.apps===true;
  return {...value, targetKind:'browser', terminal:false, privateCommand:false, cancelPrivateInput:false,
    desktopInput:false, screenshots:false, appLifecycle:false, files:[], controlTargets:apps?['preview']:[],hostMenus:[],
    workspaceText:{read:apps,write:apps,maxBytes:65536,readTool:'apps_read_text',writeTool:'apps_write_text',referenceTool:'apps_sdk_reference'},
    observation:{available:apps,tool:'apps_observe',sources:['dom-layout','canvas-pixels','app-reported-logs'],fullScreenshot:false}};
}
