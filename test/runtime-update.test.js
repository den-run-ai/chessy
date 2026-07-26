/*
 * Runtime-update gate — run with:
 *   node test/runtime-update.test.js
 */
'use strict';

const RuntimeUpdate = require('../assets/runtime-update.js');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  if (ok) {
    passed++;
    console.log('  ok  ' + label);
  } else {
    failed++;
    console.error('FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise(function (yes, no) { resolve = yes; reject = no; });
  return { promise: promise, resolve: resolve, reject: reject };
}

function eventTarget(fields) {
  const listeners = Object.create(null);
  return Object.assign({
    addEventListener: function (type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener: function (type, fn) {
      listeners[type] = (listeners[type] || []).filter(function (x) { return x !== fn; });
    },
    emit: function (type) {
      (listeners[type] || []).slice().forEach(function (fn) { fn(); });
    }
  }, fields || {});
}

function FakeMessageChannel() {
  const receiver = { onmessage: null, close: function () {} };
  this.port1 = receiver;
  this.port2 = {
    postMessage: function (data) {
      if (receiver.onmessage) receiver.onmessage({ data: data });
    }
  };
}

function claimant(id, release, silent) {
  return {
    id: id,
    postMessage: function (message, ports) {
      if (!silent && message && message.type === 'chessy-release?' && ports[0]) {
        ports[0].postMessage({ type: 'chessy-release', release: release });
      }
    }
  };
}

function setup(controller, timeoutMs, release, register, extra) {
  const sw = eventTarget({ controller: controller });
  let reloads = 0;
  const options = Object.assign({
    serviceWorker: sw,
    reload: function () { reloads++; },
    register: register,
    // Tests model a controller that owned the document at its early snapshot
    // unless they explicitly pass null to exercise an ambiguous late claim.
    loadedController: controller,
    release: release || 'r56',
    MessageChannel: FakeMessageChannel,
    timeoutMs: timeoutMs == null ? 50 : timeoutMs
  }, extra || {});
  const gate = RuntimeUpdate.create(options);
  return {
    sw: sw,
    gate: gate,
    reloads: function () { return reloads; }
  };
}

(async function () {
  // No update: the boundary remains usable and calls the platform check.
  {
    const x = setup(claimant('A', 'r56'));
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true && calls === 1 && x.reloads() === 0,
      'an unchanged controlled release passes the boundary');
  }

  // A controller already visible when the late runtime script executes is not
  // necessarily the one that loaded this page. Without an earlier snapshot it
  // must prove its release before a fresh-game boundary can proceed.
  {
    const same = claimant('same-release-late-claim', 'r56');
    const x = setup(same, 50, 'r56', null, { loadedController: null });
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true &&
        calls === 1 && x.reloads() === 0,
      'an ambiguous same-release controller is verified and accepted');
  }

  {
    const newer = claimant('newer-late-claim', 'r57');
    const x = setup(newer, 50, 'r56', null, { loadedController: null });
    x.gate.setRegistration({ update: function () { return Promise.resolve(this); } });
    check(await x.gate.ensureCurrent() === false && x.reloads() === 1,
      'an ambiguous newer controller at gate initialization reloads and fences');
  }

  // A non-null early snapshot is not proof that the controller served this
  // navigation. A release response still decides, so snapshotted B cannot
  // bless an r56 page.
  {
    const newer = claimant('snapshotted-newer-controller', 'r57');
    const x = setup(newer, 50, 'r56');
    x.gate.setRegistration({ update: function () { return Promise.resolve(this); } });
    check(await x.gate.ensureCurrent() === false && x.reloads() === 1,
      'a snapshotted newer controller still must pass the release handshake');
  }

  // A legacy controller that cannot answer is accepted only when it was also
  // present in the early snapshot. This makes the conservative reload for an
  // ambiguous first claim terminate on the next document.
  {
    const legacy = { id: 'legacy-snapshot' };
    const x = setup(legacy, 15, 'r56');
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true &&
        calls === 1 && x.reloads() === 0,
      'an unresponsive controller in the reliable snapshot avoids a reload loop');
  }

  // Replacement during that initial handshake is also a takeover, regardless
  // of what release the superseded controller eventually reports.
  {
    let responsePort = null;
    const first = {
      postMessage: function (message, ports) {
        if (message && message.type === 'chessy-release?') responsePort = ports[0];
      }
    };
    const x = setup(first, 50, 'r56', null, { loadedController: null });
    const result = x.gate.ensureCurrent();
    x.sw.controller = claimant('replacement-during-handshake', 'r57');
    x.sw.emit('controllerchange');
    responsePort.postMessage({ type: 'chessy-release', release: 'r56' });
    check(await result === false && x.reloads() === 1,
      'controller replacement during initial verification reloads once');
  }

  // Two rapid Start clicks share one network/update job. app.js independently
  // generation-fences their actions, so only the latest click may start.
  {
    const x = setup(claimant('A', 'r56'));
    const update = deferred();
    let calls = 0;
    const reg = { update: function () { calls++; return update.promise; } };
    x.gate.setRegistration(reg);
    const a = x.gate.ensureCurrent();
    const b = x.gate.ensureCurrent();
    check(a === b && calls === 0, 'concurrent boundaries coalesce before update starts');
    await new Promise(function (r) { setTimeout(r, 0); });
    check(calls === 1, 'coalesced boundaries perform one update request');
    update.resolve(reg);
    check(await a === true && await b === true, 'all coalesced callers receive the result');
  }

  // A first install claims a page that had no controller. That page's shell
  // already came from the current network deployment and must not reload.
  {
    const x = setup(null);
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    x.sw.controller = claimant('A', 'r56');
    x.sw.emit('controllerchange');
    check(await x.gate.ensureCurrent() === true && calls === 1,
      'the newly controlled current release remains usable');
    check(x.reloads() === 0, 'a verified same-release first claim does not reload');
  }

  // An uncontrolled old page can receive its first controller only after a
  // newer deployment has won installation. The first claim must be verified;
  // treating it as an ordinary first install would let stale code replace the
  // saved game.
  {
    const x = setup(null);
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    x.sw.controller = claimant('B', 'r57');
    x.sw.emit('controllerchange');
    check(await x.gate.ensureCurrent() === false &&
        x.reloads() === 1 && calls === 0,
      'a newer first claimant fences the start and reloads stale page assets');
  }

  // The controller property can become visible just before controllerchange
  // is delivered. ensureCurrent() must discover and verify that claimant too.
  {
    const x = setup(null);
    x.gate.setRegistration({ update: function () { return Promise.resolve(this); } });
    x.sw.controller = claimant('B-before-event', 'r57');
    check(await x.gate.ensureCurrent() === false && x.reloads() === 1,
      'a visible first claimant is fenced even before controllerchange dispatch');
  }

  // A first claim may also arrive just after ensureCurrent() snapshots an
  // uncontrolled page but before its promise resolves.
  {
    const x = setup(null);
    x.gate.setRegistration({ update: function () { return Promise.resolve(this); } });
    const result = x.gate.ensureCurrent();
    x.sw.controller = claimant('B-after-check', 'r57');
    x.sw.emit('controllerchange');
    check(await result === false && x.reloads() === 1,
      'an in-flight uncontrolled check joins first-claim verification');
  }

  // A claimant that cannot prove its release is bounded and handled
  // conservatively. Reloading once is safe for legacy workers: the next page
  // starts with that worker as its already-loaded controller.
  {
    const x = setup(null, 15);
    x.gate.setRegistration({ update: function () { return Promise.resolve(this); } });
    x.sw.controller = claimant('unknown', null, true);
    x.sw.emit('controllerchange');
    const t0 = Date.now();
    check(await x.gate.ensureCurrent() === false &&
        x.reloads() === 1 && Date.now() - t0 < 250,
      'an unverifiable first claim is timeout-bounded and reloads once');
  }

  // A transient boot failure must not permanently bless an uncontrolled
  // page. The next boundary retries registration, probes the returned
  // registration, and joins first-claim verification before allowing play.
  {
    let registrations = 0, updates = 0, wired = 0, errors = 0;
    let x;
    const reg = {
      update: function () {
        updates++;
        x.sw.controller = claimant('B-after-retry', 'r57');
        x.sw.emit('controllerchange');
        return Promise.resolve(reg);
      }
    };
    x = setup(null, 50, 'r56', function () {
      registrations++;
      return Promise.resolve(reg);
    }, {
      loadedController: null,
      onRegistration: function () { wired++; },
      onRegistrationError: function () { errors++; }
    });
    x.gate.setRegistration(Promise.reject(new Error('boot deploy race')));
    await new Promise(function (r) { setTimeout(r, 0); });
    check(await x.gate.ensureCurrent() === false &&
        registrations === 1 && updates === 1 && wired === 1 &&
        errors === 1 && x.reloads() === 1,
      'a retry runs success wiring before fencing its newer first claimant');
  }

  // Idempotent register() calls may return the same Registration object at
  // every boundary. Every success reaches the UI callback; that callback's
  // listener de-duplication is exercised by the real browser regression.
  {
    let registrations = 0, updates = 0, wired = 0;
    const reg = {
      update: function () {
        updates++;
        return Promise.resolve(reg);
      }
    };
    const controller = claimant('stable-controller', 'r56');
    const x = setup(controller, 50, 'r56', function () {
      registrations++;
      return Promise.resolve(reg);
    }, {
      onRegistration: function () { wired++; }
    });
    await x.gate.register();
    check(await x.gate.ensureCurrent() === true &&
        await x.gate.ensureCurrent() === true &&
        registrations === 3 && updates === 2 && wired === 3,
      'every successful registration attempt reaches the lifecycle callback');
  }

  // Registration attempts can settle out of order. An older success still
  // owns valid lifecycle wiring, and a newer offline failure must not replace
  // its Ready state with a setup-failed state.
  {
    const first = deferred();
    const second = deferred();
    let wired = 0, errors = 0;
    const reg = { update: function () { return Promise.resolve(reg); } };
    const x = setup(null, 50, 'r56', null, {
      loadedController: null,
      onRegistration: function () { wired++; },
      onRegistrationError: function () { errors++; }
    });
    x.gate.setRegistration(first.promise);
    x.gate.setRegistration(second.promise);
    first.resolve(reg);
    await new Promise(function (r) { setTimeout(r, 0); });
    second.reject(new Error('later offline attempt'));
    await new Promise(function (r) { setTimeout(r, 0); });
    check(wired === 1 && errors === 0,
      'an out-of-order success wires once and suppresses later failure UI');
  }

  // Retrying registration remains advisory when the browser is offline.
  {
    let registrations = 0;
    const x = setup(null, 50, 'r56', function () {
      registrations++;
      return Promise.reject(new Error('still offline'));
    });
    x.gate.setRegistration(Promise.reject(new Error('boot offline')));
    await new Promise(function (r) { setTimeout(r, 0); });
    check(await x.gate.ensureCurrent() === true &&
        registrations === 1 && x.reloads() === 0,
      'a rejected registration retry is bounded and fails open');
  }

  // A retry can stall after the original boot failure. Its deadline must
  // release the first Start, and a later boundary must make a NEW idempotent
  // registration attempt rather than reusing the permanently pending promise.
  {
    const hung = deferred();
    let registrations = 0, updates = 0;
    let x;
    const recovered = {
      update: function () {
        updates++;
        x.sw.controller = claimant('B-after-hung-retry', 'r57');
        x.sw.emit('controllerchange');
        return Promise.resolve(recovered);
      }
    };
    x = setup(null, 15, 'r56', function () {
      registrations++;
      return registrations === 1 ? hung.promise : Promise.resolve(recovered);
    });
    x.gate.setRegistration(Promise.reject(new Error('boot offline')));
    await new Promise(function (r) { setTimeout(r, 0); });
    const t0 = Date.now();
    check(await x.gate.ensureCurrent() === true &&
        registrations === 1 && updates === 0 && Date.now() - t0 < 250,
      'a hung registration retry is timeout-bounded and fails open');
    check(await x.gate.ensureCurrent() === false &&
        registrations === 2 && updates === 1 && x.reloads() === 1,
      'the next boundary re-registers and fences a recovered newer claimant');
    hung.resolve(recovered);
  }

  // register() resolves before installation completes. If that worker later
  // becomes redundant, the resolved registration must not be trusted forever:
  // the next boundary calls register() again and can discover the deployment.
  {
    const failedWorker = eventTarget({ state: 'installing' });
    let registrations = 0, updates = 0;
    let x;
    const failed = {
      installing: failedWorker,
      waiting: null,
      update: function () {
        updates++;
        return Promise.resolve(failed);
      }
    };
    const recovered = {
      update: function () {
        updates++;
        x.sw.controller = claimant('B-after-redundant-install', 'r57');
        x.sw.emit('controllerchange');
        return Promise.resolve(recovered);
      }
    };
    x = setup(null, 15, 'r56', function () {
      registrations++;
      return Promise.resolve(registrations === 1 ? failed : recovered);
    });
    x.gate.setRegistration(Promise.reject(new Error('boot deploy race')));
    await new Promise(function (r) { setTimeout(r, 0); });
    check(await x.gate.ensureCurrent() === true &&
        registrations === 1 && updates === 1,
      'an unresolved install is bounded and initially fails open');
    failedWorker.state = 'redundant';
    failedWorker.emit('statechange');
    check(await x.gate.ensureCurrent() === false &&
        registrations === 2 && updates === 2 && x.reloads() === 1,
      'a later boundary re-registers after the prior install becomes redundant');
  }

  // Offline update failure is explicitly fail-open.
  {
    const x = setup(claimant('A', 'r56'));
    const reg = { update: function () { return Promise.reject(new Error('offline')); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true && x.reloads() === 0,
      'an offline update rejection never blocks local play');
  }

  // A captive portal / stalled fetch cannot leave Start disabled forever.
  // The still-running platform job remains observed, and a later takeover
  // reloads even after this particular boundary timed out.
  {
    const x = setup(claimant('A', 'r56'), 15);
    const hung = deferred();
    const reg = { update: function () { return hung.promise; } };
    x.gate.setRegistration(reg);
    const t0 = Date.now();
    check(await x.gate.ensureCurrent() === true && Date.now() - t0 < 250,
      'a hung registration.update() is timeout-bounded and fails open');
    x.sw.controller = { id: 'B' };
    x.sw.emit('controllerchange');
    check(x.reloads() === 1 && await x.gate.ensureCurrent() === false,
      'a late takeover still reloads and fences later starts');
    hung.resolve(reg); // settle the observed platform promise before exit
  }

  // update() may resolve while the replacement worker is still installing.
  // The boundary waits; takeover resolves false and requests one reload.
  {
    const x = setup(claimant('A', 'r56'));
    const worker = eventTarget({ state: 'installing' });
    const reg = {
      installing: worker,
      waiting: null,
      update: function () { return Promise.resolve(reg); }
    };
    x.gate.setRegistration(reg);
    let settled = false;
    const result = x.gate.ensureCurrent().then(function (v) { settled = true; return v; });
    await new Promise(function (r) { setTimeout(r, 5); });
    check(!settled, 'a slow install holds the fresh-game boundary');
    x.sw.controller = { id: 'B' };
    x.sw.emit('controllerchange');
    worker.state = 'activated';
    worker.emit('statechange');
    check(await result === false && x.reloads() === 1,
      'replacement control cancels the stale start and reloads once');
    x.sw.emit('controllerchange');
    check(x.reloads() === 1, 'repeated controller events cannot reload twice');
  }

  console.log('runtime-update: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
