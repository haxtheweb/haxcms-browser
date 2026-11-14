# Setting up sign-in, cloud storage and publishing

haxcms-browser can sign people in with accounts they already have, keep their sites in cloud storage they already have, and publish sites to free hosts ([haxtheweb/issues#3341](https://github.com/haxtheweb/issues/issues/3341)). Each service needs an OAuth app registered by **whoever runs the deployment**: browser.hax.cloud for the HAX project, or your own fork. This page is the checklist for each one, for people and for agents.

Nothing here is needed to run haxcms-browser. A service whose variables aren't set simply isn't offered.

## How it fits together

- The page signs in with a popup. It sends the person to the service with a random `state` (and a PKCE challenge where the service takes one). The service sends them back to the page's `oauth/callback.html`.
- The page's **broker** (`api/`, Vercel functions deployed with the site) trades the code for tokens with the app's client secret. The broker keeps nothing: no database, no logs of tokens. It only answers its own origin.
- From then on the page calls the service's API **directly from the browser**. Storage and publishing never pass through the broker, so there is no size limit of ours (Surge is the exception, see below).
- Tokens stay in the browser tab: in memory, plus `sessionStorage` so a reload doesn't sign people out. Closing the tab forgets them.

Code: `api/_lib/providers.js` (the list), `api/oauth/*` (the broker routes), `src/site/auth.js` (sign-in in the page), `src/runtime/remote.cjs` (cloud storage), `src/site/publish-hosts.js` (publishing).

## The two addresses every app needs

For a deployment at `https://browser.hax.cloud` (replace with yours):

| What                                                   | Address                                         |
| ------------------------------------------------------ | ----------------------------------------------- |
| Callback (redirect URI) for every service except Apple | `https://browser.hax.cloud/oauth/callback.html` |
| Apple's return URL                                     | `https://browser.hax.cloud/api/oauth/apple`     |

The address must match exactly (scheme, host, path, no trailing slash). The broker refuses any other redirect URI.

**Preview deployments** have their own host names, so sign-in only works there if you also register the preview address. The simplest way to test the real thing is on the production domain.

## Environment variables

Set these in the Vercel project (Settings → Environment Variables), for Production (and Preview if you registered preview addresses), then redeploy.

| Service   | Variables                                                                                                       | Offers                                     |
| --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| GitHub    | `HAX_OAUTH_GITHUB_CLIENT_ID`, `HAX_OAUTH_GITHUB_CLIENT_SECRET`, `HAX_OAUTH_GITHUB_APP_SLUG` (optional)          | sign-in, GitHub Pages                      |
| GitLab    | `HAX_OAUTH_GITLAB_CLIENT_ID`, `HAX_OAUTH_GITLAB_CLIENT_SECRET`                                                  | sign-in, GitLab Pages                      |
| Codeberg  | `HAX_OAUTH_CODEBERG_CLIENT_ID`, `HAX_OAUTH_CODEBERG_CLIENT_SECRET`                                              | Codeberg Pages                             |
| Netlify   | `HAX_OAUTH_NETLIFY_CLIENT_ID`, `HAX_OAUTH_NETLIFY_CLIENT_SECRET`                                                | Netlify                                    |
| Vercel    | `HAX_OAUTH_VERCEL_CLIENT_ID`, `HAX_OAUTH_VERCEL_CLIENT_SECRET`, `HAX_OAUTH_VERCEL_INTEGRATION`                  | Vercel                                     |
| Google    | `HAX_OAUTH_GOOGLE_CLIENT_ID`, `HAX_OAUTH_GOOGLE_CLIENT_SECRET`                                                  | sign-in, Google Drive                      |
| Microsoft | `HAX_OAUTH_MICROSOFT_CLIENT_ID`, `HAX_OAUTH_MICROSOFT_CLIENT_SECRET`                                            | sign-in, OneDrive                          |
| Dropbox   | `HAX_OAUTH_DROPBOX_CLIENT_ID`, `HAX_OAUTH_DROPBOX_CLIENT_SECRET`                                                | Dropbox                                    |
| Box       | `HAX_OAUTH_BOX_CLIENT_ID`, `HAX_OAUTH_BOX_CLIENT_SECRET`                                                        | Box                                        |
| Apple     | `HAX_OAUTH_APPLE_CLIENT_ID`, `HAX_OAUTH_APPLE_TEAM_ID`, `HAX_OAUTH_APPLE_KEY_ID`, `HAX_OAUTH_APPLE_PRIVATE_KEY` | sign-in                                    |
| (any)     | `HAX_BROKER_ALLOWED_ORIGINS` (optional, comma-separated)                                                        | lets other origins you run use this broker |

Client IDs are public (the page gets them from `GET /api/oauth/providers`). Secrets and keys are only read by the broker. Never commit them.

To check what a deployment offers: open `https://<deployment>/api/oauth/providers`. It lists the configured services without their secrets.

---

## GitHub (sign-in, GitHub Pages)

A **GitHub App** rather than an OAuth App, so people grant access only to the repositories HAX makes for them.

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**. For the HAX project use the haxtheweb organization's settings so the app belongs to the org.
2. **GitHub App name**: e.g. `HAX Publish`. Its URL name (slug) is what you'll put in `HAX_OAUTH_GITHUB_APP_SLUG`.
3. **Homepage URL**: the deployment, e.g. `https://browser.hax.cloud`.
4. **Callback URL**: `https://browser.hax.cloud/oauth/callback.html`.
5. **Expire user authorization tokens**: on (the broker renews them with the refresh token).
6. **Request user authorization (OAuth) during installation**: off. People install the app from the link HAXcms shows, then sign in from HAXcms.
7. **Webhook**: turn **Active** off. HAX doesn't use webhooks.
8. **Repository permissions**:
   - Administration: **Read and write** (to create the site's repository)
   - Contents: **Read and write** (to commit the site)
   - Pages: **Read and write** (to turn GitHub Pages on)
   - Metadata: Read-only (required)
9. **Account permissions**: Email addresses: **Read-only** (fills in the author's email).
10. **Where can this GitHub App be installed?**: **Any account**.
11. Create the app, then **Generate a new client secret**. Copy the **Client ID** and the secret into the variables.

How people use it: the first time they publish to GitHub Pages, HAXcms asks them to install the app on their account (the link comes from `HAX_OAUTH_GITHUB_APP_SLUG`). Then HAXcms makes a public repository named after the site, commits it with `.nojekyll`, and turns Pages on. The site appears at `https://<user>.github.io/<site>/` after GitHub's first build (about a minute).

To check when you test: whether a repository the app creates is reachable when the person installed the app on **Only select repositories**. If publishing fails right after the repository is made, have them choose **All repositories** in the app's installation settings, and tell us so we can document it.

## GitLab (sign-in, GitLab Pages)

1. Go to **gitlab.com → your avatar → Edit profile → Applications** (or a group's **Settings → Applications** for a group-owned app).
2. **Name**: `HAX`. **Redirect URI**: `https://browser.hax.cloud/oauth/callback.html`.
3. **Confidential**: checked.
4. **Scopes**: `read_user` and `api` (`api` is needed to create the project and commit the site).
5. Save. Copy the **Application ID** into `HAX_OAUTH_GITLAB_CLIENT_ID` and the **Secret** into `HAX_OAUTH_GITLAB_CLIENT_SECRET`.

How people use it: HAXcms makes a public project named after the site. It commits the site into `public/` plus a `.gitlab-ci.yml` whose `pages` job publishes that folder. GitLab CI then builds Pages. New projects usually get a unique `*.gitlab.io` address; HAXcms shows it once GitLab reports it.

Limitation to know: GitLab.com requires new accounts to verify their identity before CI runners will run, so a brand-new account's first publish waits until they do.

## Codeberg (Codeberg Pages)

1. Go to **codeberg.org → Settings → Applications → Manage OAuth2 applications**.
2. **Application name**: `HAX`. **Redirect URIs**: `https://browser.hax.cloud/oauth/callback.html`.
3. **Confidential client**: checked.
4. Create. Copy the **Client ID** and **Client secret** into the variables.

Codeberg (Forgejo) gives an OAuth app the signed-in account's access; HAXcms asks for no extra scopes.

How people use it: HAXcms makes a public repository named after the site, adds the webhook that Codeberg's git-pages server needs, and commits the site to the `pages` branch. The site appears at `https://<user>.codeberg.page/<site>/`. Codeberg's old Pages server stops serving on 2026-12-31; HAXcms uses the new webhook-based one.

## Netlify (publishing)

1. Go to **app.netlify.com → User settings → Applications → OAuth applications → New OAuth app**.
2. **Application name**: `HAX`. **Redirect URI**: `https://browser.hax.cloud/oauth/callback.html`.
3. Save. Copy the **Client ID** and **Secret** into the variables.

How people use it: HAXcms makes a Netlify site named after the site (or lets Netlify pick a free name if that one is taken). It deploys by file digest, so republishing uploads only what changed. Each person's own Netlify plan limits apply.

## Vercel (publishing)

Publishing needs a **Vercel Integration**. "Sign in with Vercel" alone only gives identity; its API permissions are in a private beta.

1. Go to the **Vercel Integrations Console** (Dashboard → Integrations → Integration Console) and **Create** an integration.
2. **Name / URL slug**: e.g. `hax-publish`. The slug goes in `HAX_OAUTH_VERCEL_INTEGRATION`.
3. **Redirect URL**: `https://browser.hax.cloud/oauth/callback.html`.
4. **API Scopes**: Deployments **Read and write**, Projects **Read and write**, and User **Read** (for the account name).
5. Save. Copy the **Client (Integration) ID** and **Client Secret** into the variables.

How people use it: publishing opens the integration's install page. People pick their personal account or a team, HAXcms uploads the site's files, and makes a production deployment of a project named after the site at `https://<site>.vercel.app`. Vercel's Hobby plan is for personal, non-commercial use; the dialog says so.

To check when you test: whether a private (not Marketplace-listed) integration can be installed by people outside your team from its install link.

## Google (sign-in, Google Drive)

1. In **Google Cloud Console**, create (or pick) a project.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **Google Auth Platform → Branding** (OAuth consent screen): app name `HAX`, support email, home page, privacy policy link. **Audience**: External.
4. **Data Access** (scopes): `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/drive.file`. `drive.file` only reaches files HAXcms itself makes, which keeps the request minimal.
5. While the app is in **Testing**, add test users (only they can sign in). **Publish** the app when you're ready for everyone.
6. **Clients → Create client → Web application**. **Authorized redirect URIs**: `https://browser.hax.cloud/oauth/callback.html`.
7. Copy the **Client ID** and **Client secret** into the variables.

How people use it: sign in fills in their name, email and picture as the author of new sites. **Save to the cloud → Use Google Drive** keeps sites in a `HAXcms sites` folder in their Drive.

## Microsoft (sign-in, OneDrive)

1. In **Microsoft Entra admin center → App registrations → New registration**.
2. **Supported account types**: _Accounts in any organizational directory and personal Microsoft accounts_.
3. **Redirect URI**: platform **Web** (not "Single-page application"), `https://browser.hax.cloud/oauth/callback.html`. It has to be Web because the broker finishes the sign-in with a secret.
4. **Certificates & secrets → New client secret**. Note its expiry: secrets last at most two years, so put a reminder to rotate it.
5. **API permissions → Microsoft Graph → Delegated**: `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Files.ReadWrite.AppFolder`.
6. Copy the **Application (client) ID** and the secret **Value** into the variables.

How people use it: sign in fills in the author. **Use OneDrive** keeps sites in OneDrive's `Apps/<app name>` folder, the only folder the app can reach.

For hax.psu.edu's Azure sign-in (an open question in #3341): this registration is separate from hax.psu.edu's. Penn State accounts can sign in with it if the university allows users to consent to multi-tenant apps; if not, a Penn State tenant admin has to grant consent once.

## Dropbox (cloud storage)

1. Go to the **Dropbox App Console → Create app**.
2. **Scoped access**, **App folder** (HAXcms only sees `Apps/<app name>`). Name: `HAX` (must be unique on Dropbox; e.g. `HAX sites`).
3. **Permissions** tab: `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`. **Submit**.
4. **Settings** tab: **Redirect URIs**: add `https://browser.hax.cloud/oauth/callback.html`.
5. Copy the **App key** into `HAX_OAUTH_DROPBOX_CLIENT_ID` and the **App secret** into `HAX_OAUTH_DROPBOX_CLIENT_SECRET`.

A new Dropbox app is in development status with a limit on how many people can link it. Apply for production in the App Console before a wide launch.

## Box (cloud storage)

1. Go to the **Box Developer Console → My Apps → Create New App → Custom App → User Authentication (OAuth 2.0)**.
2. **Configuration → OAuth 2.0 Redirect URIs**: `https://browser.hax.cloud/oauth/callback.html`.
3. **Application Scopes**: _Read all files and folders stored in Box_ and _Write all files and folders stored in Box_.
4. **CORS Domains**: `https://browser.hax.cloud`. Box only answers browser calls from listed origins, so this one is required.
5. Copy the **Client ID** and **Client Secret** into the variables.

Some enterprise Box accounts need an admin to authorize the app before their users can.

## Apple (sign-in)

Needs an **Apple Developer Program** membership.

1. **Certificates, Identifiers & Profiles → Identifiers**: create an **App ID** with **Sign in with Apple** turned on.
2. Create a **Services ID** (e.g. `cloud.hax.browser`). This is `HAX_OAUTH_APPLE_CLIENT_ID`.
3. Configure the Services ID's **Sign in with Apple**: primary App ID from step 1, **Domains**: `browser.hax.cloud`, **Return URLs**: `https://browser.hax.cloud/api/oauth/apple` (the broker's address, because Apple posts the result back as a form).
4. **Keys**: create a key with **Sign in with Apple** for that App ID, and download the `.p8` file (you can only download it once). Its **Key ID** is `HAX_OAUTH_APPLE_KEY_ID`.
5. Your **Team ID** (top right of the developer site) is `HAX_OAUTH_APPLE_TEAM_ID`.
6. Put the whole `.p8` file's contents in `HAX_OAUTH_APPLE_PRIVATE_KEY`. Line breaks may be written as `\n`.

The broker signs a five-minute client secret from that key for each sign-in. Apple sends a person's name only the first time they sign in to the app; after that, HAXcms gets their email only.

## Surge (publishing): no setup

Surge works without registering anything: people paste a Surge token or sign in with their Surge email and password. Surge's API doesn't accept requests from browsers, so this one does go through the broker (`api/surge/*`), and Vercel's request-size limit caps it at about 4 MB per site. The dialog says so and points bigger sites to the HAX CLI or the other hosts.

## Nextcloud and other WebDAV servers: set up on the server

There is no app to register. The person enters their WebDAV address, user name and an app password, and the browser talks to their server directly. The server has to allow that:

- **Nextcloud**: an admin installs the **WebAppPassword** app and adds the deployment's origin (`https://browser.hax.cloud`) to its allowed origins, which turns on CORS for WebDAV.
- The person makes an **app password** (Settings → Security → Devices & sessions) and creates a folder for HAXcms.
- The address is that folder's WebDAV URL, e.g. `https://cloud.example.org/remote.php/dav/files/<user>/HAXcms/`. It must be https.

The app password is never stored: after a reload, **Reconnect** asks for it again.

---

## Forks and other copies

- **A fork on Vercel** gets the broker with the site: register its own apps with its own addresses (above, with your host name), set the variables in its Vercel project, and it offers the same services.
- **A copy on GitHub Pages** (or any host without functions) has no broker, so it offers no sign-in, cloud storage or publishing. It still saves to a folder or the browser, and **Download site** plus the HAX CLI still publishes.
- **One broker for several copies**: list the other origins in `HAX_BROKER_ALLOWED_ORIGINS`. The page looks for the broker at `/api/` on its own origin, though, so the copies need to share the broker's origin (e.g. through a rewrite).

## Testing the real thing, service by service

After setting a service's variables and redeploying:

1. `GET https://<deployment>/api/oauth/providers` lists the service.
2. **Sign in** (GitHub, GitLab, Google, Microsoft, Apple): the bar's Sign in dialog has the service. Sign in, then make a new site from the dashboard. Its `site.json` has `metadata.author` with your name and email (and picture where the service gives one).
3. **Cloud storage** (Google Drive, OneDrive, Dropbox, Box, WebDAV): **Save to the cloud**, pick it, and sign in. The bar says it's saving there. Make a change, then check the service shows the `HAXcms sites` folder (or the app folder) with the site in it. Reload: **Reconnect** brings the sites back.
4. **Publishing** (GitHub Pages, GitLab Pages, Codeberg Pages, Netlify, Vercel): **Publish**, pick the host, publish a small site, open the address it gives. Publish again after a change and check the change appears and a removed page is gone.

Report what doesn't match on [haxtheweb/issues#3341](https://github.com/haxtheweb/issues/issues/3341).
