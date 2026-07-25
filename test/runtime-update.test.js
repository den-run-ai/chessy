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

function setup(controller, timeoutMs) {
  const sw = eventTarget({ controller: controller });
  let reloads = 0;
  const gate = RuntimeUpdate.create({
    serviceWorker: sw,
    reload: function () { reloads++; },
    timeoutMs: timeoutMs == null ? 50 : timeoutMs
  });
  return {
    sw: sw,
    gate: gate,
    reloads: function () { return reloads; }
  };
}

(async function () {
  // No update: the boundary remains usable and calls the platform check.
  {
    const x = setup({ id: 'A' });
    let calls = 0;
    const reg = { update: function () { calls++; return Promise.resolve(reg); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true && calls === 1 && x.reloads() === 0,
      'an unchanged controlled release passes the boundary');
  }

  // Two rapid Start clicks share one network/update job. app.js independently
  // generation-fences their actions, so only the latest click may start.
  {
    const x = setup({ id: 'A' });
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
    x.sw.controller = { id: 'A' };
    x.sw.emit('controllerchange');
    check(x.reloads() === 0, 'a first service-worker claim does not reload');
    check(await x.gate.ensureCurrent() === true && calls === 1,
      'the newly controlled current release remains usable');
  }

  // Offline update failure is explicitly fail-open.
  {
    const x = setup({ id: 'A' });
    const reg = { update: function () { return Promise.reject(new Error('offline')); } };
    x.gate.setRegistration(reg);
    check(await x.gate.ensureCurrent() === true && x.reloads() === 0,
      'an offline update rejection never blocks local play');
  }

  // A captive portal / stalled fetch cannot leave Start disabled forever.
  // The still-running platform job remains observed, and a later takeover
  // reloads even after this particular boundary timed out.
  {
    const x = setup({ id: 'A' }, 15);
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
    const x = setup({ id: 'A' });
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
