const BOARDS = {general:'General discussion',research:'Research & teaching',technology:'Technology & AI',resources:'Shared resources'};
const TOPIC_ID = /^\d{13}-[a-f0-9-]{36}$/;
const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_FILES = 3;
const security = {'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Cache-Control':'no-store'};
const escape = value => String(value ?? '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paragraph = value => escape(value).replaceAll('\n','<br>');
const fail = (status,message) => {throw Object.assign(new Error(message),{status});};
const redirect = path => new Response(null,{status:303,headers:{...security,Location:path}});
const newId = () => String(9999999999999 - Date.now()).padStart(13,'0') + '-' + crypto.randomUUID();
const topicKey = id => 'topics/' + id + '.json';
const replyKey = (topicId,id) => 'replies/' + topicId + '/' + id + '.json';
const date = value => new Date(value).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}) + ' UTC';

function user(request) {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id) return null;
  let name = request.headers.get('oai-authenticated-user-full-name') ?? '';
  if (request.headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try {name = decodeURIComponent(name);} catch {name = '';}
  }
  return {id,name:name.slice(0,60)};
}

async function read(bucket,key) {
  const item = await bucket.get(key);
  return item ? {data:await item.json(),etag:item.etag} : null;
}

function text(form,name,max,required=true) {
  const value = form.get(name);
  const clean = typeof value === 'string' ? value.trim() : '';
  if ((required && !clean) || clean.length > max) fail(400,'Check the ' + name + ' field.');
  return clean;
}

function imageFormat(bytes) {
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const signature = new TextDecoder().decode(bytes.slice(0,12));
  if (/^GIF8[79]a/.test(signature)) return 'image/gif';
  if (signature.startsWith('RIFF') && signature.slice(8,12) === 'WEBP') return 'image/webp';
  return null;
}

async function attachments(form) {
  const files = form.getAll('attachments').filter(file => typeof file !== 'string' && file.size);
  if (files.length > MAX_FILES) fail(400,'Choose up to three attachments.');
  if (files.reduce((total,file) => total + file.size,0) > MAX_TOTAL) fail(400,'Keep all attachments together under 20 MB.');
  return Promise.all(files.map(async file => {
    if (file.size > MAX_FILE) fail(400,'Each attachment must be 10 MB or smaller.');
    const name = file.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g,'').slice(0,160) || 'attachment';
    const bytes = await file.arrayBuffer();
    const image = imageFormat(new Uint8Array(bytes));
    if (/\.(png|jpe?g|gif|webp)$/i.test(name) && !image) fail(400,'An image file is invalid. Choose a PNG, JPEG, GIF, or WebP picture.');
    return {name,bytes,type:image ?? 'application/octet-stream',image:Boolean(image),size:file.size};
  }));
}

async function savePost(bucket,key,post,files) {
  const savedFiles = [];
  try {
    post.attachments = [];
    for (const file of files) {
      const path = 'files/' + crypto.randomUUID();
      await bucket.put(path,file.bytes,{httpMetadata:{contentType:file.type}});
      savedFiles.push(path);
      post.attachments.push({key:path,name:file.name,type:file.type,image:file.image,size:file.size});
    }
    const saved = await bucket.put(key,JSON.stringify(post),{
      onlyIf:{etagDoesNotMatch:'*'},
      customMetadata:{title:post.title ?? '',board:post.board ?? '',by:post.by,created:post.created,
        preview:post.body.slice(0,200),files:String(files.length),deleted:'false'}
    });
    if (!saved) fail(409,'This post already exists. Reload the discussion.');
  } catch (error) {
    await Promise.allSettled(savedFiles.map(path => bucket.delete(path)));
    throw error;
  }
}

const signIn = (path,env) => '<a class="button" target="_top" href="' + (env.AUTH_PROVIDER === 'github' ? '/oauth/start' : '/signin-with-chatgpt') + '?return_to=' + encodeURIComponent(path) + '">Sign in to participate</a>';
const link = (path,label,classes='button') => '<a class="' + classes + '" href="' + escape(path) + '">' + escape(label) + '</a>';
function page(title,body,person,env,status=200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} | Idea Exchange</title><style>${CSS}</style></head><body>
  <a class="skip" href="#main">Skip to content</a>${env.LOCAL_PREVIEW ? '<div class="preview">Local preview. Posts stay on this computer. You are using a sample account.</div>' : ''}
  <header><div class="header-inner"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">ie</span><span>Idea Exchange<small>A community bulletin board</small></span></a><nav aria-label="Main navigation">${link('/','Discussions','nav-link')}${link('/new','New topic','nav-link')}${person ? link('/mine','My posts','nav-link') + link(env.AUTH_PROVIDER === 'github' ? '/oauth/logout' : '/signout-with-chatgpt?return_to=%2F','Sign out','nav-link') : '<a class="nav-link" target="_top" href="' + (env.AUTH_PROVIDER === 'github' ? '/oauth/start' : '/signin-with-chatgpt') + '?return_to=%2F">Sign in</a>'}</nav></div></header>
  <main id="main">${body}</main><footer><strong>Idea Exchange</strong><span>Share a thought. Start a conversation.</span>${link('/guidelines','Community guidelines','')}</footer></body></html>`,{status,headers:{...security,'Content-Type':'text/html; charset=utf-8',
    'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
}

function attachmentList(post,path) {
  if (!post.attachments.length) return '';
  return '<div class="attachments">' + post.attachments.map((file,index) => {
    const url = path + '/files/' + index;
    const size = file.size < 1024 * 1024 ? Math.ceil(file.size / 1024) + ' KB' : (file.size / (1024 * 1024)).toFixed(1) + ' MB';
    return file.image ? `<figure><a href="${url}" aria-label="Open ${escape(file.name)}"><img loading="lazy" src="${url}" alt="${escape(file.name)}"></a><figcaption>${link(url + '?download=1',file.name,'')} <span>${size}</span></figcaption></figure>`
      : `<div class="file"><span aria-hidden="true">↧</span><div>${link(url,file.name,'')}<small>${size} download</small></div></div>`;
  }).join('') + '</div>';
}

function compose(person,reply=false) {
  return `<label>Display name<input name="name" maxlength="60" value="${escape(person.name)}" autocomplete="nickname" required><small>This name appears with your post.</small></label>
  ${reply ? '' : '<label>Topic title<input name="title" maxlength="160" required placeholder="What would you like to discuss?"></label><label>Board<select name="board">' + Object.entries(BOARDS).map(([id,label]) => '<option value="' + id + '">' + escape(label) + '</option>').join('') + '</select></label>'}
  <label>${reply ? 'Your reply' : 'Your message'}<textarea name="message" maxlength="12000" rows="8" placeholder="Share an idea, ask a question, or add some context."></textarea></label>
  <label>Pictures or files<input name="attachments" type="file" multiple><small>Up to 3 attachments. Maximum 10 MB each and 20 MB combined. PNG, JPEG, GIF, and WebP pictures appear in the discussion. Other files are available to download.</small></label>
  <small>Add a message, an attachment, or both. Your contribution will be visible to everyone who can access this board.</small>
  <button type="submit">${reply ? 'Post reply' : 'Publish topic'}</button>`;
}

function removeForm(path) {
  return `<form method="post" action="${path}/delete" class="delete"><label><input type="checkbox" name="confirm" value="yes" required> Confirm deletion</label><button class="text-button" type="submit">Delete my post</button></form>`;
}

function boardLinks(selected) {
  return '<aside><h2>Boards</h2><a class="board ' + (!selected ? 'selected' : '') + '" href="/">All discussions</a>' + Object.entries(BOARDS).map(([id,label]) => '<a class="board ' + (selected === id ? 'selected' : '') + '" href="/?board=' + id + '">' + escape(label) + '</a>').join('') + '<div class="board-note"><h3>Bring something to the table</h3><p>A question, an image, a document, or a different perspective.</p>' + link('/new','Start a topic','button secondary') + '</div></aside>';
}

async function topicRows(bucket,url,person,mine) {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && cursor.length > 2048) fail(400,'The page link is invalid. Return to discussions.');
  const board = url.searchParams.get('board') ?? '';
  if (board && !Object.hasOwn(BOARDS,board)) fail(400,'Choose an available board.');
  const query = (url.searchParams.get('q') ?? '').trim().slice(0,100);
  const listing = await bucket.list({prefix:'topics/',include:['customMetadata'],limit:30,cursor});
  let topics = listing.objects.filter(item => item.customMetadata?.deleted !== 'true');
  if (mine) {
    const records = await Promise.all(topics.map(item => read(bucket,item.key)));
    topics = topics.filter((_,index) => records[index]?.data.owner === person.id);
  }
  topics = topics.filter(({customMetadata:meta}) => (!board || meta?.board === board) && (!query || (meta?.title + ' ' + meta?.preview).toLowerCase().includes(query.toLowerCase())));
  const rows = topics.map(({key,customMetadata:meta}) => {
    const id = key.slice('topics/'.length,-5);
    return `<article class="topic-row"><div class="topic-icon" aria-hidden="true">${Number(meta.files) ? '▧' : '≡'}</div><div class="topic-summary"><div class="topic-board">${escape(BOARDS[meta.board])}</div><h2>${link('/topics/' + id,meta.title,'')}</h2><p>${escape(meta.preview || 'Open this topic to view its attachments.')}</p><div class="row-meta"><strong>${escape(meta.by)}</strong><time>${date(meta.created)}</time>${Number(meta.files) ? '<span>' + meta.files + ' attachment' + (meta.files === '1' ? '' : 's') + '</span>' : ''}</div></div>${link('/topics/' + id,'Open discussion','open-topic')}</article>`;
  }).join('');
  const next = new URL(url);
  if (listing.truncated) next.searchParams.set('cursor',listing.cursor);
  return {board,query,html:`<section class="topic-list" aria-label="Discussion topics">${rows || '<div class="empty"><h2>' + (cursor || query || board || mine ? 'No matching topics on this page' : 'The first conversation starts with you') + '</h2><p>' + (cursor || query || board || mine ? 'Try another board, change the search, or continue to older topics.' : 'Post a question, share a picture, or upload a resource for others to discuss.') + '</p>' + link('/new','Start a topic') + '</div>'}</section>${listing.truncated ? '<div class="pagination">' + link(next.pathname + next.search,'Older topics','button secondary') + '</div>' : ''}`};
}

async function deletePost(bucket,key,record,person) {
  if (record.data.owner !== person.id) fail(403,'You can only delete your own posts.');
  const saved = await bucket.put(key,JSON.stringify({...record.data,deleted:true}),{
    onlyIf:{etagMatches:record.etag},customMetadata:{deleted:'true'}
  });
  if (!saved) fail(409,'This post changed. Reload it and try again.');
  await Promise.allSettled(record.data.attachments.map(file => bucket.delete(file.key)));
}

async function download(bucket,file,forceDownload) {
  if (!file) fail(404,'Attachment not found.');
  const object = await bucket.get(file.key);
  if (!object) fail(404,'Attachment not found.');
  return new Response(object.body,{headers:{...security,'Content-Type':file.type,
    'Content-Length':String(object.size),'Content-Security-Policy':"sandbox; default-src 'none'",
    'Content-Disposition':(file.image && !forceDownload ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(file.name)}});
}

async function handle(request,env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const person = user(request);
  const bucket = env.BUCKET;
  if (!['GET','HEAD','POST'].includes(request.method)) fail(405,'This action is unavailable.');
  const posting = request.method === 'POST';
  if (posting) {
    if (!person) fail(401,'Sign in before posting.');
    if (request.headers.get('Origin') !== url.origin) fail(403,'Open this form directly on Idea Exchange.');
    if (Number(request.headers.get('Content-Length')) > MAX_TOTAL + 100000) fail(413,'The upload is too large. Keep attachments under 20 MB combined.');
  }
  if (!posting && path === '/guidelines') return page('Community guidelines',`<div class="narrow"><p>${link('/','Back to discussions','')}</p><h1>Make room for good conversation.</h1><div class="prose"><h2>Share with care</h2><p>Discuss ideas respectfully. Add enough context for others to understand your question or resource.</p><h2>Protect private information</h2><p>Only post pictures and files you have permission to share. Keep personal, confidential, and unpublished material off the board unless sharing is authorized.</p><h2>Check downloads</h2><p>Files are supplied by community members. Use your own security tools before opening unfamiliar downloads.</p><h2>Manage your contributions</h2><p>You can delete your own posts. Deleting a topic removes its discussion and attachments from view.</p></div></div>`,person,env);
  if (!bucket) fail(503,'Discussion storage is unavailable. Try again shortly.');
  if (!posting && (path === '/' || path === '/mine')) {
    if (path === '/mine' && !person) return page('Sign in',`<div class="narrow"><h1>Your conversations</h1><p>Sign in to see the topics you started.</p>${signIn(path,env)}</div>`,person,env);
    const result = await topicRows(bucket,url,person,path === '/mine');
    return page('Discussions',`<div class="intro"><div><h1>${path === '/mine' ? 'Your conversations' : 'Good ideas deserve a conversation.'}</h1><p>A place to ask, share, and think together.</p></div>${link('/new','Start a topic')}</div><div class="layout">${boardLinks(result.board)}<div><div class="list-tools"><h2>${path === '/mine' ? 'Topics you started' : escape(BOARDS[result.board] ?? 'All discussions')}</h2><form action="${path}" method="get" class="search"><input type="hidden" name="board" value="${escape(result.board)}"><label class="sr-only" for="search">Search topic titles and previews</label><input id="search" name="q" value="${escape(result.query)}" maxlength="100" placeholder="Search titles and previews"><button type="submit" class="secondary">Search</button></form></div>${result.html}</div></div>`,person,env);
  }
  if (path === '/new') {
    if (!person) return page('Sign in',`<div class="narrow"><h1>Join the conversation</h1><p>Sign in to share a topic, picture, or file.</p>${signIn('/new',env)}</div>`,null,env);
    if (!posting) return page('New topic',`<div class="narrow"><p>${link('/','Back to discussions','')}</p><h1>Start a topic</h1><form method="post" action="/new" enctype="multipart/form-data" class="composer">${compose(person)}</form></div>`,person,env);
    const data = await request.formData();
    const board = text(data,'board',30);
    if (!Object.hasOwn(BOARDS,board)) fail(400,'Choose an available board.');
    const files = await attachments(data);
    const body = text(data,'message',12000,false);
    if (!body && !files.length) fail(400,'Add a message or an attachment.');
    const topic = {id:newId(),owner:person.id,by:text(data,'name',60),title:text(data,'title',160),board,body,created:new Date().toISOString(),deleted:false};
    await savePost(bucket,topicKey(topic.id),topic,files);
    return redirect('/topics/' + topic.id);
  }
  const route = /^\/topics\/([^/]+)(?:\/(reply|delete|files|replies)(?:\/([^/]+))?(?:\/(delete|files)(?:\/(\d+))?)?)?$/.exec(path);
  if (!route || !TOPIC_ID.test(route[1])) fail(404,'Discussion not found.');
  const [,,action,child,childAction,fileIndex] = route;
  const record = await read(bucket,topicKey(route[1]));
  if (!record || record.data.deleted) fail(404,'This discussion was deleted or is unavailable.');
  const topic = record.data;
  const topicPath = '/topics/' + topic.id;
  if (action === 'files' && /^\d+$/.test(child ?? '') && !childAction && !posting) return download(bucket,topic.attachments[Number(child)],url.searchParams.has('download'));
  if (action === 'replies' && child && TOPIC_ID.test(child)) {
    const reply = await read(bucket,replyKey(topic.id,child));
    if (!reply || reply.data.deleted) fail(404,'Reply not found.');
    if (childAction === 'files' && fileIndex !== undefined && !posting) return download(bucket,reply.data.attachments[Number(fileIndex)],url.searchParams.has('download'));
    if (childAction === 'delete' && posting && fileIndex === undefined) {
      const data = await request.formData();
      if (data.get('confirm') !== 'yes') fail(400,'Confirm deletion before continuing.');
      await deletePost(bucket,replyKey(topic.id,child),reply,person);
      return redirect(topicPath);
    }
    fail(404,'Reply action not found.');
  }
  if (action === 'delete' && posting && !child) {
    const data = await request.formData();
    if (data.get('confirm') !== 'yes') fail(400,'Confirm deletion before continuing.');
    await deletePost(bucket,topicKey(topic.id),record,person);
    return redirect('/');
  }
  if (action === 'reply' && posting && !child) {
    const data = await request.formData();
    const files = await attachments(data);
    const body = text(data,'message',12000,false);
    if (!body && !files.length) fail(400,'Add a message or an attachment.');
    const reply = {id:newId(),owner:person.id,by:text(data,'name',60),body,created:new Date().toISOString(),deleted:false};
    await savePost(bucket,replyKey(topic.id,reply.id),reply,files);
    return redirect(topicPath + '?replied=1');
  }
  if (action || posting) fail(404,'Discussion action not found.');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && cursor.length > 2048) fail(400,'The page link is invalid. Reopen this discussion.');
  const listing = await bucket.list({prefix:'replies/' + topic.id + '/',limit:30,cursor});
  const loaded = await Promise.all(listing.objects.map(item => read(bucket,item.key)));
  const replies = loaded.filter(item => item && !item.data.deleted).map(item => item.data);
  const next = new URL(url);
  if (listing.truncated) next.searchParams.set('cursor',listing.cursor);
  return page(topic.title,`<div class="discussion"><p>${link('/?board=' + topic.board,BOARDS[topic.board],'back-link')}</p><h1>${escape(topic.title)}</h1><div class="row-meta"><strong>${escape(topic.by)}</strong><time>${date(topic.created)}</time></div>
  <article class="post original"><div class="message">${paragraph(topic.body)}</div>${attachmentList(topic,topicPath)}${person?.id === topic.owner ? removeForm(topicPath) : ''}</article>
  <section aria-labelledby="replies-heading"><h2 id="replies-heading">Conversation</h2>${url.searchParams.has('replied') ? '<p class="notice" role="status">Your reply was posted.</p>' : ''}${replies.length ? replies.map(reply => '<article class="post reply"><div class="row-meta"><strong>' + escape(reply.by) + '</strong><time>' + date(reply.created) + '</time></div><div class="message">' + paragraph(reply.body) + '</div>' + attachmentList(reply,topicPath + '/replies/' + reply.id) + (person?.id === reply.owner ? removeForm(topicPath + '/replies/' + reply.id) : '') + '</article>').join('') : '<p class="muted">No replies on this page yet. Add your perspective below.</p>'}${listing.truncated ? link(next.pathname + next.search,'Earlier replies','button secondary') : ''}</section>
  <section class="reply-box"><h2>Add to the conversation</h2>${person ? '<form method="post" action="' + topicPath + '/reply" enctype="multipart/form-data" class="composer">' + compose(person,true) + '</form>' : signIn(topicPath,env)}</section></div>`,person,env);
}

export default {async fetch(request,env) {
  try {
    const response = await handle(request,env);
    return request.method === 'HEAD' ? new Response(null,{status:response.status,headers:response.headers}) : response;
  } catch (error) {
    if (!error.status) console.error('Forum request failed',error.name);
    return page('Community notice',`<div class="narrow"><h1>${error.status === 404 ? 'Page unavailable' : 'Community notice'}</h1><p>${escape(error.status ? error.message : 'The post could not be saved. Try again shortly.')}</p>${link('/','Return to discussions')}</div>`,user(request),env,error.status ?? 500);
  }
}};

const CSS = `*{box-sizing:border-box}body{margin:0;background:#eff3f8;color:#20354c;font:16px/1.6 'Segoe UI',Arial,sans-serif}a{color:#2459b8;text-underline-offset:3px}button,input,textarea,select{font:inherit}a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:3px solid #b16500;outline-offset:3px}header{background:#fff;border-bottom:1px solid #d4dde9}.header-inner{max-width:1240px;margin:auto;padding:23px 32px;display:flex;align-items:center;justify-content:space-between;gap:30px}.brand{display:flex;align-items:center;gap:12px;color:#183761;font-weight:750;font-size:22px;line-height:1.25;text-decoration:none}.brand-mark{display:flex;align-items:center;justify-content:center;background:#325ec4;border-radius:14px 14px 14px 3px;color:white;font:italic 700 28px Georgia,serif;width:46px;height:46px}.brand small{display:block;color:#63748a;font-size:12px;font-weight:400;margin-top:4px}nav{display:flex;gap:22px;flex-wrap:wrap}.nav-link{color:#405671;font-size:14px;font-weight:600;text-decoration:none}.nav-link:hover{text-decoration:underline}main{max-width:1240px;min-height:75vh;padding:40px 32px 80px;margin:auto}h1,h2,h3,p{margin-top:0}h1{font-size:clamp(28px,3.5vw,39px);font-weight:650;line-height:1.2;letter-spacing:-1px}h2{font-size:19px;font-weight:650}h3{font-size:17px}.intro{display:flex;justify-content:space-between;align-items:center;gap:30px;padding:18px 0 35px}.intro h1{margin-bottom:12px}.intro p{margin:0;color:#62748c}.button,button{display:inline-block;background:#325ec4;color:white;text-decoration:none;border:1px solid #325ec4;border-radius:7px;padding:10px 17px;cursor:pointer;font-weight:650;white-space:nowrap}.secondary{background:white;color:#325ec4;border-color:#b9c9e4}.button:hover,button:hover{filter:brightness(.95)}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:34px}aside h2{padding-left:12px;margin-bottom:12px;color:#62748c;font-size:14px}.board{display:block;padding:10px 12px;margin-bottom:5px;text-decoration:none;color:#425875;font-size:15px;border-radius:6px}.board.selected{background:#dce7fb;color:#244eab;font-weight:700}.board-note{margin:32px 12px 0;padding-top:25px;border-top:1px solid #ccd7e7;color:#65768c;font-size:14px}.board-note h3{color:#2b4669}.board-note .button{font-size:13px}.list-tools{display:flex;align-items:center;justify-content:space-between;gap:15px;margin-bottom:18px}.list-tools h2{margin:0}.search{display:flex;gap:8px;max-width:350px}.search input{min-width:0;width:100%;background:#fff}.search button{font-size:13px;padding:8px 12px}.topic-list{background:#fff;border:1px solid #d5deeb;border-radius:9px;overflow:hidden}.topic-row{display:flex;align-items:flex-start;padding:23px 25px;gap:18px;border-bottom:1px solid #e1e7f0}.topic-row:last-child{border-bottom:0}.topic-icon{background:#eef3fc;border:1px solid #d4e0f7;border-radius:8px;flex:0 0 38px;text-align:center;font-size:24px;line-height:38px;color:#416fc5}.topic-summary{min-width:0;flex:1}.topic-board{font-size:12px;color:#5d76a0;margin-bottom:4px}.topic-summary h2{font-size:18px;line-height:1.4;margin-bottom:7px}.topic-summary h2 a{color:#203d64;text-decoration:none;overflow-wrap:anywhere}.topic-summary h2 a:hover{text-decoration:underline}.topic-summary p{color:#63748c;font-size:14px;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.row-meta{display:flex;flex-wrap:wrap;gap:5px 16px;color:#718198;font-size:12px}.row-meta strong{color:#425b7d;font-weight:650}.open-topic{font-size:12px;align-self:center;max-width:70px;text-align:right}.empty{text-align:center;padding:60px 25px}.empty h2{font-size:24px;color:#304b71}.empty p{color:#677c98;max-width:460px;margin:0 auto 24px}.pagination{margin:25px 0}.narrow{max-width:760px;margin:0 auto}.narrow h1{margin:24px 0}.composer{display:grid;gap:21px;background:#fff;border:1px solid #d6dfeb;padding:28px;border-radius:9px}.composer label{display:grid;gap:7px;font-weight:650;font-size:14px}input,textarea,select{width:100%;padding:11px 12px;border:1px solid #bac8db;border-radius:5px;color:#20354c;background:white}textarea{resize:vertical}.composer small{font-size:12px;font-weight:400;color:#6d7f98}.composer button{justify-self:start}.discussion{max-width:860px;margin:auto}.discussion>h1{margin:22px 0 18px}.discussion>.row-meta{margin-bottom:25px}.back-link{font-size:14px}.post{background:#fff;border:1px solid #d6dfeb;border-radius:8px;padding:28px;margin:0 0 20px}.original{margin-bottom:40px}.message{overflow-wrap:anywhere;max-width:75ch}.reply .message{margin-top:17px}.attachments{display:flex;flex-wrap:wrap;gap:16px;margin-top:22px}.attachments figure{margin:0;max-width:100%;width:340px;border:1px solid #d8e1ef;border-radius:6px;overflow:hidden}.attachments img{display:block;max-width:100%;height:220px;width:100%;object-fit:contain;background:#f2f5fa}.attachments figcaption{padding:10px 12px;font-size:12px;overflow-wrap:anywhere}.attachments figcaption span{display:block;color:#73839a}.file{display:flex;align-items:center;gap:12px;padding:14px 18px;background:#f1f5fc;border:1px solid #d6e1f4;border-radius:6px;max-width:100%;overflow-wrap:anywhere}.file>span{font-size:29px;color:#4c77c5}.file small{display:block;color:#71829a;font-size:12px}.delete{display:flex;align-items:center;gap:16px;margin-top:25px;padding-top:15px;border-top:1px solid #e4eaf2;font-size:12px;color:#7f6464}.delete label{display:flex;align-items:center;gap:6px}.delete input{width:auto}.text-button{padding:0;color:#a03f48;background:none;border:0;font-size:12px}.reply-box{margin-top:35px}.notice{background:#e4eefb;padding:12px;border-left:3px solid #426ec6}.muted{color:#718198}.prose{background:#fff;border:1px solid #d6dfeb;padding:30px;border-radius:9px}.prose h2{margin-top:25px}.prose h2:first-child{margin-top:0}footer{max-width:1240px;margin:auto;padding:22px 32px;border-top:1px solid #ced9e8;display:flex;gap:20px;align-items:center;font-size:12px;color:#738299}footer strong{color:#435b7d}footer a{margin-left:auto}.sr-only,.skip{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}.skip:focus{position:fixed;top:8px;left:8px;width:auto;height:auto;clip:auto;margin:0;padding:10px;background:#fff;z-index:2}.preview{background:#fce9c4;padding:8px 20px;font-size:13px;text-align:center}@media(max-width:800px){.layout{grid-template-columns:1fr;gap:24px}aside{display:flex;flex-wrap:wrap;gap:6px}aside h2,.board-note{display:none}.board{padding:7px 11px;margin:0;font-size:13px}.intro{align-items:flex-start}.list-tools{flex-wrap:wrap}.search{max-width:none}.topic-row{padding:20px 16px}.header-inner{align-items:flex-start}nav{gap:10px 16px}main{padding:24px 20px 50px}}@media(max-width:520px){.header-inner{padding:18px 20px;flex-direction:column;gap:18px}.intro{flex-direction:column;gap:20px;padding-top:4px}.open-topic{display:none}.topic-icon{display:none}.composer,.post{padding:20px}.search{width:100%}.delete{align-items:flex-start;flex-direction:column;gap:8px}.attachments figure{width:100%}footer{padding:20px;flex-wrap:wrap;gap:10px}footer a{margin-left:0}h1{letter-spacing:-.6px}}`;
