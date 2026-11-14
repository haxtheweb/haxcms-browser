/**
 * The Sign in and Save to the cloud dialogs (haxtheweb/issues#3341).
 *
 * Sign in: an account people already have (Google, Microsoft, GitHub,
 * GitLab, Apple: whichever the deployment set up). The profile it gives
 * (name, email, picture) becomes the author of the sites made next; shell.js
 * fills it in through HAXcms's own SEO settings route.
 *
 * Save to the cloud: Google Drive, OneDrive, Dropbox or Box (signed in
 * through auth.js), or a WebDAV server such as Nextcloud (address, user
 * name, app password). Choosing one hands the choice to shell.js
 * (options.useCloud), which moves HAXcms onto it.
 *
 * shell.js creates this with HaxcmsAccounts({ auth, isRunning, useCloud }).
 */
(function () {
  "use strict";

  const STORAGE_LABELS = {
    google: "Google Drive",
    microsoft: "OneDrive",
    dropbox: "Dropbox",
    box: "Box",
  };

  function byId(id) {
    return document.getElementById(id);
  }

  globalThis.HaxcmsAccounts = function HaxcmsAccounts(options) {
    const auth = options.auth;
    const isRunning = options.isRunning;
    const useCloud = options.useCloud;

    const signinButton = byId("signin-button");
    const signinDialog = byId("signin");
    const signinProviders = byId("signin-providers");
    const signinNone = byId("signin-none");
    const signinCurrent = byId("signin-current");
    const signinCurrentText = byId("signin-current-text");
    const signinSignOut = byId("signin-signout");
    const signinStatus = byId("signin-status");
    const signinClose = byId("signin-close");

    const cloudButton = byId("cloud-button");
    const cloudDialog = byId("cloud");
    const cloudProviders = byId("cloud-providers");
    const cloudStatus = byId("cloud-status");
    const cloudClose = byId("cloud-close");
    const webdavUrl = byId("cloud-webdav-url");
    const webdavUser = byId("cloud-webdav-user");
    const webdavPassword = byId("cloud-webdav-password");
    const webdavUse = byId("cloud-webdav-use");

    let running = false;

    function setStatus(element, text, state) {
      element.textContent = text;
      element.dataset.state = state || "";
    }

    function showIdentity() {
      const identity = auth.identity();
      signinCurrent.hidden = !identity;
      if (identity) {
        signinCurrentText.textContent =
          "Signed in as " +
          (identity.name || identity.email || "you") +
          (identity.email && identity.name ? " (" + identity.email + ")" : "") +
          " with " +
          auth.label(identity.provider) +
          ".";
      }
      signinButton.textContent = identity
        ? identity.name || identity.email || "Signed in"
        : "Sign in";
    }

    function providerButton(text, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider";
      button.textContent = text;
      button.addEventListener("click", onClick);
      return button;
    }

    async function refreshButtons() {
      const providers = await auth.list();
      const identity = providers.filter(
        (item) => item.uses.indexOf("identity") !== -1,
      );
      signinButton.hidden = !running || (!identity.length && !auth.identity());
      // WebDAV needs no sign-in set up, so cloud storage is always offered
      cloudButton.hidden = !running;
      showIdentity();
    }

    async function openSignIn() {
      setStatus(signinStatus, "", "");
      const providers = (await auth.list()).filter(
        (item) => item.uses.indexOf("identity") !== -1,
      );
      signinProviders.textContent = "";
      for (const provider of providers) {
        signinProviders.append(
          providerButton("Continue with " + provider.label, () => {
            // straight from the click, so the popup isn't blocked
            const signing = auth.signIn(provider.id);
            setStatus(
              signinStatus,
              "Waiting for " +
                provider.label +
                "… finish signing in in the window that opened.",
              "busy",
            );
            signing
              .then((profile) => {
                auth.setIdentity({
                  provider: provider.id,
                  name: (profile && profile.name) || "",
                  email: (profile && profile.email) || "",
                  image: (profile && profile.image) || "",
                });
                showIdentity();
                setStatus(
                  signinStatus,
                  "Signed in. New sites you make will have you as their author.",
                  "ready",
                );
              })
              .catch((error) =>
                setStatus(
                  signinStatus,
                  String((error && error.message) || error),
                  "error",
                ),
              );
          }),
        );
      }
      signinNone.hidden = providers.length > 0;
      showIdentity();
      signinDialog.showModal();
      (signinProviders.querySelector("button") || signinClose).focus();
    }

    async function openCloud() {
      setStatus(cloudStatus, "", "");
      const providers = (await auth.list()).filter(
        (item) =>
          item.uses.indexOf("storage") !== -1 &&
          Object.prototype.hasOwnProperty.call(STORAGE_LABELS, item.id),
      );
      cloudProviders.textContent = "";
      for (const provider of providers) {
        const label = STORAGE_LABELS[provider.id];
        cloudProviders.append(
          providerButton("Use " + label, () => {
            const signing = auth.signedIn(provider.id)
              ? Promise.resolve()
              : auth.signIn(provider.id);
            setStatus(cloudStatus, "Connecting to " + label + "…", "busy");
            signing
              .then(() =>
                useCloud({ remote: { provider: provider.id }, label }),
              )
              .then(() => {
                setStatus(
                  cloudStatus,
                  "Your sites are now saved to " + label + ".",
                  "ready",
                );
              })
              .catch((error) =>
                setStatus(
                  cloudStatus,
                  String((error && error.message) || error),
                  "error",
                ),
              );
          }),
        );
      }
      cloudDialog.showModal();
      (cloudProviders.querySelector("button") || webdavUrl).focus();
    }

    function useWebdav() {
      const url = webdavUrl.value.trim();
      let host = "";
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") {
          throw new Error("https only");
        }
        host = parsed.host;
      } catch (e) {
        setStatus(
          cloudStatus,
          "Enter the server's https WebDAV address.",
          "error",
        );
        webdavUrl.focus();
        return;
      }
      if (!webdavUser.value.trim() || !webdavPassword.value) {
        setStatus(
          cloudStatus,
          "Enter your user name and an app password.",
          "error",
        );
        return;
      }
      setStatus(cloudStatus, "Connecting to " + host + "…", "busy");
      useCloud({
        remote: {
          provider: "webdav",
          webdav: {
            url,
            username: webdavUser.value.trim(),
            password: webdavPassword.value,
          },
        },
        label: host,
      })
        .then(() => {
          webdavPassword.value = "";
          setStatus(
            cloudStatus,
            "Your sites are now saved to " + host + ".",
            "ready",
          );
        })
        .catch((error) =>
          setStatus(
            cloudStatus,
            String((error && error.message) || error),
            "error",
          ),
        );
    }

    signinButton.addEventListener("click", () => {
      if (isRunning()) {
        openSignIn();
      }
    });
    signinSignOut.addEventListener("click", () => {
      const identity = auth.identity();
      if (identity) {
        auth.signOut(identity.provider);
        auth.setIdentity(null);
      }
      showIdentity();
      setStatus(signinStatus, "Signed out.", "");
    });
    signinClose.addEventListener("click", () => signinDialog.close());
    signinDialog.addEventListener("close", () => signinButton.focus());
    cloudButton.addEventListener("click", () => {
      if (isRunning()) {
        openCloud();
      }
    });
    cloudClose.addEventListener("click", () => cloudDialog.close());
    cloudDialog.addEventListener("close", () => {
      webdavPassword.value = "";
      cloudButton.focus();
    });
    webdavUse.addEventListener("click", useWebdav);
    auth.onChange(showIdentity);

    return {
      show(value) {
        running = value;
        if (!value) {
          signinButton.hidden = true;
          cloudButton.hidden = true;
          return;
        }
        refreshButtons();
      },
      // fill the WebDAV form back in (all but the password) to reconnect
      prefillWebdav(webdav) {
        webdavUrl.value = (webdav && webdav.url) || "";
        webdavUser.value = (webdav && webdav.username) || "";
        openCloud();
        webdavPassword.focus();
      },
      openCloud,
      STORAGE_LABELS,
    };
  };
})();
