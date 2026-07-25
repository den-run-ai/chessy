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
 * worker controls a page that already had a controller, this gate reloads the
 * page and resolves the pending start as false. app.js therefore leaves the
 * existing, synchronously persisted game intact for the fresh page to restore.
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
    const reload = typeof options.reload === 'function' ? options.reload : function () {};
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const now = options.now || Date.now;
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs) : 4000;

    let loadedController = serviceWorker && serviceWorker.controller;
    let registrationPromise = null;
    let checkInFlight = null;
    let reloadPending = false;
    let reloadCalled = false;

    function requestReload() {
      reloadPending = true;
      if (reloadCalled) return;
      reloadCalled = true;
      reload();
    }

    function controllerChanged() {
      const next = serviceWorker && serviceWorker.controller;
      // A first install claims an initially uncontrolled page whose HTML and
      // scripts already came from the same current deployment. Only replacing
      // an existing controller makes the loaded runtime stale.
      if (loadedController && next !== loadedController) requestReload();
      loadedController = next;
    }

    if (serviceWorker && typeof serviceWorker.addEventListener === 'function') {
      serviceWorker.addEventListener('controllerchange', controllerChanged);
    }

    function setRegistration(value) {
      registrationPromise = Promise.resolve(value);
      // Registration failures are handled as an offline/no-SW outcome by
      // ensureCurrent(); attaching here also prevents an ignored boot promise
      // from becoming an unhandled rejection.
      registrationPromise.catch(function () {});
      return registrationPromise;
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
      if (loadedController && serviceWorker &&
          serviceWorker.controller !== loadedController) {
        requestReload();
        return false;
      }
      return true;
    }

    function ensureCurrent() {
      if (!isCurrent()) return Promise.resolve(false);
      // No controller means either unsupported SW or a first install. In both
      // cases this document was fetched directly and is safe to use.
      if (!loadedController || !registrationPromise) return Promise.resolve(true);
      if (checkInFlight) return checkInFlight;

      // One deadline bounds the registration, update fetch AND install wait.
      // A hung captive-portal request therefore cannot strand Start/Rematch.
      // The underlying update is deliberately not cancelled: if it eventually
      // takes control, controllerchange still reloads the just-saved game.
      const deadline = now() + timeoutMs;
      const job = bounded(registrationPromise, null, deadline).then(function (registration) {
        if (!registration || typeof registration.update !== 'function') return null;
        const update = Promise.resolve().then(function () {
          return registration.update();
        });
        return bounded(update, null, deadline).then(function (updated) {
          if (!updated) return null;
          const active = updated || registration;
          return waitForCandidate(active.installing || active.waiting, deadline);
        });
      }).then(function () {
        return isCurrent();
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
      ensureCurrent: ensureCurrent
    };
  }

  return { create: create };
});
