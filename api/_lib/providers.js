/**
 * The sign-in providers the broker can finish a sign-in for
 * (haxtheweb/issues#3341).
 *
 * Each provider is an OAuth app that whoever runs this deployment registers
 * with the service, then configures with environment variables:
 *
 *   HAX_OAUTH_<ID>_CLIENT_ID       public: also given to the page
 *   HAX_OAUTH_<ID>_CLIENT_SECRET   secret: only ever used here
 *
 * A provider with no client id (or secret) set is simply not offered.
 * Setup steps for every provider are in docs/providers.md.
 *
 * Rules this file keeps:
 * - Every address the broker calls is a fixed https URL written here. What a
 *   caller sends only picks a provider from this list by name.
 * - Secrets never leave this process: GET /api/oauth/providers returns only
 *   the public parts (client id, where to send the person, scopes).
 *
 * uses: what the page may use a provider for
 *   identity  sign in, and fill in a new site's author
 *   storage   keep sites in the provider's storage
 *   publish   publish sites to the provider
 */

const PROVIDERS = {
  github: {
    label: "GitHub",
    uses: ["identity", "publish"],
    // a GitHub App: permissions come from the app's settings, not scopes
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: [],
    pkce: true,
    // HAX_OAUTH_GITHUB_APP_SLUG (optional): the app's URL name, so the page
    // can send people to install it on their account
    optionalEnv: ["APP_SLUG"],
  },
  gitlab: {
    label: "GitLab",
    uses: ["identity", "publish"],
    authorizeUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    scopes: ["read_user", "api"],
    pkce: true,
  },
  codeberg: {
    label: "Codeberg",
    uses: ["publish"],
    authorizeUrl: "https://codeberg.org/login/oauth/authorize",
    tokenUrl: "https://codeberg.org/login/oauth/access_token",
    // Forgejo grants an OAuth app the signed-in account's access
    scopes: [],
    pkce: true,
  },
  netlify: {
    label: "Netlify",
    uses: ["publish"],
    authorizeUrl: "https://app.netlify.com/authorize",
    tokenUrl: "https://api.netlify.com/oauth/token",
    scopes: [],
    pkce: false,
  },
  vercel: {
    label: "Vercel",
    uses: ["publish"],
    // a Vercel Integration: people install it to their account or a team;
    // the authorize address is the integration's install page
    authorizeUrl: "integration",
    tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
    scopes: [],
    pkce: false,
    // HAX_OAUTH_VERCEL_INTEGRATION: the integration's URL slug
    extraEnv: ["INTEGRATION"],
  },
  google: {
    label: "Google",
    uses: ["identity", "storage"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // drive.file: only the files and folders HAXcms itself creates
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/drive.file",
    ],
    pkce: true,
    // a refresh token, so a session can outlast the one-hour access token
    params: { access_type: "offline", prompt: "consent" },
  },
  microsoft: {
    label: "Microsoft",
    uses: ["identity", "storage"],
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Files.ReadWrite.AppFolder: only OneDrive's Apps/<app name> folder
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
      "Files.ReadWrite.AppFolder",
    ],
    pkce: true,
  },
  dropbox: {
    label: "Dropbox",
    uses: ["storage"],
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
    ],
    pkce: true,
    params: { token_access_type: "offline" },
  },
  box: {
    label: "Box",
    uses: ["storage"],
    authorizeUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    // Box scopes are set on the app in the Box developer console
    scopes: [],
    pkce: false,
  },
  apple: {
    label: "Apple",
    uses: ["identity"],
    // Apple posts the sign-in back to the broker itself (api/oauth/apple.js)
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    scopes: ["name", "email"],
    pkce: false,
    // the client secret is a short-lived token signed with a key from Apple
    extraEnv: ["TEAM_ID", "KEY_ID", "PRIVATE_KEY"],
    noSecretEnv: true,
  },
};

function env(id, name) {
  return String(
    process.env["HAX_OAUTH_" + id.toUpperCase() + "_" + name] || "",
  ).trim();
}

// the provider named `id`, with its configuration, or null when it is not
// one of ours or this deployment has not configured it
function provider(id) {
  if (
    typeof id !== "string" ||
    !Object.prototype.hasOwnProperty.call(PROVIDERS, id)
  ) {
    return null;
  }
  const spec = PROVIDERS[id];
  const clientId = env(id, "CLIENT_ID");
  const clientSecret = spec.noSecretEnv ? "" : env(id, "CLIENT_SECRET");
  if (!clientId || (!spec.noSecretEnv && !clientSecret)) {
    return null;
  }
  const extra = {};
  for (const name of spec.extraEnv || []) {
    extra[name] = env(id, name);
    if (!extra[name]) {
      return null;
    }
  }
  for (const name of spec.optionalEnv || []) {
    extra[name] = env(id, name);
  }
  return Object.assign({ id, clientId, clientSecret, extra }, spec);
}

// what the page may know about each configured provider
function publicList() {
  const list = [];
  for (const id of Object.keys(PROVIDERS)) {
    const found = provider(id);
    if (!found) {
      continue;
    }
    list.push({
      id,
      label: found.label,
      uses: found.uses.slice(),
      clientId: found.clientId,
      authorizeUrl:
        found.authorizeUrl === "integration"
          ? "https://vercel.com/integrations/" +
            encodeURIComponent(found.extra.INTEGRATION) +
            "/new"
          : found.authorizeUrl,
      scopes: found.scopes.slice(),
      pkce: !!found.pkce,
      params: Object.assign({}, found.params || {}),
      // Apple posts back to the broker; the rest come back to the page
      callback: id === "apple" ? "broker" : "page",
      installUrl:
        id === "github" && /^[\w-]{1,100}$/.test(found.extra.APP_SLUG || "")
          ? "https://github.com/apps/" +
            found.extra.APP_SLUG +
            "/installations/new"
          : "",
    });
  }
  return list;
}

module.exports = { PROVIDERS, provider, publicList };
