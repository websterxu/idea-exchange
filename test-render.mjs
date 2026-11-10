import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';

const origin = 'https://forum.example.test';
process.env.FORUM_DATA_DIR = mkdtempSync(join(tmpdir(),'idea-exchange-test-'));
process.env.PUBLIC_ORIGIN = origin;
process.env.SESSION_SECRET = 'test-only-session-secret-with-at-least-32-characters';
process.env.GITHUB_CLIENT_ID = 'test-client';
process.env.GITHUB_CLIENT_SECRET = 'test-secret';
const {server} = await import('./render-server.mjs');

async function request(path,{method='GET',headers={},fields}={},target=server) {
  let body;
  if (fields) {
    const form = new FormData();
    for (const [key,value] of Object.entries(fields)) form.set(key,value);
    const encoded = new Request(origin,{method:'POST',body:form});
    body = Buffer.from(await encoded.arrayBuffer());
    headers = {...headers,'content-type':encoded.headers.get('content-type'),'content-length':String(body.length)};
    method = 'POST';
  }
  const incoming = Readable.from(body ? [body] : []);
  Object.assign(incoming,{url:path,method,headers});
  return new Promise((resolve,reject) => {
    const outgoing = {
      headers:{},headersSent:false,
      setHeader(name,value) {this.headers[name.toLowerCase()] = value;},
      writeHead(status,values={}) {this.status=status;this.headersSent=true;for(const [name,value] of Object.entries(values)) this.setHeader(name,value);},
      end(value) {resolve({status:this.status,headers:this.headers,body:Buffer.from(value ?? '').toString('utf8')});},
      destroy() {reject(new Error('Response was interrupted'));}
    };
    target.emit('request',incoming,outgoing);
  });
}

assert.equal((await request('/')).status,200);
assert.match((await request('/new')).body,/\/oauth\/start/);
assert.equal((await request('/new',{headers:{origin,'oai-authenticated-user-id':'spoofed'},fields:{name:'Spoofed'}})).status,401);
const start = await request('/oauth/start?return_to=%2Fnew');
assert.equal(start.status,303);
const authorization = new URL(start.headers.location);
assert.equal(authorization.origin,'https://github.com');
const flowCookie = start.headers['set-cookie'][0].split(';')[0];
assert.equal((await request('/oauth/callback?state=wrong&code=test',{headers:{cookie:flowCookie}})).status,403);
const realFetch = globalThis.fetch;
globalThis.fetch = async url => new Response(JSON.stringify(String(url).includes('/access_token') ? {access_token:'test-token'} : {id:123,name:'Test member',login:'test-member'}),{headers:{'Content-Type':'application/json'}});
let callback;
try {
  callback = await request('/oauth/callback?state=' + authorization.searchParams.get('state') + '&code=test',{headers:{cookie:flowCookie}});
} finally {globalThis.fetch = realFetch;}
assert.equal(callback.status,303);
assert.equal(callback.headers.location,'/new');
const sessionCookie = callback.headers['set-cookie'][1].split(';')[0];
assert.match(callback.headers['set-cookie'][1],/HttpOnly; SameSite=Lax/);
assert.match(callback.headers['set-cookie'][1],/Secure/);
assert.match((await request('/new',{headers:{cookie:sessionCookie}})).body,/Test member/);
const fields = {name:'Test member',title:'Render integration check',board:'general',message:'A persistent discussion.',attachments:new File(['Example attachment'],'notes.txt')};
assert.equal((await request('/new',{headers:{cookie:sessionCookie,origin:'https://other.test'},fields})).status,403);
const created = await request('/new',{headers:{cookie:sessionCookie,origin},fields});
assert.equal(created.status,303);
const path = created.headers.location;
assert.match((await request(path)).body,/Render integration check/);
const file = await request(path + '/files/0');
assert.equal(file.body,'Example attachment');
assert.match(file.headers['content-disposition'],/^attachment/);
const {server:reopened} = await import('./render-server.mjs?reopened');
assert.ok(reopened);
assert.match((await request(path,{},reopened)).body,/A persistent discussion/);
assert.equal((await request(path + '/delete',{headers:{origin},fields:{confirm:'yes'}})).status,401);
assert.equal((await request(path + '/delete',{headers:{origin,cookie:sessionCookie},fields:{confirm:'yes'}})).status,303);
assert.equal((await request(path)).status,404);
const unsafeReturn = await request('/oauth/start?return_to=https%3A%2F%2Fother.test');
const flow = JSON.parse(Buffer.from(unsafeReturn.headers['set-cookie'][0].split('=')[1].split('.')[0],'base64url').toString('utf8'));
assert.equal(flow.next,'/');
console.log('Render adapter checks passed for sign-in, identity, persistent uploads, deletion, and redirects.');
