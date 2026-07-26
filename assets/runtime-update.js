/*
 * Chessy runtime-update gate.
 *
 * A release-unit page may stay open after a newer deployment. Its already
 * loaded scripts remain coherent, but starting another game from that old
 * runtime would keep using the old engine indefinitely. The app calls
 * ensureCurrent() immediately before New game/Rematch replaces the saved
 * game. Online, that explicitly checks sw.js; offline or when service workers
 * are unavailable, it fails open so local play is never blocked.
 *
 * The service worker uses skipWaiting() + clients.claim(). Once a different
 * worker controls the page, this gate reloads and resolves the pending start
 * as false. An initially uncontrolled page verifies a first claimant's release
 * over MessageChannel: a same-release first install stays put, while a newer
 * (or unverifiable) claimant reloads instead of blessing stale page assets.
 * app.js therefore leaves the existing, synchronously persisted game intact
 * for the fresh page to restore.
 */
(function (global, factory) {
  'use strict';

  const api = factory();
  if (global) global.ChessyRuntimeUpdate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis :
  (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  function create(options) {
    options = options || {};
    const serviceWorker = options.serviceWorker;
    const registerWorker = typeof options.register === 'function' ? options.register : null;
    const onRegistration = typeof options.onRegistration === 'function'
      ? options.onRegistration : function () {};
    const onRegistrationError = typeof options.onRegistrationError === 'function'
      ? options.onRegistrationError : function () {};
    const reload = typeof options.reload === 'function' ? options.reload : function () {};
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const now = options.now || Date.now;
    const pageRelease = /^r\d+$/.test(options.release || '') ? options.release : null;
    const MessageChannelApi = options.MessageChannel ||
      (typeof MessageChannel !== 'undefined' ? MessageChannel : null);
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs) : 4000;

    // A controller observed only now may have claimed this document while its
    // old HTML was still parsing. Every initial controller proves its release;
    // the caller's earlier snapshot is only a legacy-handshake fallback.
    const controllerSnapshot = Object.prototype.hasOwnProperty.call(options, 'loadedController')
      ? (options.loadedController || null) : null;
    let loadedController = null;
    let pendingController = null;
    let firstClaimPromise = null;
    let registrationPromise = null;
    let registrationSeq = 0;
    let registrationSucceeded = false;
    let checkInFlight = null;
    let reloadPending = false;
    let reloadCalled = false;

    function requestReload() {
      reloadPending = true;
      if (reloadCalled) return;
      reloadCalled = true;
      reload();
    }

    function controllerRelease(controller, deadline) {
      if (!controller || typeof controller.postMessage !== 'function' ||
          typeof MessageChannelApi !== 'function') {
        return Promise.resolve(null);
      }
      let channel;
      try {
        channel = new MessageChannelApi();
      } catch (e) {
        return Promise.resolve(null);
      }
      const response = new Promise(function (resolve) {
        channel.port1.onmessage = function (event) {
          const data = event && event.data;
          resolve(data && data.type === 'chessy-release'
            && /^r\d+$/.test(data.release || '') ? data.release : null);
        };
        try {
          controller.postMessage({ type: 'chessy-release?' }, [channel.port2]);
        } catch (e) {
          resolve(null);
        }
      });
      return bounded(response, null, deadline).then(function (release) {
        if (channel.port1 && typeof channel.port1.close === 'function') {
          channel.port1.close();
        }
        return release;
      });
    }

    function verifyFirstClaim(next, allowLegacySnapshot) {
      pendingController = next;
      const deadline = now() + timeoutMs;
      const claim = controllerRelease(next, deadline).then(function (release) {
        if (pendingController !== next || reloadPending) return false;
        pendingController = null;
        const releaseMatches = release === pageRelease ||
          (release === null && allowLegacySnapshot);
        if (!serviceWorker || serviceWorker.controller !== next ||
            !pageRelease || !releaseMatches) {
          requestReload();
          return false;
        }
        loadedController = next;
        return true;
      });
      const wrapped = claim.then(function (current) {
        if (firstClaimPromise === wrapped) firstClaimPromise = null;
        return current;
      }, function () {
        if (firstClaimPromise === wrapped) firstClaimPromise = null;
        if (pendingController === next) pendingController = null;
        requestReload();
        return false;
      });
      firstClaimPromise = wrapped;
    }

    function controllerChanged() {
      const next = serviceWorker && serviceWorker.controller;
      if (loadedController) {
        if (next !== loadedController) requestReload();
        return;
      }
      if (pendingController) {
        if (next !== pendingController) requestReload();
        return;
      }
      if (next) verifyFirstClaim(next);
    }

    if (serviceWorker && typeof serviceWorker.addEventListener === 'function') {
      serviceWorker.addEventListener('controllerchange', controllerChanged);
    }

    function setRegistration(value) {
      const seq = ++registrationSeq;
      const tracked = Promise.resolve(value).then(function (registration) {
        if (registration) registrationSucceeded = true;
        if (registration) {
          try { onRegistration(registration); } catch (e) {}
        }
        return registration;
      }, function (error) {
        if (seq === registrationSeq && !registrationSucceeded) {
          try { onRegistrationError(error); } catch (e) {}
        }
        throw error;
      });
      registrationPromise = tracked;
      // Registration failures are handled as an offline/no-SW outcome by
      // ensureCurrent(); attaching here also prevents an ignored boot promise
      // from becoming an unhandled rejection.
      tracked.catch(function () {});
      return tracked;
    }

    function register() {
      if (!registerWorker) return registrationPromise;
      // register() is idempotent for the same script and scope. Invoke it for
      // every fresh-game boundary so a rejected, hung, or later-redundant boot
      // attempt cannot become sticky. checkInFlight coalesces concurrent clicks.
      try {
        return setRegistration(registerWorker());
      } catch (e) {
        return setRegistration(Promise.reject(e));
      }
    }

    function bounded(promise, fallback, deadline) {
      const remaining = Math.max(0, deadline - now());
      return new Promise(function (resolve) {
        let done = false;
        const timer = setTimer(function () {
          if (done) return;
          done = true;
          resolve(fallback);
        }, remaining);
        Promise.resolve(promise).then(function (value) {
          if (done) return;
          done = true;
          clearTimer(timer);
          resolve(value);
        }, function () {
          if (done) return;
          done = true;
          clearTimer(timer);
          resolve(fallback);
        });
      });
    }

    function waitForCandidate(worker, deadline) {
      if (!worker || worker.state === 'activated' || worker.state === 'redundant') {
        return Promise.resolve();
      }
      return new Promise(function (resolve) {
        let done = false;
        let timer = null;
        function finish() {
          if (done) return;
          done = true;
          if (timer !== null) clearTimer(timer);
          if (typeof worker.removeEventListener === 'function') {
            worker.removeEventListener('statechange', stateChanged);
          }
          resolve();
        }
        function stateChanged() {
          if (reloadPending || worker.state === 'activated' || worker.state === 'redundant') {
            finish();
          }
        }
        if (typeof worker.addEventListener === 'function') {
          worker.addEventListener('statechange', stateChanged);
        }
        timer = setTimer(finish, Math.max(0, deadline - now()));
        stateChanged();
      });
    }

    function isCurrent() {
      if (reloadPending) return false;
      // Do not rely on controllerchange delivery winning a race with a click:
      // controller may already expose a first claimant while its event is
      // still queued.
      if (!loadedController && !pendingController && serviceWorker &&
          serviceWorker.controller) {
        verifyFirstClaim(serviceWorker.controller);
      }
      if (loadedController && serviceWorker &&
          serviceWorker.controller !== loadedController) {
        requestReload();
        return false;
      }
      if (pendingController && serviceWorker &&
          serviceWorker.controller !== pendingController) {
        requestReload();
        return false;
      }
      return true;
    }

    // Reconcile after installing the one controllerchange owner. Even a
    // controller present in the early snapshot must answer the release
    // handshake: it could have claimed after navigation began but before that
    // first inline script. The snapshot only prevents a reload loop for a
    // legacy controller that cannot answer; after one reload it is reliably
    // present in the next document's early snapshot.
    if (serviceWorker) {
      const currentController = serviceWorker.controller;
      if (currentController) {
        verifyFirstClaim(currentController, currentController === controllerSnapshot);
      }
    }

    function ensureCurrent() {
      if (!isCurrent()) return Promise.resolve(false);
      if (checkInFlight) return checkInFlight;

      // One deadline bounds the registration, update fetch AND install wait.
      // A hung captive-portal request therefore cannot strand Start/Rematch.
      // The underlying update is deliberately not cancelled: if it eventually
      // takes control, controllerchange still reloads the just-saved game.
      const deadline = now() + timeoutMs;
      const firstClaim = firstClaimPromise
        ? bounded(firstClaimPromise, false, deadline)
        : Promise.resolve(true);
      function registrationAfterClaim(current) {
        if (!current || !isCurrent()) return false;
        // A controller can claim between ensureCurrent()'s initial snapshot
        // and this microtask. Join that newly-created verification instead of
        // taking the uncontrolled-page fail-open path.
        if (firstClaimPromise) {
          return bounded(firstClaimPromise, false, deadline)
            .then(registrationAfterClaim);
        }
        const registration = register();
        // Without a registration API the network-loaded document is safe to
        // use. A failed or hung retry is likewise bounded below and fails open.
        if (!registration) return true;
        return bounded(registration, null, deadline);
      }
      function currentAfterClaim() {
        if (!isCurrent()) return false;
        if (!firstClaimPromise) return true;
        return bounded(firstClaimPromise, false, deadline).then(function (current) {
          return current ? currentAfterClaim() : false;
        });
      }
      const job = firstClaim.then(registrationAfterClaim).then(function (registration) {
        if (registration === false || registration === true) return registration;
        if (!registration || typeof registration.update !== 'function') return null;
        const update = Promise.resolve().then(function () {
          return registration.update();
        });
        return bounded(update, null, deadline).then(function (updated) {
          if (!updated) return null;
          const active = updated || registration;
          return waitForCandidate(active.installing || active.waiting, deadline);
        });
      }).then(function (result) {
        return result === false ? false : currentAfterClaim();
      });

      checkInFlight = job.then(function (current) {
        checkInFlight = null;
        return current;
      }, function () {
        // Defensive fail-open: update probing must never disable offline play.
        checkInFlight = null;
        return isCurrent();
      });
      return checkInFlight;
    }

    return {
      setRegistration: setRegistration,
      register: register,
      ensureCurrent: ensureCurrent
    };
  }

  return { create: create };
});
