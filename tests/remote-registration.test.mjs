import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer, request} from 'node:http';
import {auth as sdkAuthorize} from '@modelcontextprotocol/sdk/client/auth.js';
import {createRemoteHTTPHandler} from '../src/remote-http.mjs';
const supported=Number(process.versions.node.split('.')[0])>22||Number(process.versions.node.split('.')[1])>=13;
const {createPairingAuthorization}=supported?await import('../src/remote-auth.mjs'):{};
const issuer='https://mcp-sg.example',resource=issuer+'/synth',redirect='https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-fixture-mcp-sg_vrch_ai';
const staticId='https://chatgpt.com/oauth/client.json';
const clients=new Map([[staticId,{tokenEndpointAuthMethod:'none',redirectUris:['https://chatgpt.com/connector_platform_oauth_redirect']}]]);
const config={issuer,resource,clients,verifyPairing:async(expected,proof)=>{assert.equal(proof.challenge,expected.challenge);return{deviceId:'fixture-device'};}};
const registration=method=>({redirect_uris:[redirect],token_endpoint_auth_method:method,grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:'vrch:mcp'});
const verifier=()=>randomBytes(32).toString('base64url');
const params=(id,proof,uri=redirect)=>({client_id:id,redirect_uri:uri,resource,scope:'vrch:mcp',response_type:'code',state:'fixture-state',code_challenge_method:'S256',code_challenge:createHash('sha256').update(proof).digest('base64url')});
async function code(auth,id,secret,uri=redirect){const start=auth.begin(params(id,secret,uri));await auth.approve(start.id,{challenge:auth.challenge(start.id).challenge});return new URL(auth.finish(start.id,start.browserSecret).redirect).searchParams.get('code');}

test('Google DCR validates callbacks/metadata and registration alone authorizes no resource', {skip:!supported},()=>{
 const auth=createPairingAuthorization({...config,filename:':memory:'});try{
  assert.equal(auth.metadata().registration_endpoint,issuer+'/register');
  for(const uri of ['http://oauth-redirect.googleusercontent.com/r/a','https://oauth-redirect.googleusercontent.com.evil.example/r/a','https://evil.example/r/a','https://oauth-redirect.googleusercontent.com@evil.example/r/a',redirect+'?next=https://evil.example',redirect+'#fragment','https://oauth-redirect.googleusercontent.com/r/../a/x','https://oauth-redirect.googleusercontent.com/r/%2e%2e/x','https://oauth-redirect.googleusercontent.com/unknown/x'])assert.throws(()=>auth.register({...registration('none'),redirect_uris:[uri]}),{code:'invalid_redirect_uri'});
  for(const value of [null,[],{...registration('none'),grant_types:['client_credentials']},{...registration('none'),scope:'admin'},{...registration('none'),response_types:['token']},{...registration('none'),token_endpoint_auth_method:'wrong'}])assert.throws(()=>auth.register(value));
  for(const host of ['oauth-redirect.googleusercontent.com','oauth-redirect-sandbox.googleusercontent.com','oauth-redirect-test.googleusercontent.com'])for(const path of ['r','a'])assert(auth.register({...registration('none'),redirect_uris:[`https://${host}/${path}/fixture`]}).client_id);
  const r=auth.register({redirect_uris:[redirect],client_name:'Pretend verified identity',logo_uri:'http://127.0.0.1/private'});
  assert.equal(r.token_endpoint_auth_method,'client_secret_basic');assert(r.client_secret);assert(!r.client_name&&!r.logo_uri);
  assert.throws(()=>auth.authenticate(r.client_secret),{code:'invalid_token'});
  assert.throws(()=>auth.begin({...params(r.client_id,verifier()),redirect_uri:redirect+'-different'}),{code:'invalid_redirect_uri'});
 }finally{auth.close();}
});

test('DCR client authentication, PKCE, refresh/revoke and existing grants survive restart without stored plaintext secrets', {skip:!supported},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vrch-dcr-')),filename=join(dir,'auth.sqlite');let auth=createPairingAuthorization({...config,filename});
 try{
  const v=verifier(),oldCode=await code(auth,staticId,v,clients.get(staticId).redirectUris[0]);
  const old=auth.exchange({grant_type:'authorization_code',client_id:staticId,code:oldCode,code_verifier:v,redirect_uri:clients.get(staticId).redirectUris[0],resource});
  const oldIdentity=auth.authenticate(old.access_token);
  for(const method of ['none','client_secret_basic','client_secret_post']){
   const r=auth.register(registration(method)),v=verifier();
   const basic=method==='client_secret_basic'?{id:r.client_id,secret:r.client_secret}:undefined;
   const credentials={client_id:r.client_id,...(method==='client_secret_post'?{client_secret:r.client_secret}:{})};
   const c=await code(auth,r.client_id,v);
   const exchange={...credentials,grant_type:'authorization_code',resource,code:c,code_verifier:v,redirect_uri:redirect};
   assert.throws(()=>auth.exchange({...exchange,code_verifier:verifier()},basic),{code:'invalid_grant'});
   if(method!=='none')assert.throws(()=>auth.exchange({...exchange,client_secret:undefined},undefined),{code:'invalid_client'});
   if(basic){assert.throws(()=>auth.exchange({...exchange,client_secret:r.client_secret},basic),{code:'invalid_client'});assert.throws(()=>auth.exchange(exchange,{...basic,secret:'wrong'}),{code:'invalid_client'});}
   if(method==='client_secret_post')assert.throws(()=>auth.exchange({...exchange,client_secret:'wrong'}),{code:'invalid_client'});
   auth.close();auth=createPairingAuthorization({...config,filename});
   const tokens=auth.exchange(exchange,basic);assert(tokens.access_token&&tokens.refresh_token);
   assert.equal(auth.authenticate(tokens.access_token).oauthClientId,r.client_id);
   if(r.client_secret)assert(!readFileSync(filename).includes(Buffer.from(r.client_secret)));
   const next=auth.exchange({...credentials,resource,grant_type:'refresh_token',refresh_token:tokens.refresh_token},basic);
   auth.revoke(next.refresh_token,r.client_id,{params:credentials,basic});assert.throws(()=>auth.authenticate(next.access_token));
   assert.deepEqual(auth.authenticate(old.access_token),oldIdentity);
  }
  const r=auth.register({redirect_uris:[redirect],token_endpoint_auth_method:'none'}),proof=verifier();
  const tokens=auth.exchange({client_id:r.client_id,resource,grant_type:'authorization_code',code:await code(auth,r.client_id,proof),code_verifier:proof,redirect_uri:redirect});assert(!tokens.refresh_token);
 }finally{auth.close();rmSync(dir,{recursive:true,force:true});}
});

test('official SDK discovers DCR over real HTTP and completes PKCE with generated client credentials', {skip:!supported},async()=>{
 const auth=createPairingAuthorization({...config,filename:':memory:'});let calls=0;
 const diagnostics=[];
 const handler=createRemoteHTTPHandler({auth,resource,handleMCP:async()=>{calls++;return{};},onRegistrationFailure:value=>diagnostics.push(value)}),server=createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address='http://127.0.0.1:'+server.address().port;
 const fetchFn=(url,init={})=>new Promise((resolve,reject)=>{
  const target=new URL(url);assert.equal(target.origin,issuer);
  const req=request(address+target.pathname+target.search,{method:init.method||'GET',headers:{...Object.fromEntries(new Headers(init.headers)),Host:new URL(issuer).host}},res=>{
   let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(new Response(text||null,{status:res.statusCode,headers:res.headers})));
  });req.on('error',reject);req.end(init.body?.toString()||'');
 });
 try{
  for(const method of ['none','client_secret_basic','client_secret_post']){
   let info,tokens,proof,authorization;
   const provider={redirectUrl:redirect,clientMetadata:registration(method),clientInformation:()=>info,saveClientInformation:v=>{info=v;},tokens:()=>tokens,saveTokens:v=>{tokens=v;},codeVerifier:()=>proof,saveCodeVerifier:v=>{proof=v;},redirectToAuthorization:url=>{authorization=url;},state:()=> 'fixture-state'};
   assert.equal(await sdkAuthorize(provider,{serverUrl:resource,fetchFn}),'REDIRECT');assert(info.client_id.startsWith('vrch_dcr_'));
   const start=await fetchFn(authorization),pair=start.headers.get('location');assert.equal(start.status,303);
   const cookie=start.headers.get('set-cookie').split(';')[0],challenge=await(await fetchFn(issuer+pair+'/challenge')).json();
   await auth.approve(challenge.pairingId,{challenge:challenge.challenge});
   const finish=await(await fetchFn(issuer+pair+'/status',{method:'POST',headers:{Cookie:cookie,Origin:issuer}})).json();
   const c=new URL(finish.redirect).searchParams.get('code');
   assert.equal(await sdkAuthorize(provider,{serverUrl:resource,authorizationCode:c,fetchFn}),'AUTHORIZED');assert(tokens.access_token);
   assert.equal(auth.authenticate(tokens.access_token).oauthClientId,info.client_id);
   const basic=method==='client_secret_basic'?'Basic '+Buffer.from(info.client_id+':'+info.client_secret).toString('base64'):undefined;
   const body=new URLSearchParams({token:tokens.refresh_token,...(basic?{}:{client_id:info.client_id,...(method==='client_secret_post'?{client_secret:info.client_secret}:{})})});
   assert.equal((await fetchFn(issuer+'/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...(basic?{Authorization:basic}:{})},body})).status,200);
   assert.throws(()=>auth.authenticate(tokens.access_token));
  }
  assert.equal(calls,0,'Registering and linking alone execute no device tool');
  const rejected=await fetchFn(issuer+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:['https://evil.example/r/private-account?secret=private-query'],client_secret:'private-secret'})});
  assert.equal(rejected.status,400);assert.equal(diagnostics.at(-1).redirects[0].host,'evil.example');
  for(const secret of ['private-account','private-query','private-secret'])assert(!JSON.stringify(diagnostics).includes(secret));
  assert.equal((await fetchFn(issuer+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await fetchFn(issuer+'/register',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(8193)})).status,400);
 }finally{auth.close();await new Promise(resolve=>server.close(resolve));}
});


test('abandoned registrations expire without removing a grant or an in-flight pairing', {skip:!supported},async()=>{
 let time=1000000000;const auth=createPairingAuthorization({...config,filename:':memory:',clock:()=>time});
 try{
  const unused=auth.register(registration('none')),active=auth.register(registration('none')),pending=auth.register(registration('none'));
  const v=verifier();auth.exchange({client_id:active.client_id,grant_type:'authorization_code',resource,code:await code(auth,active.client_id,v),code_verifier:v,redirect_uri:redirect});
  time+=86395000;auth.begin(params(pending.client_id,verifier()));
  time+=10000;auth.register(registration('none'));
  assert.throws(()=>auth.begin(params(unused.client_id,verifier())),{code:'invalid_client'});
  assert(auth.begin(params(active.client_id,verifier())).id);assert(auth.begin(params(pending.client_id,verifier())).id);
 }finally{auth.close();}
});
