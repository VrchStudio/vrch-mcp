// Only catalog invalidations travel on these streams. Grants, terminal events,
// operation responses and image bytes are never broadcast to other chats.
const notice = 'event: message\ndata: ' + JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'}) + '\n\n';
const headers = {'Content-Type':'text/event-stream', 'Cache-Control':'no-store', 'X-Accel-Buffering':'no', 'X-Content-Type-Options':'nosniff'};
export function catalogEvents(auth) {
  const reads = new Map(), listeners = new Map();
  function subscribe(request,response,identity,token) {
    if (!request.headers.accept?.includes('text/event-stream')) {response.writeHead(406).end();return;}
    const owner=JSON.stringify([identity.issuer,identity.oauthClientId,identity.principal]);
    if (listeners.size>=128 || [...listeners.values()].filter(v=>v===owner).length>=8) {response.writeHead(429,{'Retry-After':'30'}).end();return;}
    listeners.set(response,owner);
    response.writeHead(200,headers);
    // A reconnect may be to a different build than the prior stream.
    response.write('retry: 3000\n'+notice);
    const heartbeat=setInterval(()=>{
      try {auth.authenticate(token);if(response.writableLength>16384)throw Error();response.write(': keepalive\n\n');}
      catch {response.end();}
    },15000);
    heartbeat.unref();response.once('close',()=>{clearInterval(heartbeat);listeners.delete(response);});
  }
  function respond(message,reply,response) {
    // Old clients may have initialized before stand-alone SSE was available.
    // On their next authenticated call, invalidate on that POST itself. A
    // capabilities read is an explicit way to recover a missed notification.
    const ref=reply.result?.structuredContent?.connectionRef;
    if(message.method!=='tools/call'||typeof ref!=='string')return false;
    if(reads.has(ref)&&message.params?.name!=='ai_capabilities')return false;
    reads.set(ref,true);if(reads.size>4096)reads.delete(reads.keys().next().value);
    response.writeHead(200,headers);
    response.end(notice+'event: message\ndata: '+JSON.stringify(reply)+'\n\n');
    return true;
  }
  return {subscribe,respond,close(){for(const r of listeners.keys())r.end();}};
}
