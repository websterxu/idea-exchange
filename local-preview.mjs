import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import worker from './worker/index.js';

// Bind the sample identity only on loopback. Hosted Sites supplies real identity.
const db = new DatabaseSync('preview.sqlite');
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS objects (path TEXT PRIMARY KEY, body BLOB NOT NULL, etag TEXT NOT NULL, metadata TEXT NOT NULL)');
const get = db.prepare('SELECT * FROM objects WHERE path = ?');
const insert = db.prepare('INSERT OR IGNORE INTO objects VALUES (?, ?, ?, ?)');
const upsert = db.prepare('INSERT INTO objects VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET body=excluded.body,etag=excluded.etag,metadata=excluded.metadata');
const update = db.prepare('UPDATE objects SET body=?,etag=?,metadata=? WHERE path=? AND etag=?');
const remove = db.prepare('DELETE FROM objects WHERE path = ?');
const list = db.prepare('SELECT path,metadata FROM objects WHERE path >= ? AND path < ? AND path > ? ORDER BY path LIMIT ?');
const bucket = {
  async get(path) {
    const row = get.get(path);
    if (!row) return null;
    return {body:row.body,etag:row.etag,size:row.body.byteLength,json:async () => JSON.parse(Buffer.from(row.body).toString('utf8'))};
  },
  async put(path,body,options={}) {
    const bytes = Buffer.from(body);
    const etag = randomUUID();
    const metadata = JSON.stringify(options.customMetadata ?? {});
    const result = options.onlyIf?.etagMatches
      ? update.run(bytes,etag,metadata,path,options.onlyIf.etagMatches)
      : options.onlyIf?.etagDoesNotMatch === '*' ? insert.run(path,bytes,etag,metadata)
      : upsert.run(path,bytes,etag,metadata);
    return result.changes ? {etag} : null;
  },
  async delete(path) {remove.run(path);},
  async list({prefix,limit=30,cursor=''}) {
    const rows = list.all(prefix,prefix + '\uffff',cursor,limit + 1);
    const objects = rows.slice(0,limit).map(row => ({key:row.path,customMetadata:JSON.parse(row.metadata)}));
    return {objects,truncated:rows.length > limit,cursor:objects.at(-1)?.key};
  }
};
const port = Number(process.env.PORT ?? 4173);
createServer(async (incoming,outgoing) => {
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of incoming) {
      length += chunk.length;
      if (length > 21 * 1024 * 1024) {
        outgoing.writeHead(413); outgoing.end('Upload is too large.'); return;
      }
      chunks.push(chunk);
    }
    const origin = 'http://127.0.0.1:' + port;
    const url = new URL(incoming.url,origin);
    if (url.pathname === '/signout-with-chatgpt') {
      outgoing.writeHead(303,{Location:'/'}); outgoing.end(); return;
    }
    const headers = new Headers();
    for (const name of ['origin','content-type','content-length']) {
      if (typeof incoming.headers[name] === 'string') headers.set(name,incoming.headers[name]);
    }
    headers.set('oai-authenticated-user-id','local-preview-member');
    headers.set('oai-authenticated-user-full-name','Preview member');
    const request = new Request(url,{method:incoming.method,headers,
      body:['GET','HEAD'].includes(incoming.method) ? undefined : Buffer.concat(chunks)});
    const response = await worker.fetch(request,{BUCKET:bucket,LOCAL_PREVIEW:true});
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (outgoing.headersSent) outgoing.destroy();
    else {outgoing.writeHead(500);outgoing.end('Preview request failed.');}
  }
}).listen(port,'127.0.0.1',() => console.log('Local preview at http://127.0.0.1:' + port));
