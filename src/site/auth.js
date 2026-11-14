/**
 * Signing in to other services from the HAXcms page (haxtheweb/issues#3341).
 *
 * One sign-in flow for every provider the deployment's broker has set up
 * (GET api/oauth/providers): the page opens the provider in a popup with a
 * random state (and a PKCE challenge where the provider takes one), the
 * provider sends the person back to oauth/callback.html, and the broker
 * trades the code for tokens with the client secret only it knows
 * (POST api/oauth/token). From then on the page calls the provider's API
 * itself, straight from the browser.
 *
 * Tokens stay in this tab: in memory, and in sessionStorage so a reload of
 * the same tab doesn't sign people out (closing the tab forgets them). An
 * access token past its expiry is renewed with the refresh token
 * (POST api/oauth/refresh).
 *
 * Apple is the exception: it posts back to the broker (api/oauth/apple),
 * which sends only the person's name and email on to the callback page.
 *
 * shell.js creates this with HaxcmsAuth(); publish.js and the cloud storage
 * choice use it.
 */
(function () {
  "use strict";

  const STORE = "haxcms-browser:sign-in:";
  const PROFILE = "haxcms-browser:profile";
  const WAIT_MS = 10 * 60 * 1000;

  function base64url(bytes) {
    let text = "";
    for (const byte of bytes) {
      text += String.fromCharCode(byte);
    }
    return btoa(text)
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  function randomString(length) {
    return base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)));
  }

  async function challengeFor(verifier) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return base64url(new Uint8Array(digest));
  }

  function load(key) {
    try {
      const value = JSON.parse(
        globalThis.sessionStorage.getItem(key) || "null",
      );
      return value && typeof value === "object" ? value : null;
    } catch (e) {
      return null;
    }
  }

  function save(key, value) {
    try {
      if (value) {
        globalThis.sessionStorage.setItem(key, JSON.stringify(value));
      } else {
        globalThis.sessionStorage.removeItem(key);
      }
    } catch (e) {
      // storage can be off: the sign-in then lasts until reload
    }
  }

  async function readJson(response) {
    try {
      return await response.json();
    } catch (e) {
      return null;
    }
  }

  // Who someone is, from each provider's own API: { name, email, image,
  // login }. login is the account name publishing uses (repository owner).
  const PROFILES = {
    github: async (call) => {
      const user = await call("https://api.github.com/user");
      return {
        name: user.name || user.login,
        email: user.email || "",
        image: user.avatar_url || "",
        login: user.login,
      };
    },
    gitlab: async (call) => {
      const user = await call("https://gitlab.com/api/v4/user");
      return {
        name: user.name || user.username,
        email: user.public_email || user.email || "",
        image: user.avatar_url || "",
        login: user.username,
      };
    },
    codeberg: async (call) => {
      const user = await call("https://codeberg.org/api/v1/user");
      return {
        name: user.full_name || user.login,
        email: user.email || "",
        image: user.avatar_url || "",
        login: user.login,
      };
    },
    netlify: async (call) => {
      const user = await call("https://api.netlify.com/api/v1/user");
      return {
        name: user.full_name || user.email || "",
        email: user.email || "",
        image: user.avatar_url || "",
        login: user.slug || user.email || "",
      };
    },
    vercel: async (call) => {
      const body = await call("https://api.vercel.com/v2/user");
      const user = (body && body.user) || {};
      return {
        name: user.name || user.username || "",
        email: user.email || "",
        image: "",
        login: user.username || "",
      };
    },
    google: async (call) => {
      const user = await call(
        "https://openidconnect.googleapis.com/v1/userinfo",
      );
      return {
        name: user.name || user.email || "",
        email: user.email || "",
        image: user.picture || "",
        login: user.email || "",
      };
    },
    microsoft: async (call) => {
      const user = await call("https://graph.microsoft.com/v1.0/me");
      return {
        name: user.displayName || "",
        email: user.mail || user.userPrincipalName || "",
        image: "",
        login: user.userPrincipalName || "",
      };
    },
    dropbox: async (call) => {
      const user = await call(
        "https://api.dropboxapi.com/2/users/get_current_account",
        { method: "POST" },
      );
      return {
        name: (user.name && user.name.display_name) || user.email || "",
        email: user.email || "",
        image: user.profile_photo_url || "",
        login: user.email || "",
      };
    },
    box: async (call) => {
      const user = await call("https://api.box.com/2.0/users/me");
      return {
        name: user.name || user.login || "",
        email: user.login || "",
        image: user.avatar_url || "",
        login: user.login || "",
      };
    },
  };

  globalThis.HaxcmsAuth = function HaxcmsAuth() {
    const brokerBase = new URL("/api/", globalThis.location.origin);
    const callbackUrl = new URL(
      "oauth/callback.html",
      new URL("./", globalThis.location.href),
    ).href;
    let providers = null;
    // provider id -> { access_token, refresh_token, expires_at, team_id, user_id, profile }
    const sessions = new Map();
    const listeners = new Set();
    // state -> { resolve, reject, timer }
    const waiting = new Map();

    function changed() {
      for (const listener of listeners) {
        try {
          listener();
        } catch (e) {
          console.warn("[haxcms-browser]", e);
        }
      }
    }

    function deliver(result) {
      if (!result || typeof result.state !== "string") {
        return;
      }
      const wait = waiting.get(result.state);
      if (!wait) {
        return;
      }
      waiting.delete(result.state);
      clearTimeout(wait.timer);
      wait.resolve(result);
    }
    globalThis.addEventListener("message", (event) => {
      if (
        event.origin === globalThis.location.origin &&
        event.data &&
        event.data.type === "haxcms-oauth"
      ) {
        deliver(event.data.result);
      }
    });
    if (typeof globalThis.BroadcastChannel === "function") {
      const channel = new globalThis.BroadcastChannel("haxcms-oauth");
      channel.addEventListener("message", (event) => {
        if (event.data && event.data.type === "haxcms-oauth") {
          deliver(event.data.result);
        }
      });
    }

    // the broker's providers; an empty or failed answer is asked again
    // next time, in case the broker was only out for a moment
    async function list() {
      if (providers && providers.length) {
        return providers;
      }
      try {
        const response = await fetch(new URL("oauth/providers", brokerBase), {
          cache: "no-store",
        });
        const body = response.ok ? await readJson(response) : null;
        providers = body && Array.isArray(body.providers) ? body.providers : [];
      } catch (e) {
        providers = [];
      }
      return providers;
    }

    function find(id) {
      return (providers || []).find((item) => item.id === id) || null;
    }

    function remember(id, session) {
      if (session) {
        sessions.set(id, session);
      } else {
        sessions.delete(id);
      }
      save(STORE + id, session);
      changed();
    }

    function sessionFor(id) {
      if (!sessions.has(id)) {
        const stored = load(STORE + id);
        if (stored && stored.access_token) {
          sessions.set(id, stored);
        }
      }
      return sessions.get(id) || null;
    }

    function fromTokens(tokens, previous) {
      const expiresIn = Number(tokens.expires_in) || 0;
      return {
        access_token: tokens.access_token,
        refresh_token:
          tokens.refresh_token || (previous && previous.refresh_token) || "",
        // a minute early, so a token never runs out mid-request
        expires_at: expiresIn ? Date.now() + (expiresIn - 60) * 1000 : 0,
        team_id: tokens.team_id || (previous && previous.team_id) || "",
        user_id: tokens.user_id || (previous && previous.user_id) || "",
        profile: (previous && previous.profile) || null,
      };
    }

    async function broker(path, body) {
      const response = await fetch(new URL(path, brokerBase), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readJson(response);
      if (!response.ok || !result) {
        throw new Error(
          (result && result.error) ||
            "The sign-in could not be finished (" + response.status + ")",
        );
      }
      return result;
    }

    // A current access token for `id`, renewed if it has run out; null
    // when there is no sign-in (or it can't be renewed).
    async function token(id, forceRefresh) {
      const session = sessionFor(id);
      if (!session) {
        return null;
      }
      const expired = session.expires_at && Date.now() > session.expires_at;
      if (!expired && !forceRefresh) {
        return session.access_token;
      }
      if (!session.refresh_token) {
        if (expired) {
          remember(id, null);
          return null;
        }
        return session.access_token;
      }
      try {
        await list();
        const tokens = await broker("oauth/refresh", {
          provider: id,
          refresh_token: session.refresh_token,
        });
        remember(id, fromTokens(tokens, session));
        return tokens.access_token;
      } catch (e) {
        remember(id, null);
        return null;
      }
    }

    // fetch a provider's API with its token; renews once on a 401
    async function call(id, url, init) {
      let accessToken = await token(id);
      if (!accessToken) {
        throw new Error("Sign in to " + label(id) + " first");
      }
      const send = (value) =>
        fetch(
          url,
          Object.assign({}, init || {}, {
            headers: Object.assign({}, (init && init.headers) || {}, {
              authorization: "Bearer " + value,
            }),
          }),
        );
      let response = await send(accessToken);
      if (response.status === 401) {
        accessToken = await token(id, true);
        if (!accessToken) {
          throw new Error("Sign in to " + label(id) + " again");
        }
        response = await send(accessToken);
      }
      return response;
    }

    async function callJson(id, url, init) {
      const response = await call(id, url, init);
      const body = await readJson(response);
      if (!response.ok) {
        const reason =
          (body && (body.message || body.error_description || body.error)) ||
          response.status;
        const error = new Error(
          label(id) + " answered " + response.status + ": " + reason,
        );
        error.status = response.status;
        error.body = body;
        throw error;
      }
      return body;
    }

    function label(id) {
      const found = find(id);
      return found ? found.label : id;
    }

    function popup() {
      const width = 520;
      const height = 680;
      const left = Math.max(
        0,
        (globalThis.screenX || 0) +
          ((globalThis.outerWidth || width) - width) / 2,
      );
      const top = Math.max(
        0,
        (globalThis.screenY || 0) +
          ((globalThis.outerHeight || height) - height) / 2,
      );
      return globalThis.open(
        "about:blank",
        "haxcms-sign-in",
        "popup,width=" +
          width +
          ",height=" +
          height +
          ",left=" +
          Math.round(left) +
          ",top=" +
          Math.round(top),
      );
    }

    /**
     * Sign in to `id`. Call it straight from a click: it opens the popup
     * before anything else, so popup blockers let it through. Resolves with
     * the profile.
     */
    async function signIn(id) {
      const win = popup();
      try {
        await list();
        const spec = find(id);
        if (!spec) {
          throw new Error(id + " is not set up on this HAXcms");
        }
        if (!win) {
          throw new Error(
            "The sign-in window was blocked. Allow pop-ups for this page and try again.",
          );
        }
        const state = randomString(24);
        const verifier = randomString(48);
        const authorize = new URL(spec.authorizeUrl);
        const params = authorize.searchParams;
        params.set("state", state);
        if (id !== "vercel") {
          // Vercel's integration install page knows its own client and
          // return address
          params.set("client_id", spec.clientId);
          params.set("response_type", "code");
          params.set(
            "redirect_uri",
            spec.callback === "broker"
              ? new URL("oauth/apple", brokerBase).href
              : callbackUrl,
          );
        }
        if (spec.scopes.length) {
          params.set("scope", spec.scopes.join(" "));
        }
        if (spec.callback === "broker") {
          params.set("response_mode", "form_post");
        }
        if (spec.pkce) {
          params.set("code_challenge", await challengeFor(verifier));
          params.set("code_challenge_method", "S256");
        }
        for (const key of Object.keys(spec.params || {})) {
          params.set(key, spec.params[key]);
        }
        const result = await new Promise((resolve, reject) => {
          waiting.set(state, {
            resolve,
            reject,
            timer: setTimeout(() => {
              waiting.delete(state);
              reject(new Error("The sign-in took too long. Try again."));
            }, WAIT_MS),
          });
          win.location.href = authorize.href;
        });
        if (result.error) {
          throw new Error(
            result.error === "access_denied"
              ? "The sign-in was cancelled."
              : String(result.error_description || result.error),
          );
        }
        let session;
        if (spec.callback === "broker") {
          // Apple: a profile only
          session = {
            access_token: "apple",
            refresh_token: "",
            expires_at: 0,
            profile: {
              name: result.name || "",
              email: result.email || "",
              image: "",
              login: result.email || "",
            },
          };
        } else {
          const tokens = await broker("oauth/token", {
            provider: id,
            code: result.code,
            redirect_uri: callbackUrl,
            code_verifier: spec.pkce ? verifier : undefined,
          });
          if (id === "vercel" && result.teamId && !tokens.team_id) {
            tokens.team_id = result.teamId;
          }
          session = fromTokens(tokens, null);
        }
        remember(id, session);
        if (!session.profile && PROFILES[id]) {
          try {
            session.profile = await PROFILES[id]((url, init) =>
              callJson(id, url, init),
            );
          } catch (e) {
            session.profile = { name: "", email: "", image: "", login: "" };
          }
          remember(id, session);
        }
        return session.profile;
      } finally {
        if (win && !win.closed) {
          try {
            win.close();
          } catch (e) {
            // the provider's page may not let us
          }
        }
      }
    }

    function signOut(id) {
      remember(id, null);
      if (identity() && identity().provider === id) {
        setIdentity(null);
      }
    }

    // the profile new sites' author is filled in from
    function identity() {
      return load(PROFILE);
    }
    function setIdentity(value) {
      save(PROFILE, value);
      changed();
    }

    return {
      list,
      find,
      label,
      signIn,
      signOut,
      token,
      call,
      callJson,
      session: sessionFor,
      signedIn: (id) => !!sessionFor(id),
      identity,
      setIdentity,
      onChange: (listener) => listeners.add(listener),
    };
  };
})();
