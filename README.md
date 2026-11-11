# Idea Exchange

A BBS-style community website for text discussions, pictures, file sharing, and replies. Members sign in with ChatGPT when hosted through Sites, or GitHub when hosted on Render. A visitor can browse every discussion allowed by the host's sharing settings. Signed-in members can start topics, reply with text or attachments, and delete their own contributions.

## Local preview

Install Node.js 22.13 or newer. On Windows, double-click `Start-Idea-Exchange.cmd`. Alternatively, open this folder in a terminal and run `npm run preview`, then visit `http://127.0.0.1:4173`. The preview uses a clearly labeled sample account and stores content in `preview.sqlite` on your computer. It is bound to loopback and is intended for local evaluation.

Run `npm test` for the workflow and authorization checks. Run `npm run build` to build the Worker entry point.

## Hosted deployment

### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fwebsterxu%2Fidea-exchange)

The Blueprint sets up a paid Starter web service with a 1 GB persistent disk and generates the session secret. Review the workspace and price in Render. Enter the GitHub OAuth credentials in Render when prompted. Use the steps below for manual setup.

Connect this repository to a Node web service on its main branch. Use Node.js 24, build command `npm test && npm run test:render`, and start command `npm start`.

Attach a persistent disk at `/var/data`, then set `FORUM_DATA_DIR=/var/data`. Persistent disks require a paid Render service. The database stores discussion records and uploaded files. Deployments without persistent storage lose their data when restarted.

Create a GitHub OAuth app with the deployed service URL as its homepage and `https://YOUR-SERVICE.onrender.com/oauth/callback` as its callback URL. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in Render. Set `SESSION_SECRET` to a random value of at least 32 characters. The server uses Render's external URL as its public origin. Set `PUBLIC_ORIGIN` when using a custom HTTPS domain.

The server verifies GitHub sign-in and only passes its own verified identity headers to the forum. Browsing is public. Posting and deletion require a signed-in account.

### ChatGPT Sites

Publish through ChatGPT Sites with a private R2 storage binding named `BUCKET`. The hosting manifest uses the project ID assigned by Sites and `r2: {"binding":"BUCKET"}`. Preserve existing binding names after initial deployment. Sites supplies trusted signed-in identity headers. Use the production Sites workflow to save a source revision, upload the matching build artifact, and deploy it.

Each topic and reply is stored separately, so simultaneous replies cannot overwrite one another. Pictures appear inside discussions. Other attachments download as files. Each contribution accepts up to three files, 10 MB per file and 20 MB combined. Topic browsing, board filters, search by topic title and preview, and My posts are paginated in batches of 30. Newer discussions and replies appear first.

Post text is escaped. Writes require sign-in and a matching request origin. Deletion checks ownership on the server. Deleted topics and their reply attachments become inaccessible through the application. Reply records are retained in storage after a topic is deleted. File downloads are not scanned for malware.
