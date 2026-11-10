import assert from 'node:assert/strict';
import worker from './worker/index.js';

class Bucket {
  items = new Map();
  failRecord = false;
  async get(key) {
    const item = this.items.get(key);
    return item ? {...item,json:async () => JSON.parse(item.body)} : null;
  }
  async put(key,body,{onlyIf,customMetadata}={}) {
    if (this.failRecord && key.startsWith('topics/')) throw new Error('Simulated storage failure');
    const prior = this.items.get(key);
    if (onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    if (onlyIf?.etagMatches && prior?.etag !== onlyIf.etagMatches) return null;
    const item = {key,body,customMetadata,etag:crypto.randomUUID(),size:body.byteLength};
    this.items.set(key,item);
    return item;
  }
  async delete(key) {this.items.delete(key);}
  async list({prefix,limit=30,cursor=''}) {
    const matching = [...this.items.values()].filter(item => item.key.startsWith(prefix) && item.key > cursor).sort((a,b) => a.key.localeCompare(b.key));
    const objects = matching.slice(0,limit);
    return {objects,truncated:matching.length > limit,cursor:objects.at(-1)?.key};
  }
}

const bucket = new Bucket();
const origin = 'https://community.test';
const call = async (path,person,fields,expected=200,crossOrigin=false) => {
  const headers = {};
  if (person) headers['oai-authenticated-user-id'] = person;
  let body;
  if (fields) {
    headers.Origin = crossOrigin ? 'https://other.test' : origin;
    body = new FormData();
    for (const [name,value] of Object.entries(fields)) {
      for (const item of Array.isArray(value) ? value : [value]) body.append(name,item);
    }
  }
  const response = await worker.fetch(new Request(origin + path,{method:fields ? 'POST' : 'GET',headers,body}),{BUCKET:bucket});
  assert.equal(response.status,expected,path);
  return response;
};
const form = {title:'How do we teach AI responsibly?',name:'Webster',board:'research',message:'A question for our community.'};
const png = new File([new Uint8Array([137,80,78,71,13,10,26,10,1,2,3])],'picture.png',{type:'image/png'});
const file = new File(['<script>example</script>'],'notes.html',{type:'text/html'});
assert.match(await (await call('/',null)).text(),/The first conversation/);
assert.match(await (await call('/new',null)).text(),/Sign in to participate/);
await call('/new',null,form,401);
await call('/new','alice',form,403,true);
await call('/new','alice',{...form,message:''},400);
await call('/new','alice',{...form,board:'invalid'},400);
await call('/new','alice',{...form,attachments:[file,file,file,file]},400);
await call('/new','alice',{...form,attachments:new File(['bad'],'broken.png')},400);
await call('/new','alice',{...form,attachments:new File([new Uint8Array(10 * 1024 * 1024 + 1)],'large.bin')},400);
const created = await call('/new','alice',{...form,message:'<script>unsafe</script>',attachments:[png,file]},303);
const topic = created.headers.get('location');
const content = await (await call(topic,null)).text();
assert.match(content,/&lt;script&gt;unsafe&lt;\/script&gt;/);
assert.doesNotMatch(content,/<script>|Delete my post|alice/);
assert.match(content,/<img loading="lazy"/);
const image = await call(topic + '/files/0',null);
assert.equal(image.headers.get('content-type'),'image/png');
assert.match(image.headers.get('content-disposition'),/^inline/);
const download = await call(topic + '/files/1',null);
assert.equal(download.headers.get('content-type'),'application/octet-stream');
assert.match(download.headers.get('content-disposition'),/^attachment/);
assert.equal(await download.text(),'<script>example</script>');
assert.match((await call(topic + '/files/0?download=1',null)).headers.get('content-disposition'),/^attachment/);
assert.match(await (await call('/?q=teach',null)).text(),/How do we teach AI/);
assert.doesNotMatch(await (await call('/?board=technology',null)).text(),/How do we teach AI/);
assert.match(await (await call('/mine','alice')).text(),/How do we teach AI/);
assert.doesNotMatch(await (await call('/mine','bob')).text(),/How do we teach AI/);
await call(topic + '/delete','bob',{confirm:'yes'},403);
await call(topic + '/delete','alice',{},400);
await call(topic + '/reply','bob',{name:'A colleague',message:'Here is a resource.',attachments:file},303);
assert.match(await (await call(topic,null)).text(),/Here is a resource/);
const replyId = [...bucket.items.keys()].find(key => key.startsWith('replies/')).split('/').at(-1).slice(0,-5);
const reply = topic + '/replies/' + replyId;
await call(reply + '/files/0',null);
await call(reply + '/delete','alice',{confirm:'yes'},403);
await call(reply + '/delete','bob',{confirm:'yes'},303);
await call(reply + '/files/0',null,null,404);
await call(topic + '/reply','bob',{name:'A colleague',message:'Another reply.',attachments:file},303);
const otherReplyId = [...bucket.items.keys()].filter(key => key.startsWith('replies/')).map(key => key.split('/').at(-1).slice(0,-5)).find(id => id !== replyId);
await call(topic + '/delete','alice',{confirm:'yes'},303);
await call(topic,null,null,404);
await call(topic + '/files/0',null,null,404);
await call(topic + '/replies/' + otherReplyId + '/files/0',null,null,404);
await call(topic + '/reply','bob',{name:'Member',message:'Reply after deletion'},404);
assert.doesNotMatch(await (await call('/',null)).text(),/How do we teach AI/);
const before = [...bucket.items.keys()].filter(key => key.startsWith('files/')).length;
bucket.failRecord = true;
await call('/new','alice',{...form,attachments:file},500);
assert.equal([...bucket.items.keys()].filter(key => key.startsWith('files/')).length,before);
console.log('Forum posting, attachments, replies, deletion, and access checks passed.');
