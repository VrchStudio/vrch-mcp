import {observationTool} from './observe.mjs';
export const browserObservationTool = observationTool;
export function browserCapabilities(value) {
  const apps=value?.apps===true;
  return {...value, targetKind:'browser', terminal:false, privateCommand:false, cancelPrivateInput:false,
    desktopInput:false, screenshots:false, appLifecycle:false, files:[], controlTargets:apps?['preview']:[],hostMenus:[],
    workspaceText:{read:apps,write:apps,maxBytes:65536,readTool:'apps_read_text',writeTool:'apps_write_text',referenceTool:'apps_sdk_reference'},
    observation:{available:apps,tool:'apps_observe',sources:['dom-layout','canvas-pixels','app-reported-logs'],fullScreenshot:false}};
}
