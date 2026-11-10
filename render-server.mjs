import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import worker from "./worker/index.js";

const { RENDER_EXTERNAL_URL, PUBLIC_ORIGIN, FORUM_DATA_DIR, SESSION_SECRET,
  GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = process.env;
const origin = new URL(PUBLIC_ORIGIN ?? RENDER_EXTERNAL_URL ?? "http://localhost:10000").origin;
const secure = origin.startsWith("https://");
if (!FORUM_DATA_DIR || !SESSION_SECRET || SESSION_SECRET.length < 32 ||
    !GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || (process.env.RENDER && !secure)) {
  throw new Error("Configure durable storage, GitHub OAuth credentials, a session secret, and the public HTTPS origin.");
}

mkdirSync(FORUM_DATA_DIR,{recursive:true});
const db = new DatabaseSync(join(FORUM_DATA_DIR,"forum.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS forum_objects (
    path TEXT PRIMARY KEY, body BLOB NOT NULL, etag TEXT NOT NULL, metadata TEXT NOT NULL
  )`);
const get = db.prepare("SELECT * FROM forum_objects WHERE path = ?");
const upsert = db.prepare(`INSERT INTO forum_objects VALUES (?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET body=excluded.body, etag=excluded.etag, metadata=excluded.metadata`);
const create = db.prepare("INSERT OR IGNORE INTO forum_objects VALUES (?, ?, ?, ?)");
const replace = db.prepare("UPDATE forum_objects SET body=?, etag=?, metadata=? WHERE path=? AND etag=?");
const remove = db.prepare("DELETE FROM forum_objects WHERE path = ?");
const page = db.prepare("SELECT path, metadata FROM forum_objects WHERE path >= ? AND path < ? AND path > ? ORDER BY path LIMIT ?");
const bucket = {
  async get(path) {
    const row = get.get(path);
    if (!row) return null;
    return { etag:row.etag, body:row.body, size:row.body.byteLength,
      json:async () => JSON.parse(Buffer.from(row.body).toString("utf8")) };
  },
  async put(path, body, options={}) {
    const bytes = Buffer.from(body);
    const etag = randomBytes(16).toString("hex");
    const metadata = JSON.stringify(options.customMetadata ?? {});
    const previous = options.onlyIf?.etagMatches;
    const result = previous ? replace.run(bytes,etag,metadata,path,previous)
      : options.onlyIf?.etagDoesNotMatch === "*" ? create.run(path,bytes,etag,metadata)
      : upsert.run(path,bytes,etag,metadata);
    return result.changes ? {etag} : null;
  },
  async delete(path) { remove.run(path); },
  async list({prefix, limit=100, cursor=""}) {
    const rows = page.all(prefix,prefix + "\uffff",cursor,limit + 1);
    const objects = rows.slice(0,limit).map(row => ({
      key:row.path, customMetadata:JSON.parse(row.metadata)
    }));
    return {objects,truncated:rows.length > limit,cursor:objects.at(-1)?.key};
  }
};

const nonce = () => randomBytes(32).toString("base64url");
const sign = payload => createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
const seal = value => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + sign(payload);
};
function unseal(value, purpose) {
  const [payload, signature] = (value ?? "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected,actual)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data.purpose === purpose && data.expires > Date.now() ? data : null;
  } catch {
    return null;
  }
}
const cookie = (name,value,age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? "; Secure" : ""}`;
const redirect = (res,path,cookies) => {
  res.writeHead(303,{Location:path,"Set-Cookie":cookies,"Cache-Control":"no-store"});
  res.end();
};
const reply = (res,status,message) => {
  res.writeHead(status,{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"});
  res.end(message);
};
const callback = origin + "/oauth/callback";
const returnPath = value => {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\r\n]/.test(value)) return "/";
  const target = new URL(value,origin);
  return target.origin === origin && !target.pathname.startsWith("//") ? target.pathname + target.search : "/";
};
async function github(url, init) {
  const response = await fetch(url,{...init,signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error("GitHub OAuth request failed");
  return response.json();
}

async function handle(req,res) {
  const url = new URL(origin + req.url);
  const cookies = Object.fromEntries((req.headers.cookie ?? "").split(";").map(part => part.trim().split("=",2)));
  if (req.method === "GET" && url.pathname === "/oauth/start") {
    const state = nonce();
    const verifier = nonce();
    const authorization = new URL("https://github.com/login/oauth/authorize");
    authorization.search = new URLSearchParams({client_id:GITHUB_CLIENT_ID,redirect_uri:callback,
      scope:"read:user",state,code_challenge_method:"S256",
      code_challenge:createHash("sha256").update(verifier).digest("base64url")});
    return redirect(res,authorization.href,[cookie("forum_oauth",seal({purpose:"oauth",state,verifier,
      next:returnPath(url.searchParams.get("return_to")),expires:Date.now() + 600000}),600)]);
  }
  if (req.method === "GET" && url.pathname === "/oauth/callback") {
    const flow = unseal(cookies.forum_oauth,"oauth");
    const code = url.searchParams.get("code");
    if (!flow || flow.state !== url.searchParams.get("state") || !code) return reply(res,403,"Sign-in expired or was declined. Return to the community and try again.");
    const token = await github("https://github.com/login/oauth/access_token",{method:"POST",
      headers:{Accept:"application/json","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({client_id:GITHUB_CLIENT_ID,client_secret:GITHUB_CLIENT_SECRET,
        code,redirect_uri:callback,code_verifier:flow.verifier})});
    if (!token.access_token) return reply(res,403,"GitHub sign-in could not be completed.");
    const headers = {Authorization:"Bearer " + token.access_token,Accept:"application/vnd.github+json","User-Agent":"Idea-Exchange"};
    const profile = await github("https://api.github.com/user",{headers});
    if (!Number.isSafeInteger(profile.id) || !profile.login) return reply(res,403,"GitHub sign-in could not be verified. Try again.");
    const age = 28800;
    const session = seal({purpose:"session",id:"github:" + profile.id,name:profile.name || profile.login,expires:Date.now() + age * 1000});
    return redirect(res,flow.next,[cookie("forum_oauth","",0),cookie("forum_session",session,age)]);
  }
  if (req.method === "GET" && url.pathname === "/oauth/logout") return redirect(res,"/",[cookie("forum_session","",0)]);

  const headers = new Headers();
  for (const name of ["origin","content-type","content-length"]) {
    if (typeof req.headers[name] === "string") headers.set(name,req.headers[name]);
  }
  const session = unseal(cookies.forum_session,"session");
  if (session) {
    headers.set("oai-authenticated-user-id",session.id);
    headers.set("oai-authenticated-user-full-name",encodeURIComponent(session.name));
    headers.set("oai-authenticated-user-full-name-encoding","percent-encoded-utf-8");
  }
  let body;
  if (req.method === "POST") {
    const limit = 20 * 1024 * 1024 + 100000;
    if (Number(headers.get("content-length")) > limit) return reply(res,413,"The file exceeds the upload limit.");
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({destroyOnReturn:false})) {
      size += chunk.length;
      if (size > limit) {
        res.setHeader("Connection","close");
        return reply(res,413,"The file exceeds the upload limit.");
      }
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks,size);
  }
  const response = await worker.fetch(new Request(url,{method:req.method,headers,body}),{
    BUCKET:bucket,AUTH_PROVIDER:"github"
  });
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

export const server = createServer((req,res) => {
  handle(req,res).catch(() => {
    if (res.headersSent) res.destroy();
    else reply(res,502,"The journal could not complete this request. Please try again.");
  });
});
server.requestTimeout = 30000;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(process.env.PORT ?? 10000),"0.0.0.0");
}
